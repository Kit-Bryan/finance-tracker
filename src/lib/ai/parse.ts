import { getAIClient, DEFAULT_MODEL } from "./client";
import { ProfileConfig } from "@/lib/parsers/types";
import { logger } from "@/lib/logger";

const log = logger.child({ module: "ai/parse" });

export interface ParsedTransaction {
  date: string;       // YYYY-MM-DD
  time?: string;      // HH:MM (24h) — only when the statement includes a time
  description: string;
  amount: number;     // negative = expense, positive = income
  currency: string;
  page?: number;      // 0-based page/image index the row appears on (vision parses only)
  yPercent?: number;  // 0–1 vertical position of the row on that page (for hover-highlight)
}

export interface TxPosition {
  index: number;      // index into the transaction list we asked about
  page: number;       // 0-based page/image index
  yPercent: number;   // 0–1 vertical position of the row on that page
}

export interface PdfParseResult {
  transactions: ParsedTransaction[];
  account: AccountInfo;
  truncated?: boolean; // true if the statement was too large to fully scan
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

// Shared JSON schema + extraction rules used by both the text (PDF) and vision (image) parsers.
// `withPosition` adds page + yPercent fields — only meaningful for vision parses, where the
// model can actually see where each row sits on the page.
function buildStatementSpec(withPosition: boolean): string {
  return `Return ONLY valid JSON (no markdown, no explanation):
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
      "time": "HH:MM",
      "description": "merchant or description",
      "amount": -50.00,
      "currency": "MYR"${withPosition ? `,
      "page": 0,
      "yPercent": 0.42` : ""}
    }
  ]
}

Rules:
- amount: money leaving account = negative, money entering = positive
- Skip opening/closing balance rows, fee summaries, non-transaction lines
- currency is MYR unless clearly stated otherwise
- transactions: [] if none found
- accountNumber: extract the full number from the statement header (e.g. "Account No: 1234567890") — do not mask it, we handle masking ourselves
- time: include "time" (24-hour "HH:MM") ONLY if a specific time is shown for that transaction (common in e-wallet histories like Touch 'n Go, GrabPay). If there's no time, OMIT the field entirely — do not invent one.
- Be precise with amounts and digits — never guess or round; transcribe exactly what is shown.${withPosition ? `
- page: 0-based index of the image this transaction's row appears on (first image = 0).
- yPercent: the vertical center of this transaction's row as a fraction of that page's height — 0.0 = very top, 1.0 = very bottom. Estimate where the row sits visually. Approximate is fine; this is only used to highlight the row.` : ""}`;
}

// Parse the model's JSON response into a structured result (shared by text + vision parsers)
function parseStatementResponse(text: string): PdfParseResult {
  const json = text.replace(/```(?:json)?/g, "").trim();
  try {
    const parsed = JSON.parse(json);
    const rows: ParsedTransaction[] = (parsed.transactions ?? [])
      .filter(
        (r: any) =>
          typeof r.date === "string" &&
          typeof r.description === "string" &&
          typeof r.amount === "number"
      )
      .map((r: any) => ({
        date: r.date,
        time: typeof r.time === "string" && /^\d{1,2}:\d{2}/.test(r.time) ? r.time : undefined,
        description: r.description,
        amount: r.amount,
        currency: r.currency,
        page: typeof r.page === "number" ? r.page : undefined,
        yPercent: typeof r.yPercent === "number" ? Math.max(0, Math.min(1, r.yPercent)) : undefined,
      }));
    return {
      transactions: rows,
      account: {
        bank: parsed.account?.bank ?? "Unknown Bank",
        accountType: parsed.account?.accountType ?? "unknown",
        accountNumber: parsed.account?.accountNumber ?? "",
        accountName: parsed.account?.accountName ?? parsed.account?.bank ?? "My Account",
      },
    };
  } catch (err) {
    // Silent-failure seam: the model returned non-JSON. Surface it instead of returning [].
    log.warn({ err, sample: text.slice(0, 200) }, "statement response was not valid JSON — returning empty result");
    return {
      transactions: [],
      account: { bank: "Unknown Bank", accountType: "unknown", accountNumber: "", accountName: "My Account" },
    };
  }
}

// Ask the LLM to parse a PDF bank statement's extracted text into structured transactions
export async function parsePdfStatement(
  pdfText: string,
  hint?: { currency?: string; bank?: string }
): Promise<PdfParseResult> {
  const ai = getAIClient();
  // Cap well below the model's 400k-token context but high enough for full multi-page
  // statements (~50k tokens). The old 12k-char cap silently dropped later transactions.
  const MAX_PDF_CHARS = 200000;
  const isTruncated = pdfText.length > MAX_PDF_CHARS;
  const truncatedText = isTruncated ? pdfText.slice(0, MAX_PDF_CHARS) + "\n[truncated]" : pdfText;

  const prompt = `You are a Malaysian financial data extractor. Extract ALL transactions from this bank statement text.
${hint?.bank ? `\nHint — Bank: ${hint.bank}` : ""}
Statement text:
---
${truncatedText}
---

${buildStatementSpec(false)}`;

  const t0 = Date.now();
  let resp;
  try {
    resp = await ai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });
  } catch (err) {
    log.error({ err, model: DEFAULT_MODEL, chars: truncatedText.length }, "PDF statement LLM call failed");
    throw err;
  }

  const result = { ...parseStatementResponse(resp.choices[0]?.message?.content ?? ""), truncated: isTruncated };
  log.info({ model: DEFAULT_MODEL, ms: Date.now() - t0, transactions: result.transactions.length, truncated: isTruncated }, "parsed PDF statement (text)");
  return result;
}

// Ask the LLM (vision) to parse bank-statement IMAGES (screenshots / photos / scans) into transactions
export async function parseImageStatement(
  imageDataUrls: string[],
  hint?: { currency?: string; bank?: string }
): Promise<PdfParseResult> {
  const ai = getAIClient();

  const prompt = `You are a Malaysian financial data extractor. The image(s) are a bank statement, e-wallet history, or a screenshot/photo of transactions. Read them carefully and extract ALL transactions.
${hint?.bank ? `\nHint — Bank: ${hint.bank}` : ""}
${buildStatementSpec(true)}`;

  const content: any[] = [
    { type: "text", text: prompt },
    ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const t0 = Date.now();
  let resp;
  try {
    resp = await ai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content }],
      temperature: 0,
    });
  } catch (err) {
    log.error({ err, model: DEFAULT_MODEL, images: imageDataUrls.length }, "image statement (vision) LLM call failed");
    throw err;
  }

  const result = parseStatementResponse(resp.choices[0]?.message?.content ?? "");
  log.info({ model: DEFAULT_MODEL, ms: Date.now() - t0, images: imageDataUrls.length, transactions: result.transactions.length }, "parsed image statement (vision)");
  return result;
}

// Locate already-extracted transactions on rendered page images (vision).
// Used for text-parsed PDFs, which never went through the vision model and so
// have no positional info. Best-effort: returns [] on any failure.
export async function locateTransactionsOnImages(
  imageDataUrls: string[],
  transactions: { date: string; description: string; amount: number }[],
): Promise<TxPosition[]> {
  if (transactions.length === 0 || imageDataUrls.length === 0) return [];
  const ai = getAIClient();

  const list = transactions
    .map((t, i) => `${i}. ${t.date} | ${t.description} | ${t.amount}`)
    .join("\n");

  const prompt = `These image(s) are the pages of a bank statement (first image = page 0). Below is a numbered list of transactions already extracted from this statement. For EACH one, find where its row appears on the page images and report its position.

Transactions:
${list}

Return ONLY valid JSON (no markdown):
{ "positions": [ { "index": 0, "page": 0, "yPercent": 0.42 } ] }

- index: the transaction's number from the list above
- page: 0-based index of the image the row appears on
- yPercent: vertical center of the row as a fraction of that page's height (0.0 = top, 1.0 = bottom)
- Include every transaction you can locate; omit any you genuinely cannot find.`;

  const content: any[] = [
    { type: "text", text: prompt },
    ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const t0 = Date.now();
  try {
    const resp = await ai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [{ role: "user", content }],
      temperature: 0,
    });
    const json = (resp.choices[0]?.message?.content ?? "{}").replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(json);
    const positions: TxPosition[] = (parsed.positions ?? [])
      .filter((p: any) => typeof p.index === "number" && typeof p.yPercent === "number")
      .map((p: any) => ({
        index: p.index,
        page: typeof p.page === "number" ? p.page : 0,
        yPercent: Math.max(0, Math.min(1, p.yPercent)),
      }));
    log.info({ model: DEFAULT_MODEL, ms: Date.now() - t0, located: positions.length, of: transactions.length }, "located transactions on images");
    return positions;
  } catch (err) {
    log.warn({ err }, "locateTransactionsOnImages failed — highlights unavailable for this import");
    return [];
  }
}
