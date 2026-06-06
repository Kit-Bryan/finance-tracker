import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { deduplicateFingerprints } from "@/lib/parsers/dedup";
import { extractPdfText } from "@/lib/parsers/pdf";
import { suggestCsvProfile, parsePdfStatement, parseImageStatement, AccountInfo } from "@/lib/ai/parse";
import { parseCSV } from "@/lib/parsers/csv";
import { ProfileConfig } from "@/lib/parsers/types";
import { computeFingerprint } from "@/lib/parsers/fingerprint";
import { db } from "@/db";
import { importProfiles, accounts } from "@/db/schema";

export interface PreviewRow {
  date: string;
  time?: string;   // "HH:MM" (24h) when the source includes a transaction time
  description: string;
  amount: number;
  currency: string;
  fingerprint: string;
  parseError?: string;
}

// Derive "HH:MM" (UTC) from a Date, or undefined if the time is midnight (date-only).
function utcTimeString(d: Date): string | undefined {
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  if (hh === 0 && mm === 0 && d.getUTCSeconds() === 0) return undefined;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export interface PreviewResponse {
  type: "csv" | "pdf" | "image";
  rows: PreviewRow[];
  suggestedProfile?: Record<string, unknown>;
  profileId?: number;
  account: AccountInfo;
  accountId: number;
  accountIsNew: boolean;
  totalRows: number;
  errorRows: number;
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    default: return "image/png";
  }
}

function hashAccountNumber(accountNumber: string): string {
  return crypto.createHash("sha256").update(accountNumber.replace(/\s/g, "")).digest("hex");
}

function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, "");
  if (digits.length < 4) return accountNumber;
  return "****" + digits.slice(-4);
}

// Match priority:
// 1. Same bank + same account number hash (exact account)
// 2. Same bank + same account type + no account number stored (legacy/unknown)
// 3. Create new
async function resolveAccount(info: AccountInfo): Promise<{ id: number; isNew: boolean }> {
  const all = await db.select().from(accounts);
  const bankNorm = info.bank.toLowerCase();

  // Exact match on account number
  if (info.accountNumber) {
    const hash = hashAccountNumber(info.accountNumber);
    const exact = all.find((a) => a.accountNumberHash === hash);
    if (exact) return { id: exact.id, isNew: false };
  }

  // Fallback: same bank + account type (when no account number available, e.g. TNG eWallet)
  if (!info.accountNumber) {
    const typeMatch = all.find(
      (a) =>
        a.bank.toLowerCase() === bankNorm &&
        a.accountType === info.accountType &&
        !a.accountNumberHash
    );
    if (typeMatch) return { id: typeMatch.id, isNew: false };
  }

  // Create new account
  const masked = info.accountNumber ? maskAccountNumber(info.accountNumber) : undefined;
  const hash = info.accountNumber ? hashAccountNumber(info.accountNumber) : undefined;

  const [created] = await db
    .insert(accounts)
    .values({
      name: info.accountName,
      bank: info.bank,
      accountType: info.accountType,
      accountNumber: masked,
      accountNumberHash: hash,
      currency: "MYR",
    })
    .returning();

  return { id: created.id, isNew: true };
}

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const profileId = formData.get("profileId") ? parseInt(formData.get("profileId") as string) : null;

  if (!file) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
  const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name) || file.type.startsWith("image/");

  // ── Image path (vision) ─────────────────────────────────────────────────────
  if (isImage) {
    const mime = file.type && file.type.startsWith("image/") ? file.type : mimeFromName(file.name);
    const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

    let result;
    try {
      result = await parseImageStatement([dataUrl]);
    } catch (e) {
      return NextResponse.json({ error: `AI image parsing failed: ${e}` }, { status: 500 });
    }

    const { transactions, account } = result;
    const { id: accountId, isNew: accountIsNew } = await resolveAccount(account);

    const rawRows: PreviewRow[] = transactions.map((r) => ({
      date: r.date,
      time: r.time,
      description: r.description,
      amount: r.amount,
      currency: r.currency || "MYR",
      fingerprint: computeFingerprint(accountId, new Date(r.date), r.amount, r.description),
    }));
    const rows = deduplicateFingerprints(rawRows);

    return NextResponse.json({
      type: "image",
      rows,
      account,
      accountId,
      accountIsNew,
      totalRows: rows.length,
      errorRows: 0,
    } satisfies PreviewResponse);
  }

  // ── PDF path ──────────────────────────────────────────────────────────────
  if (isPdf) {
    let pdfText: string;
    try {
      pdfText = await extractPdfText(buffer);
    } catch (e) {
      return NextResponse.json({ error: `PDF extraction failed: ${e}` }, { status: 422 });
    }

    let result;
    try {
      result = await parsePdfStatement(pdfText);
    } catch (e) {
      return NextResponse.json({ error: `AI parsing failed: ${e}` }, { status: 500 });
    }

    const { transactions, account } = result;
    const { id: accountId, isNew: accountIsNew } = await resolveAccount(account);

    const rawRows: PreviewRow[] = transactions.map((r) => ({
      date: r.date,
      time: r.time,
      description: r.description,
      amount: r.amount,
      currency: r.currency || "MYR",
      fingerprint: computeFingerprint(accountId, new Date(r.date), r.amount, r.description),
    }));
    const rows = deduplicateFingerprints(rawRows);

    return NextResponse.json({
      type: "pdf",
      rows,
      account,
      accountId,
      accountIsNew,
      totalRows: rows.length,
      errorRows: 0,
    } satisfies PreviewResponse);
  }

  // ── CSV path ──────────────────────────────────────────────────────────────
  const csvText = buffer.toString("utf-8");

  let records: Record<string, string>[];
  try {
    records = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true, to: 5 });
  } catch (e) {
    return NextResponse.json({ error: `CSV parse error: ${e}` }, { status: 422 });
  }

  const rawHeaders = records.length > 0 ? Object.keys(records[0]) : [];

  let config: ProfileConfig | null = null;
  let resolvedProfileId: number | undefined;
  let detectedAccount: AccountInfo = { bank: "Unknown Bank", accountType: "unknown", accountNumber: "", accountName: "My Account" };
  let suggestedProfile: Record<string, unknown> | undefined;

  if (profileId) {
    const [profile] = await db.select().from(importProfiles).where(eq(importProfiles.id, profileId));
    if (profile) {
      config = profile.config as ProfileConfig;
      resolvedProfileId = profile.id;
      detectedAccount = { bank: profile.bank, accountType: "unknown", accountNumber: "", accountName: profile.name };
    }
  }

  if (!config) {
    try {
      const suggestion = await suggestCsvProfile(rawHeaders, records);
      config = suggestion.config;
      detectedAccount = suggestion.account;
      suggestedProfile = { ...suggestion.config, _name: suggestion.account.accountName };
    } catch (e) {
      return NextResponse.json({ error: `Profile suggestion failed: ${e}` }, { status: 500 });
    }
  }

  const { id: accountId, isNew: accountIsNew } = await resolveAccount(detectedAccount);

  let allRows;
  try {
    allRows = parseCSV(csvText, config, accountId);
  } catch (e) {
    return NextResponse.json({ error: `CSV row parse failed: ${e}` }, { status: 422 });
  }

  const rawRows: PreviewRow[] = allRows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    time: r.parseError ? undefined : utcTimeString(r.date),
    description: r.description,
    amount: r.amount,
    currency: r.currency,
    fingerprint: r.fingerprint,
    parseError: r.parseError,
  }));
  const rows = deduplicateFingerprints(rawRows);

  return NextResponse.json({
    type: "csv",
    rows,
    suggestedProfile,
    profileId: resolvedProfileId,
    account: detectedAccount,
    accountId,
    accountIsNew,
    totalRows: rows.length,
    errorRows: rows.filter((r) => r.parseError).length,
  } satisfies PreviewResponse);
}
