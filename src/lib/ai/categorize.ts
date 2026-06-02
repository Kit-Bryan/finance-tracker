import { getAIClient, DEFAULT_MODEL } from "./client";
import { getConfirmedExamples, CategoryExample } from "./examples";

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

  const prompt = `You are categorizing Malaysian bank transactions. For each transaction, identify the real merchant name and pick the best category.

Available categories (use EXACTLY one of these names):
${categoryNames.join(", ")}
${examplesBlock}
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
- note: 1 short sentence in plain English describing what this transaction is about. Focus on WHO or WHAT, not technical details. NEVER include reference numbers, transaction IDs, or random alphanumeric codes. Examples:
  "FUND TRANSFER TO A/ – WONG HON SUN – Meal Allowance Aug 25" → "Meal allowance from Wong Hon Sun"
  "PYMT FROM A/C – GRABPAY MALAYSIA – xyz123" → "GrabPay payment"
  "OPENAI *CHATGPT SUB – SAN FRANCISCO" → "ChatGPT subscription"
  "IBK FUND TFR FR A/C – BRYAN WONG WIN KIT – 250" → "Transfer from Bryan Wong Win Kit"
  "FPX PAYMENT FR A/ – REENSN2508157400000 RENEW WELL..." → "FPX payment to Renew Wellness"
  If no useful context beyond the merchant name, just write "[Merchant] payment" or leave note as empty string ""

Return ONLY a JSON array (no markdown):
[{"id": 1, "merchantName": "...", "categoryName": "...", "confidence": 0.95, "note": "..."}]`;

  const resp = await ai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const text = resp.choices[0]?.message?.content ?? "[]";
  const json = text.replace(/```(?:json)?/g, "").trim();

  try {
    const results = JSON.parse(json);
    if (!Array.isArray(results)) return [];
    return results
      .filter(
        (r: any) =>
          typeof r.id === "number" &&
          typeof r.merchantName === "string" &&
          typeof r.categoryName === "string"
      )
      .map((r: any) => ({ ...r, note: r.note ?? "" }));
  } catch {
    return [];
  }
}
