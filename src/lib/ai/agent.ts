import { getAIClient, DEFAULT_MODEL } from "./client";
import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { eq, and, ilike, isNull, lt, or, desc, gte, lte } from "drizzle-orm";
import { learnMerchant } from "@/lib/categorizer/rules";
import { CONFIDENCE_THRESHOLD } from "@/lib/ai/constants";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolResult {
  toolName: string;
  result: unknown;
}

export interface AgentResponse {
  message: string;
  toolResults: ToolResult[];
  pendingConfirmation?: PendingAction;
}

export interface PendingAction {
  type: "bulk_update_category";
  transactionIds: number[];
  categoryName: string;
  categoryId: number;
  preview: { id: number; description: string; amount: string }[];
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "search_transactions",
      description: "Search transactions by keyword, category, or date range. Use to find specific transactions before explaining or updating them.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword to search in description or merchant name" },
          categoryName: { type: "string", description: "Filter by category name" },
          uncategorized: { type: "boolean", description: "If true, return only uncategorized transactions" },
          from: { type: "string", description: "Start date YYYY-MM-DD" },
          to: { type: "string", description: "End date YYYY-MM-DD" },
          limit: { type: "number", description: "Max results, default 20" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bulk_update_category",
      description: "Update the category for a list of transaction IDs. Always call search_transactions first to find the IDs. This requires user confirmation before executing.",
      parameters: {
        type: "object",
        properties: {
          transactionIds: { type: "array", items: { type: "number" }, description: "List of transaction IDs to update" },
          categoryName: { type: "string", description: "Exact category name to assign" },
        },
        required: ["transactionIds", "categoryName"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "explain_transaction",
      description: "Research and explain what a specific transaction likely is, based on its description and amount.",
      parameters: {
        type: "object",
        properties: {
          transactionId: { type: "number", description: "The transaction ID to explain" },
        },
        required: ["transactionId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_review_queue",
      description: "Get transactions that need review — uncategorized or low-confidence AI guesses.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_categories",
      description: "List all available categories.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_category",
      description: "Update an existing category's name or color.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Current name of the category to update" },
          newName: { type: "string", description: "New name (omit to keep current)" },
          color: { type: "string", description: "New hex color e.g. #f97316 (omit to keep current)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_category",
      description: "Create a new category. Can be top-level or a subcategory under an existing parent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The category name, e.g. 'Personal Care'" },
          parentName: { type: "string", description: "Name of the parent category if this is a subcategory. Omit for top-level." },
        },
        required: ["name"],
      },
    },
  },
];

// ── Tool executors ────────────────────────────────────────────────────────────

async function execSearchTransactions(args: {
  query?: string; categoryName?: string; uncategorized?: boolean;
  from?: string; to?: string; limit?: number;
}) {
  const allCategories = await db.select().from(categories);
  const conditions = [];

  if (args.uncategorized) conditions.push(isNull(transactions.categoryId));
  if (args.from) conditions.push(gte(transactions.postedAt, new Date(args.from)));
  if (args.to) conditions.push(lte(transactions.postedAt, new Date(args.to)));

  if (args.categoryName) {
    const cat = allCategories.find((c) => c.name.toLowerCase() === args.categoryName!.toLowerCase());
    if (cat) conditions.push(eq(transactions.categoryId, cat.id));
  }

  let rows = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
      categoryConfidence: transactions.categoryConfidence,
    })
    .from(transactions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactions.postedAt))
    .limit(args.limit ?? 20);

  if (args.query) {
    const q = args.query.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.description.toLowerCase().includes(q) ||
        (r.merchantNormalized ?? "").toLowerCase().includes(q)
    );
  }

  return rows.map((r) => ({
    id: r.id,
    date: new Date(r.postedAt).toISOString().slice(0, 10),
    merchant: r.merchantNormalized || r.description,
    description: r.description,
    amount: parseFloat(r.amount as string),
    categoryId: r.categoryId,
    categoryName: allCategories.find((c) => c.id === r.categoryId)?.name ?? null,
    confidence: r.categoryConfidence ? parseFloat(r.categoryConfidence as string) : null,
    source: r.categorySource,
  }));
}

async function execBulkUpdateCategory(args: { transactionIds: number[]; categoryName: string }) {
  const allCategories = await db.select().from(categories);
  const cat = allCategories.find((c) => c.name.toLowerCase() === args.categoryName.toLowerCase());
  if (!cat) return { error: `Category "${args.categoryName}" not found` };

  // Return preview — actual execution happens after user confirms
  const rows = await db
    .select({ id: transactions.id, description: transactions.description, merchantNormalized: transactions.merchantNormalized, amount: transactions.amount })
    .from(transactions)
    .where(
      args.transactionIds.length === 1
        ? eq(transactions.id, args.transactionIds[0])
        : and(...args.transactionIds.map((id) => eq(transactions.id, id)))
    );

  return {
    __pending_confirmation: true,
    type: "bulk_update_category",
    transactionIds: args.transactionIds,
    categoryName: cat.name,
    categoryId: cat.id,
    preview: rows.map((r) => ({
      id: r.id,
      description: r.merchantNormalized || r.description,
      amount: r.amount,
    })),
    count: rows.length,
  };
}

async function execExplainTransaction(args: { transactionId: number }) {
  const [tx] = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      postedAt: transactions.postedAt,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(eq(transactions.id, args.transactionId));

  if (!tx) return { error: "Transaction not found" };

  const allCategories = await db.select().from(categories);
  const cat = allCategories.find((c) => c.id === tx.categoryId);

  return {
    id: tx.id,
    date: new Date(tx.postedAt).toISOString().slice(0, 10),
    rawDescription: tx.description,
    merchantNormalized: tx.merchantNormalized,
    amount: parseFloat(tx.amount as string),
    currentCategory: cat?.name ?? "Uncategorized",
  };
}

async function execGetReviewQueue() {
  const flagged = await db
    .select({
      id: transactions.id,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      postedAt: transactions.postedAt,
      categoryConfidence: transactions.categoryConfidence,
      categorySource: transactions.categorySource,
    })
    .from(transactions)
    .where(
      or(
        isNull(transactions.categoryId),
        and(
          eq(transactions.categorySource, "agent"),
          lt(transactions.categoryConfidence, String(CONFIDENCE_THRESHOLD))
        )
      )
    )
    .limit(20);

  return flagged.map((r) => ({
    id: r.id,
    date: new Date(r.postedAt).toISOString().slice(0, 10),
    merchant: r.merchantNormalized || r.description,
    amount: parseFloat(r.amount as string),
    confidence: r.categoryConfidence ? parseFloat(r.categoryConfidence as string) : null,
  }));
}

async function execGetCategories() {
  const cats = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId, color: categories.color }).from(categories);
  return cats;
}

async function execUpdateCategory(args: { name: string; newName?: string; color?: string }) {
  const allCats = await db.select().from(categories);
  const cat = allCats.find((c) => c.name.toLowerCase() === args.name.toLowerCase());
  if (!cat) return { error: `Category "${args.name}" not found.` };

  const updates: Record<string, unknown> = {};
  if (args.newName) updates.name = args.newName.trim();

  if (args.color) {
    updates.color = args.color;
  } else if (!cat.color) {
    // No color provided and none exists — auto-pick from palette avoiding existing colors
    const usedColors = new Set(allCats.map((c) => c.color).filter(Boolean));
    updates.color = CATEGORY_COLORS.find((c) => !usedColors.has(c)) ?? CATEGORY_COLORS[0];
  }

  if (Object.keys(updates).length === 0) return { error: "Nothing to update — provide newName or color." };

  const finalColor = (updates.color as string) ?? cat.color;

  // Propagate color to all children
  if (updates.color) {
    const children = allCats.filter((c) => c.parentId === cat.id);
    for (const child of children) {
      await db.update(categories).set({ color: finalColor }).where(eq(categories.id, child.id));
    }
  }

  const [updated] = await db
    .update(categories)
    .set(updates)
    .where(eq(categories.id, cat.id))
    .returning();

  return { id: updated.id, name: updated.name, color: updated.color, updated: true };
}

const CATEGORY_COLORS = [
  "#f97316", "#3b82f6", "#8b5cf6", "#ec4899", "#eab308",
  "#14b8a6", "#06b6d4", "#6366f1", "#64748b", "#22c55e",
  "#e11d48", "#0ea5e9", "#a855f7", "#f59e0b", "#10b981",
];

async function execCreateCategory(args: { name: string; parentName?: string }) {
  const allCats = await db.select().from(categories);

  const existing = allCats.find((c) => c.name.toLowerCase() === args.name.toLowerCase());
  if (existing) return { id: existing.id, name: existing.name, alreadyExisted: true };

  let parentId: number | null = null;
  let color: string | null = null;

  if (args.parentName) {
    const parent = allCats.find((c) => c.name.toLowerCase() === args.parentName!.toLowerCase());
    if (!parent) return { error: `Parent category "${args.parentName}" not found. Use get_categories to list available ones.` };
    parentId = parent.id;
    color = parent.color;  // inherit parent color
  } else {
    // Auto-assign an unused color
    const usedColors = new Set(allCats.map((c) => c.color).filter(Boolean));
    color = CATEGORY_COLORS.find((c) => !usedColors.has(c)) ?? CATEGORY_COLORS[0];
  }

  const [created] = await db
    .insert(categories)
    .values({ name: args.name.trim(), parentId, color })
    .returning();

  return { id: created.id, name: created.name, parentId: created.parentId, color: created.color, created: true };
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export async function runAgentTurn(
  history: AgentMessage[],
  userMessage: string
): Promise<AgentResponse> {
  const ai = getAIClient();
  const allCategories = await db.select().from(categories);
  const allAccounts = await db.select().from(accounts);

  const systemPrompt = `You are a personal finance assistant for a Malaysian user. You help manage, categorize, and understand bank transactions.

Available categories: ${allCategories.map((c) => c.name).join(", ")}
Accounts: ${allAccounts.map((a) => `${a.name} (${a.bank})`).join(", ")}
Currency: MYR

Guidelines:
- Always search before updating. Never guess transaction IDs.
- For bulk_update_category, the result requires user confirmation — tell the user what you're proposing and that it will be applied after they confirm.
- You CAN create new categories using create_category — top-level or under a parent. Do this proactively when a user asks for a category that doesn't exist.
- You CAN update existing categories (rename or recolor) using update_category. Before picking a color, ALWAYS call get_categories first to see what colors are already in use, then choose a hex color that is visually distinct from all existing ones.
- Be concise. Use bullet points for lists of transactions.
- If a transaction is ambiguous, ask clarifying questions rather than guessing.
- When explaining a transaction, consider the Malaysian context (GrabPay, Touch n Go, Maybank, etc.)
- Amounts are in MYR. Negative = expense, positive = income.`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const toolResults: ToolResult[] = [];
  let pendingConfirmation: PendingAction | undefined;
  const MAX_ITERATIONS = 5;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await ai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
      temperature: 0.3,
    });

    const msg = resp.choices[0]?.message;
    if (!msg) break;

    messages.push(msg);

    // No tool calls — we have a final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        message: msg.content ?? "",
        toolResults,
        pendingConfirmation,
      };
    }

    // Execute each tool call
    for (const call of msg.tool_calls) {
      const fn = (call as any).function;
      const name: string = fn.name;
      const args = JSON.parse(fn.arguments);
      let result: unknown;

      if (name === "search_transactions") result = await execSearchTransactions(args);
      else if (name === "bulk_update_category") result = await execBulkUpdateCategory(args);
      else if (name === "explain_transaction") result = await execExplainTransaction(args);
      else if (name === "get_review_queue") result = await execGetReviewQueue();
      else if (name === "get_categories") result = await execGetCategories();
      else if (name === "update_category") result = await execUpdateCategory(args);
      else if (name === "create_category") result = await execCreateCategory(args);
      else result = { error: "Unknown tool" };

      // Extract pending confirmation if present
      if (
        typeof result === "object" &&
        result !== null &&
        "__pending_confirmation" in result
      ) {
        const r = result as any;
        pendingConfirmation = {
          type: r.type,
          transactionIds: r.transactionIds,
          categoryName: r.categoryName,
          categoryId: r.categoryId,
          preview: r.preview,
        };
      }

      toolResults.push({ toolName: name, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    message: "I've completed the requested actions.",
    toolResults,
    pendingConfirmation,
  };
}

// ── Confirm pending action ────────────────────────────────────────────────────

export async function confirmPendingAction(action: PendingAction): Promise<{ updated: number }> {
  if (action.type !== "bulk_update_category") return { updated: 0 };

  let updated = 0;
  for (const id of action.transactionIds) {
    const [tx] = await db.select().from(transactions).where(eq(transactions.id, id));
    if (!tx) continue;

    await db
      .update(transactions)
      .set({
        categoryId: action.categoryId,
        categorySource: "user",
        categoryConfidence: "1",
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, id));

    await learnMerchant(tx.description, action.categoryId, "user");
    updated++;
  }

  return { updated };
}
