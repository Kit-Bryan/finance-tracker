import { getAIClient, DEFAULT_MODEL } from "./client";
import { getConfirmedExamples, CategoryExample } from "./examples";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "ai/categorize" });

export interface CategorizationInput {
  id: number;
  description: string;
  amount: number;
}

export interface CategorizationOutput {
  id: number;
  merchantName: string;   // clean, normalized e.g. "GrabPay", "McDonald's", "Grab"
  categoryName: string;   // must match one of the provided category names exactly
  confidence: number;     // 0–1
  note: string;           // 1-sentence human-readable explanation
}

export async function bulkCategorize(
  transactions: CategorizationInput[],
  categoryNames: string[]
): Promise<CategorizationOutput[]> {
  if (transactions.length === 0) return [];

  const ai = getAIClient();
  const examples = await getConfirmedExamples(40);

  const examplesBlock = examples.length > 0
    ? `\nUser's confirmed categorizations (use these for consistency):\n${examples.map((e) => `  "${e.merchant}" → ${e.categoryName}`).join("\n")}\n`
    : "";

  const userName = process.env.USER_NAME?.trim();
  const userBlock = userName
    ? `\nThe account holder is "${userName}". When a transaction's counterparty is this person (allowing for abbreviated or reordered names), it is the user moving money between their OWN accounts/wallets — categorize as "Transfer" (neither income nor spending). A transfer to or from a DIFFERENT person's name may be a real income or expense — judge by context, do NOT assume it's a transfer.\n`
    : "";

  const prompt = `You are categorizing Malaysian bank transactions. For each transaction, identify the real merchant name and pick the best category.

Available categories (use EXACTLY one of these names):
${categoryNames.join(", ")}
${examplesBlock}${userBlock}
Transactions (JSON array):
${JSON.stringify(transactions, null, 2)}

Rules:
- merchantName: clean, human-readable name. Examples:
  "PYMT FROM A/C – GRABPAY MALAYSIA – xyz" → "GrabPay"
  "IBK FUND TFR FR A/C – BRYAN WONG WIN KIT" → "Fund Transfer"
  "OPENAI *CHATGPT SUB – SAN FRANCISCO" → "OpenAI"
  "SHOPEE PAYMENT" → "Shopee"
  "GRAB*FOOD" → "GrabFood"
  "TNB ELECTRICITY" → "TNB"
- If a merchant appears in the confirmed examples above, use the SAME category — do not override the user's past decisions.
- categoryName: pick the single best match from the provided list. Use "Uncategorized" only if truly ambiguous.
- confidence: 0.0–1.0 (set to 0.95+ when matched from confirmed examples)
- If amount > 0 (credit/income), prefer income-related categories
- For transfers between own accounts, use "Transfer"
- TOUCH 'N GO GO+ INTERNAL MOVEMENTS are NOT income or spending — categorize as "Transfer". This includes "Quick Reload Payment (via GO+ Balance)" and any internal GO+ routing/processing leg that only exists to fund another payment (it usually appears as a credit immediately matched by a same-amount merchant debit).
- REAL TRANSFERS BETWEEN THE USER'S OWN ACCOUNTS/WALLETS are also "Transfer" and must always be kept (never dropped): e.g. Maybank → Touch 'n Go, Touch 'n Go → Maybank, bank-to-wallet top-ups, reloads funded "from [a bank/card]". These are real money movements but are neither income nor spending.
- Do NOT blanket-classify every "Fund Transfer" as "Transfer": a transfer to/from another PERSON (a human name, e.g. an allowance or repayment) can be real income or a real expense — judge by context. Reserve "Transfer" for the user's OWN-account movements and GO+ internal legs.
- Use "Treats & Meals" when a transaction is clearly paying for someone else's food/drinks (e.g. group dinners where one person pays). Use "Gifts" for presents, "Donations" for charities, "Tithe / Offering" for religious giving.
- note: 1 short sentence in plain English describing what this transaction is about. Focus on WHO or WHAT, not technical details. NEVER include reference numbers, transaction IDs, or random alphanumeric codes. Examples:
  "FUND TRANSFER TO A/ – WONG HON SUN – Meal Allowance Aug 25" → "Meal allowance from Wong Hon Sun"
  "PYMT FROM A/C – GRABPAY MALAYSIA – xyz123" → "GrabPay payment"
  "OPENAI *CHATGPT SUB – SAN FRANCISCO" → "ChatGPT subscription"
  "IBK FUND TFR FR A/C – BRYAN WONG WIN KIT – 250" → "Transfer from Bryan Wong Win Kit"
  "FPX PAYMENT FR A/ – REENSN2508157400000 RENEW WELL..." → "FPX payment to Renew Wellness"
  If no useful context beyond the merchant name, just write "[Merchant] payment" or leave note as empty string ""

Return ONLY a JSON array (no markdown):
[{"id": 1, "merchantName": "...", "categoryName": "...", "confidence": 0.95, "note": "..."}]`;

  const t0 = Date.now();
  let resp;
  try {
    resp = await ai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });
  } catch (err) {
    log.error({ err, model: DEFAULT_MODEL, count: transactions.length }, "bulk categorize LLM call failed");
    return [];
  }

  const text = resp.choices[0]?.message?.content ?? "[]";
  const json = text.replace(/```(?:json)?/g, "").trim();

  try {
    const results = JSON.parse(json);
    if (!Array.isArray(results)) {
      log.warn({ count: transactions.length }, "bulk categorize response was not a JSON array — skipping");
      return [];
    }
    const mapped = results
      .filter(
        (r: any) =>
          typeof r.id === "number" &&
          typeof r.merchantName === "string" &&
          typeof r.categoryName === "string"
      )
      .map((r: any) => ({ ...r, note: r.note ?? "" }));
    log.info({ model: DEFAULT_MODEL, ms: Date.now() - t0, input: transactions.length, categorized: mapped.length }, "bulk categorized");
    return mapped;
  } catch (err) {
    log.warn({ err, sample: text.slice(0, 200) }, "bulk categorize response was not valid JSON — skipping");
    return [];
  }
}
