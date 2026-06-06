import { getAIClient, DEFAULT_MODEL } from "./client";
import { ProfileConfig } from "@/lib/parsers/types";

export interface ParsedTransaction {
  date: string;       // YYYY-MM-DD
  time?: string;      // HH:MM (24h) — only when the statement includes a time
  description: string;
  amount: number;     // negative = expense, positive = income
  currency: string;
}

export interface PdfParseResult {
  transactions: ParsedTransaction[];
  account: AccountInfo;
}

export interface AccountInfo {
  bank: string;          // e.g. "Maybank", "CIMB", "Touch 'n Go"
  accountType: string;   // "savings" | "current" | "credit_card" | "ewallet" | "unknown"
  accountNumber: string; // full account number as it appears in the statement, or "" if not found
  accountName: string;   // display label e.g. "Maybank Savings ****1234"
}

export interface CsvProfileSuggestion {
  config: ProfileConfig;
  account: AccountInfo;
}

// Ask the LLM to suggest a ProfileConfig given the CSV headers + a few sample rows
export async function suggestCsvProfile(
  headers: string[],
  sampleRows: Record<string, string>[]
): Promise<CsvProfileSuggestion> {
  const ai = getAIClient();

  const prompt = `You are parsing a Malaysian bank or e-wallet CSV export. Given these headers and sample rows, return a JSON object.

Headers: ${JSON.stringify(headers)}
Sample rows (first 3):
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

Return ONLY valid JSON (no markdown, no explanation):
{
  "account": {
    "bank": "detected bank/wallet name e.g. Maybank, CIMB, Public Bank, Touch n Go, RHB, Hong Leong, AmBank, Boost, GrabPay",
    "accountType": "one of: savings | current | credit_card | ewallet | unknown",
    "accountNumber": "full account number as it appears in the data/headers, or empty string if not found",
    "accountName": "display label e.g. 'Maybank Savings ****1234' or 'Touch n Go eWallet'"
  },
  "config": {
    "dateColumn": "exact header name for the date",
    "timeColumn": "exact header name for a SEPARATE time column if one exists — omit if there's no time, or if the time is part of the date column",
    "descriptionColumn": "exact header name for the description/merchant",
    "amountColumn": "exact header name if ONE signed amount column — omit if separate debit/credit",
    "debitColumn": "exact header name for debits if separate — omit if using amountColumn",
    "creditColumn": "exact header name for credits if separate — omit if using amountColumn",
    "dateFormat": "one of: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, MM-DD-YYYY",
    "debitIsPositive": true,
    "currency": "MYR"
  }
}`;

  const resp = await ai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const text = resp.choices[0]?.message?.content ?? "{}";
  const json = text.replace(/```(?:json)?/g, "").trim();
  const parsed = JSON.parse(json);
  return {
    account: {
      bank: parsed.account?.bank ?? "Unknown Bank",
      accountType: parsed.account?.accountType ?? "unknown",
      accountNumber: parsed.account?.accountNumber ?? "",
      accountName: parsed.account?.accountName ?? parsed.account?.bank ?? "My Account",
    },
    config: parsed.config as ProfileConfig,
  };
}

// Ask the LLM to parse a PDF bank statement text into structured transactions
export async function parsePdfStatement(
  pdfText: string,
  hint?: { currency?: string; bank?: string }
): Promise<PdfParseResult> {
  const ai = getAIClient();

  // Truncate very long PDFs (token limit buffer)
  const truncated = pdfText.length > 12000 ? pdfText.slice(0, 12000) + "\n[truncated]" : pdfText;

  const prompt = `You are a Malaysian financial data extractor. Extract ALL transactions from this bank statement text.

${hint?.bank ? `Hint — Bank: ${hint.bank}` : ""}

Statement text:
---
${truncated}
---

Return ONLY valid JSON (no markdown, no explanation):
{
  "account": {
    "bank": "detected bank/wallet name e.g. Maybank, CIMB, Public Bank, Touch n Go, RHB, Hong Leong",
    "accountType": "one of: savings | current | credit_card | ewallet | unknown",
    "accountNumber": "full account number from the statement header, or empty string if not found",
    "accountName": "display label e.g. 'Maybank Savings ****1234' or 'Touch n Go eWallet'"
  },
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "merchant or description",
      "amount": -50.00,
      "currency": "MYR"
    }
  ]
}

Rules:
- amount: money leaving account = negative, money entering = positive
- Skip opening/closing balance rows, fee summaries, non-transaction lines
- currency is MYR unless clearly stated otherwise
- transactions: [] if none found
- accountNumber: extract the full number from the statement header (e.g. "Account No: 1234567890") — do not mask it, we handle masking ourselves`;

  const resp = await ai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
  });

  const text = resp.choices[0]?.message?.content ?? "[]";
  const json = text.replace(/```(?:json)?/g, "").trim();

  try {
    const parsed = JSON.parse(json);
    const rows: ParsedTransaction[] = (parsed.transactions ?? []).filter(
      (r: any) =>
        typeof r.date === "string" &&
        typeof r.description === "string" &&
        typeof r.amount === "number"
    );
    return {
      transactions: rows,
      account: {
        bank: parsed.account?.bank ?? "Unknown Bank",
        accountType: parsed.account?.accountType ?? "unknown",
        accountNumber: parsed.account?.accountNumber ?? "",
        accountName: parsed.account?.accountName ?? parsed.account?.bank ?? "My Account",
      },
    };
  } catch {
    return {
      transactions: [],
      account: { bank: "Unknown Bank", accountType: "unknown", accountNumber: "", accountName: "My Account" },
    };
  }
}
