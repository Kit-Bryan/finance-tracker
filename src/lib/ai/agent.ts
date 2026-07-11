import type OpenAI from "openai";
import { getAIClient, DEFAULT_MODEL } from "./client";
import { db } from "@/db";
import { transactions, categories, accounts } from "@/db/schema";
import { eq, and, ilike, isNull, lt, gt, or, desc, gte, lte, inArray } from "drizzle-orm";
import { learnMerchant, pruneOrphanMerchants } from "@/lib/categorizer/rules";
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
  type: "bulk_update_category" | "edit_transaction" | "split_transaction" | "link_reimbursements";
  // bulk_update_category
  transactionIds?: number[];
  categoryName?: string;
  categoryId?: number;
  preview?: { id: number; description: string; amount: string }[];
  // edit_transaction
  transactionId?: number;
  changes?: { field: string; oldValue: unknown; newValue: unknown }[];
  description?: string;
  // split_transaction
  originalAmount?: number;
  originalDescription?: string;
  originalDate?: string;
  splits?: { amount: number; description: string; notes?: string; categoryName?: string | null; categoryId?: number | null }[];
  // link_reimbursements
  expenseId?: number;
  expenseDescription?: string;
  expenseAmount?: number;
  expenseDate?: string;
  expenseCategoryName?: string | null;
  reimbursementTransactions?: { id: number; description: string; amount: number; date: string }[];
  totalReimbursed?: number;
  yourShare?: number;
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
      name: "edit_transaction",
      description: "Edit fields of a specific transaction. Always show the user what will change before applying — this tool returns a pending confirmation.",
      parameters: {
        type: "object",
        properties: {
          transactionId: { type: "number", description: "The transaction ID to edit" },
          date: { type: "string", description: "New date in YYYY-MM-DD format" },
          description: { type: "string", description: "New merchant/description name" },
          notes: { type: "string", description: "New notes text" },
          amount: { type: "number", description: "New amount (negative=expense, positive=income)" },
          categoryName: { type: "string", description: "New category name" },
        },
        required: ["transactionId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "split_transaction",
      description: "Split one transaction into multiple. The original is soft-deleted and replaced by the splits. Always clarify amounts first, then show a preview for confirmation.",
      parameters: {
        type: "object",
        properties: {
          transactionId: { type: "number", description: "The transaction ID to split" },
          splits: {
            type: "array",
            description: "The resulting transactions after the split. Amounts must sum to the original.",
            items: {
              type: "object",
              properties: {
                amount: { type: "number" },
                description: { type: "string" },
                notes: { type: "string" },
                categoryName: { type: "string" },
              },
              required: ["amount", "description"],
            },
          },
        },
        required: ["transactionId", "splits"],
      },
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
      name: "suggest_reimbursements",
      description: "Scan recent transactions to find incoming transfers that look like reimbursements for group expenses (e.g. paid for a group dinner and friends paid you back). Returns proposed matches — present them to the user, then call link_reimbursements to confirm.",
      parameters: {
        type: "object",
        properties: {
          lookbackDays: { type: "number", description: "How many days back to scan, default 30" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "link_reimbursements",
      description: "Link a set of incoming transfers as reimbursements for a specific expense. Always call suggest_reimbursements first or get IDs from the user. Returns a confirmation card before applying.",
      parameters: {
        type: "object",
        properties: {
          expenseId: { type: "number", description: "The original group expense transaction ID" },
          reimbursementIds: { type: "array", items: { type: "number" }, description: "IDs of the incoming transfers to link as reimbursements" },
        },
        required: ["expenseId", "reimbursementIds"],
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
  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));
  // Exclude soft-deleted (trashed) transactions — never present them as live.
  const conditions = [isNull(transactions.deletedAt)];

  if (args.uncategorized) conditions.push(isNull(transactions.categoryId));
  if (args.from) conditions.push(gte(transactions.postedAt, new Date(args.from)));
  if (args.to) conditions.push(lte(transactions.postedAt, new Date(args.to)));

  if (args.categoryName) {
    const cat = allCategories.find((c) => c.name.toLowerCase() === args.categoryName!.toLowerCase());
    if (cat) conditions.push(eq(transactions.categoryId, cat.id));
  }

  // Filter the keyword in SQL BEFORE the limit, so matches aren't missed beyond the most-recent N.
  if (args.query) {
    const pattern = `%${args.query}%`;
    conditions.push(or(ilike(transactions.description, pattern), ilike(transactions.merchantNormalized, pattern))!);
  }

  const rows = await db
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
    .where(and(...conditions))
    .orderBy(desc(transactions.postedAt))
    .limit(args.limit ?? 20);

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
  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));
  const cat = allCategories.find((c) => c.name.toLowerCase() === args.categoryName.toLowerCase());
  if (!cat) return { error: `Category "${args.categoryName}" not found` };

  // Return preview — actual execution happens after user confirms
  const rows = await db
    .select({ id: transactions.id, description: transactions.description, merchantNormalized: transactions.merchantNormalized, amount: transactions.amount })
    .from(transactions)
    .where(inArray(transactions.id, args.transactionIds));

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

  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));
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
  const cats = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId, color: categories.color }).from(categories).where(isNull(categories.deletedAt));
  return cats;
}

async function execEditTransaction(args: {
  transactionId: number; date?: string; description?: string;
  notes?: string; amount?: number; categoryName?: string;
}) {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, args.transactionId));
  if (!tx) return { error: `Transaction ${args.transactionId} not found.` };

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const cat = args.categoryName
    ? allCats.find((c) => c.name.toLowerCase() === args.categoryName!.toLowerCase())
    : null;

  const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
  if (args.date) changes.push({ field: "date", oldValue: new Date(tx.postedAt).toISOString().slice(0, 10), newValue: args.date });
  if (args.description) changes.push({ field: "description", oldValue: tx.merchantNormalized || tx.description, newValue: args.description });
  if (args.notes !== undefined) changes.push({ field: "notes", oldValue: tx.notes, newValue: args.notes });
  if (args.amount !== undefined) changes.push({ field: "amount", oldValue: parseFloat(tx.amount as string), newValue: args.amount });
  if (cat) changes.push({ field: "category", oldValue: allCats.find((c) => c.id === tx.categoryId)?.name ?? null, newValue: cat.name });

  if (changes.length === 0) return { error: "No valid changes specified." };

  return {
    __pending_confirmation: true,
    type: "edit_transaction",
    transactionId: args.transactionId,
    changes,
    categoryId: cat?.id ?? null,
    description: `${tx.merchantNormalized || tx.description} — ${new Date(tx.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short" })}`,
  };
}

async function execSplitTransaction(args: {
  transactionId: number;
  splits: { amount: number; description: string; notes?: string; categoryName?: string }[];
}) {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, args.transactionId));
  if (!tx) return { error: `Transaction ${args.transactionId} not found.` };

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const originalAmount = parseFloat(tx.amount as string);
  const splitTotal = args.splits.reduce((s, r) => s + r.amount, 0);

  // Validate total (allow small rounding error)
  if (Math.abs(Math.abs(splitTotal) - Math.abs(originalAmount)) > 0.02) {
    return {
      error: `Split amounts (${splitTotal.toFixed(2)}) don't match original (${originalAmount.toFixed(2)}). Please adjust.`,
    };
  }

  const enrichedSplits = args.splits.map((s) => {
    const cat = s.categoryName
      ? allCats.find((c) => c.name.toLowerCase() === s.categoryName!.toLowerCase())
      : allCats.find((c) => c.id === tx.categoryId);
    return { ...s, categoryId: cat?.id ?? null, categoryName: cat?.name ?? s.categoryName ?? null };
  });

  return {
    __pending_confirmation: true,
    type: "split_transaction",
    transactionId: args.transactionId,
    originalAmount,
    originalDescription: tx.merchantNormalized || tx.description,
    originalDate: new Date(tx.postedAt).toISOString().slice(0, 10),
    splits: enrichedSplits,
  };
}

async function execUpdateCategory(args: { name: string; newName?: string; color?: string }) {
  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
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
  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));

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

async function execSuggestReimbursements(args: { lookbackDays?: number }) {
  const lookback = args.lookbackDays ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - lookback);

  // All non-deleted, non-already-linked transactions in the window
  const allTx = await db
    .select({
      id: transactions.id,
      postedAt: transactions.postedAt,
      description: transactions.description,
      merchantNormalized: transactions.merchantNormalized,
      amount: transactions.amount,
      categoryId: transactions.categoryId,
      reimbursementForId: transactions.reimbursementForId,
    })
    .from(transactions)
    .where(and(gte(transactions.postedAt, since), isNull(transactions.deletedAt), isNull(transactions.reimbursementForId)))
    .orderBy(desc(transactions.postedAt));

  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));

  // Outgoing expenses above MYR 30
  const expenses = allTx.filter((t) => parseFloat(t.amount as string) < -30);

  // Incoming person-to-person transfers
  const incoming = allTx.filter((t) => {
    if (parseFloat(t.amount as string) <= 0) return false;
    const desc = ((t.description ?? "") + " " + (t.merchantNormalized ?? "")).toLowerCase();
    return (
      desc.includes("fund tr") || desc.includes("duitnow") || desc.includes("ibk") ||
      desc.includes(" trf ") || desc.includes("transfer") || desc.includes("fpx") ||
      desc.includes("a/c") || desc.includes("interbank") || desc.includes("pymt from") ||
      desc.includes("payment from") || desc.includes("received from")
    );
  });

  const proposals: object[] = [];

  for (const expense of expenses) {
    const expDate = new Date(expense.postedAt);
    const windowEnd = new Date(expDate);
    windowEnd.setDate(windowEnd.getDate() + 7);

    const candidates = incoming.filter((t) => {
      const tDate = new Date(t.postedAt);
      return tDate >= expDate && tDate <= windowEnd;
    });

    if (candidates.length === 0) continue;

    const totalReimbursed = candidates.reduce((s, t) => s + parseFloat(t.amount as string), 0);
    const expenseAbs = Math.abs(parseFloat(expense.amount as string));

    if (totalReimbursed < expenseAbs * 0.3) continue;

    const cat = allCategories.find((c) => c.id === expense.categoryId);
    proposals.push({
      expense: {
        id: expense.id,
        date: new Date(expense.postedAt).toISOString().slice(0, 10),
        description: expense.merchantNormalized || expense.description,
        amount: parseFloat(expense.amount as string),
        categoryName: cat?.name ?? null,
      },
      reimbursements: candidates.map((t) => ({
        id: t.id,
        date: new Date(t.postedAt).toISOString().slice(0, 10),
        description: t.merchantNormalized || t.description,
        amount: parseFloat(t.amount as string),
      })),
      totalReimbursed,
      yourShare: parseFloat(expense.amount as string) + totalReimbursed,
    });
  }

  if (proposals.length === 0) {
    return { message: `No reimbursement patterns found in the last ${lookback} days. Try a longer window or check manually.` };
  }
  return proposals;
}

async function execLinkReimbursements(args: { expenseId: number; reimbursementIds: number[] }) {
  const [expense] = await db.select().from(transactions).where(eq(transactions.id, args.expenseId));
  if (!expense) return { error: `Expense transaction ${args.expenseId} not found.` };

  const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
  const cat = allCats.find((c) => c.id === expense.categoryId);

  const reimbs = await db
    .select()
    .from(transactions)
    .where(inArray(transactions.id, args.reimbursementIds));

  const totalReimbursed = reimbs.reduce((s, t) => s + parseFloat(t.amount as string), 0);
  const yourShare = parseFloat(expense.amount as string) + totalReimbursed;

  return {
    __pending_confirmation: true,
    type: "link_reimbursements",
    expenseId: expense.id,
    expenseDescription: expense.merchantNormalized || expense.description,
    expenseAmount: parseFloat(expense.amount as string),
    expenseDate: new Date(expense.postedAt).toISOString().slice(0, 10),
    expenseCategoryName: cat?.name ?? null,
    reimbursementTransactions: reimbs.map((t) => ({
      id: t.id,
      description: t.merchantNormalized || t.description,
      amount: parseFloat(t.amount as string),
      date: new Date(t.postedAt).toISOString().slice(0, 10),
    })),
    totalReimbursed,
    yourShare,
  };
}

// ── Main agent loop ───────────────────────────────────────────────────────────

export interface ContextTransaction {
  id: number;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  postedAt: string;
  categoryName: string | null;
  notes: string | null;
}

export async function runAgentTurn(
  history: AgentMessage[],
  userMessage: string,
  contextTransaction?: ContextTransaction | null
): Promise<AgentResponse> {
  const ai = getAIClient();
  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));
  const allAccounts = await db.select().from(accounts);

  const txContext = contextTransaction
    ? `\nFOCUSED TRANSACTION (the user is asking about this specific transaction):
  ID: ${contextTransaction.id}
  Merchant: ${contextTransaction.merchantNormalized || contextTransaction.description}
  Raw description: ${contextTransaction.description}
  Amount: MYR ${parseFloat(contextTransaction.amount as string).toFixed(2)}
  Date: ${new Date(contextTransaction.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
  Category: ${contextTransaction.categoryName ?? "Uncategorized"}
  Notes: ${contextTransaction.notes ?? "none"}

  When the user refers to "this transaction" or "it", they mean transaction ID ${contextTransaction.id}. Use edit_transaction or split_transaction tools directly with this ID.\n`
    : "";

  const systemPrompt = `You are a personal finance assistant for a Malaysian user. You help manage, categorize, and understand bank transactions.
${txContext}
Available categories: ${allCategories.map((c) => c.name).join(", ")}
Accounts: ${allAccounts.map((a) => `${a.name} (${a.bank})`).join(", ")}
Currency: MYR

Guidelines:
- Always search before updating. Never guess transaction IDs.
- For bulk_update_category, the result requires user confirmation — tell the user what you're proposing and that it will be applied after they confirm.
- You CAN create new categories using create_category — top-level or under a parent. Do this proactively when a user asks for a category that doesn't exist.
- You CAN update existing categories (rename or recolor) using update_category. Before picking a color, ALWAYS call get_categories first to see what colors are already in use, then choose a hex color that is visually distinct from all existing ones.
- You CAN edit a transaction's date, description, notes, amount, or category using edit_transaction. This returns a confirmation — never apply without user seeing the preview.
- You CAN split a transaction into multiple using split_transaction. Amounts must sum to the original. If the user gives fractions, calculate exact amounts first and confirm. The original is soft-deleted and the splits are created as new transactions. Ask clarifying questions if the split intent is ambiguous.
- Be concise. Use bullet points for lists of transactions.
- If a transaction is ambiguous, ask clarifying questions rather than guessing.
- When explaining a transaction, consider the Malaysian context (GrabPay, Touch n Go, Maybank, etc.)
- Amounts are in MYR. Negative = expense, positive = income.
- You CAN find group-expense reimbursements using suggest_reimbursements. Use it when the user mentions paying for friends, group dinners, or wanting to see their real share. Then call link_reimbursements so the dashboard shows the netted amount instead of the full group cost.`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
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
      const fn = (call as { function: { name: string; arguments: string } }).function;
      const name: string = fn.name;
      const args = JSON.parse(fn.arguments);
      let result: unknown;

      if (name === "search_transactions") result = await execSearchTransactions(args);
      else if (name === "bulk_update_category") result = await execBulkUpdateCategory(args);
      else if (name === "explain_transaction") result = await execExplainTransaction(args);
      else if (name === "get_review_queue") result = await execGetReviewQueue();
      else if (name === "get_categories") result = await execGetCategories();
      else if (name === "edit_transaction") result = await execEditTransaction(args);
      else if (name === "split_transaction") result = await execSplitTransaction(args);
      else if (name === "update_category") result = await execUpdateCategory(args);
      else if (name === "create_category") result = await execCreateCategory(args);
      else if (name === "suggest_reimbursements") result = await execSuggestReimbursements(args);
      else if (name === "link_reimbursements") result = await execLinkReimbursements(args);
      else result = { error: "Unknown tool" };

      // Extract pending confirmation if present
      if (
        typeof result === "object" &&
        result !== null &&
        "__pending_confirmation" in result
      ) {
        const r = result as unknown as PendingAction;
        pendingConfirmation = {
          type: r.type,
          // bulk_update_category
          transactionIds: r.transactionIds,
          categoryName: r.categoryName,
          categoryId: r.categoryId,
          preview: r.preview,
          // edit_transaction
          transactionId: r.transactionId,
          changes: r.changes,
          description: r.description,
          // split_transaction
          originalAmount: r.originalAmount,
          originalDescription: r.originalDescription,
          originalDate: r.originalDate,
          splits: r.splits,
          // link_reimbursements
          expenseId: r.expenseId,
          expenseDescription: r.expenseDescription,
          expenseAmount: r.expenseAmount,
          expenseDate: r.expenseDate,
          expenseCategoryName: r.expenseCategoryName,
          reimbursementTransactions: r.reimbursementTransactions,
          totalReimbursed: r.totalReimbursed,
          yourShare: r.yourShare,
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

export async function confirmPendingAction(action: PendingAction): Promise<{ updated: number; message?: string }> {
  // ── bulk_update_category ──────────────────────────────────────────────────
  if (action.type === "bulk_update_category") {
    let updated = 0;
    for (const id of action.transactionIds!) {
      const [tx] = await db.select().from(transactions).where(eq(transactions.id, id));
      if (!tx) continue;
      await db.update(transactions).set({ categoryId: action.categoryId!, categorySource: "user", categoryConfidence: "1", updatedAt: new Date() }).where(eq(transactions.id, id));
      await learnMerchant(tx.description, action.categoryId!, "user");
      updated++;
    }
    return { updated };
  }

  // ── edit_transaction ──────────────────────────────────────────────────────
  if (action.type === "edit_transaction") {
    const txId = action.transactionId!;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    for (const change of action.changes ?? []) {
      if (change.field === "date") updates.postedAt = new Date(change.newValue as string);
      if (change.field === "description") { updates.merchantNormalized = change.newValue; }
      if (change.field === "notes") updates.notes = change.newValue;
      if (change.field === "amount") updates.amount = String(change.newValue);
      if (change.field === "category") { updates.categoryId = action.changes?.find(c => c.field === "category") ? action.categoryId : undefined; updates.categorySource = "user"; }
    }
    // find categoryId from changes if category was updated
    const catChange = action.changes?.find(c => c.field === "category");
    if (catChange) {
      const allCats = await db.select().from(categories).where(isNull(categories.deletedAt));
      const cat = allCats.find(c => c.name === catChange.newValue);
      if (cat) { updates.categoryId = cat.id; updates.categorySource = "user"; updates.categoryConfidence = "1"; }
    }
    await db.update(transactions).set(updates as Partial<typeof transactions.$inferInsert>).where(eq(transactions.id, txId));
    return { updated: 1 };
  }

  // ── split_transaction ─────────────────────────────────────────────────────
  if (action.type === "split_transaction") {
    const [original] = await db.select().from(transactions).where(eq(transactions.id, action.transactionId!));
    if (!original) return { updated: 0 };

    const originalAmount = parseFloat(original.amount as string);
    const splitTotal = (action.splits ?? []).reduce((s, r) => s + r.amount, 0);
    if (Math.abs(Math.abs(splitTotal) - Math.abs(originalAmount)) > 0.02) {
      return { updated: 0, message: `Split amounts (${splitTotal.toFixed(2)}) don't match original (${originalAmount.toFixed(2)}). Please try again.` };
    }

    // Soft-delete the original
    await db.update(transactions).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(transactions.id, action.transactionId!));

    // Insert the splits
    const crypto = await import("crypto");
    let inserted = 0;
    for (const split of action.splits ?? []) {
      const fingerprint = crypto.createHash("sha256")
        .update(`split:${original.fingerprint}:${split.amount}:${split.description}:${Date.now()}:${inserted}`)
        .digest("hex").slice(0, 64);

      await db.insert(transactions).values({
        accountId: original.accountId,
        batchId: original.batchId,
        categoryId: split.categoryId ?? original.categoryId,
        postedAt: original.postedAt,
        amount: String(split.amount),
        currency: original.currency,
        description: split.description,
        merchantNormalized: split.description,
        notes: split.notes ?? null,
        fingerprint,
        categorySource: split.categoryId ? "user" : original.categorySource,
        categoryConfidence: "1",
      });
      inserted++;
    }

    // Forget the original's merchant memory if no live transaction still backs it
    await pruneOrphanMerchants([original.description]);

    return { updated: inserted, message: `Split into ${inserted} transactions` };
  }

  // ── link_reimbursements ───────────────────────────────────────────────────
  if (action.type === "link_reimbursements") {
    const reimbs = action.reimbursementTransactions ?? [];
    for (const r of reimbs) {
      await db
        .update(transactions)
        .set({ reimbursementForId: action.expenseId!, updatedAt: new Date() })
        .where(eq(transactions.id, r.id));
    }
    const share = Math.abs(action.yourShare ?? 0).toFixed(2);
    return {
      updated: reimbs.length,
      message: `Linked ${reimbs.length} reimbursement${reimbs.length !== 1 ? "s" : ""} to **${action.expenseDescription}**. Your share: **MYR ${share}**. The dashboard will now show your net expense.`,
    };
  }

  return { updated: 0 };
}
