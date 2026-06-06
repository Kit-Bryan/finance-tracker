import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { deduplicateFingerprints } from "@/lib/parsers/dedup";
import { extractPdfText } from "@/lib/parsers/pdf";
import { renderPdfToImages, extractPdfTextBoxes } from "@/lib/parsers/render";
import { matchTransactionsToLines } from "@/lib/parsers/locate";
import { suggestCsvProfile, parsePdfStatement, parseImageStatement, mapTransactionsToLines, AccountInfo } from "@/lib/ai/parse";
import { parseCSV } from "@/lib/parsers/csv";
import { ProfileConfig } from "@/lib/parsers/types";
import { computeFingerprint } from "@/lib/parsers/fingerprint";
import { db } from "@/db";
import { importProfiles, accounts } from "@/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "parse-preview" });

export interface PreviewRow {
  date: string;
  time?: string;   // "HH:MM" (24h) when the source includes a transaction time
  description: string;
  amount: number;
  currency: string;
  fingerprint: string;
  parseError?: string;
  page?: number;     // 0-based page/image index this row appears on
  yPercent?: number; // 0–1 vertical position of the row, for hover-highlight on the statement image
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
  truncated?: boolean;       // true if the document was too large to fully scan
  truncationNote?: string;   // human-readable explanation
  pageImages?: string[];     // rasterized PDF pages (base64 PNG data URLs) for the side-by-side comparison
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
      log.error({ err: e, filename: file.name }, "image parsing failed");
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
      page: r.page ?? 0,
      yPercent: r.yPercent,
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

  // ── PDF path (text-first, vision fallback for scanned / text-less PDFs) ──────
  if (isPdf) {
    let pdfText = "";
    try {
      pdfText = await extractPdfText(buffer);
    } catch {
      pdfText = ""; // treat as text-less → vision fallback below
    }

    const hasTextLayer = pdfText.trim().length >= 100;
    let result;
    let truncated = false;
    let truncationNote: string | undefined;
    let pageImages: string[] = [];   // rasterized pages, reused for the comparison view
    try {
      if (hasTextLayer) {
        result = await parsePdfStatement(pdfText);
        if (result.truncated) {
          truncated = true;
          truncationNote = "This statement's text was longer than we can scan in one pass — some later transactions may be missing.";
        }
        // Digital PDF whose text parsed to nothing useful → try vision as a backstop
        if (result.transactions.length === 0) {
          const r = await renderPdfToImages(buffer);
          pageImages = r.images;
          result = await parseImageStatement(r.images);
          if (r.truncated) { truncated = true; truncationNote = `Only the first ${r.images.length} of ${r.totalPages} pages were scanned — some transactions may be missing.`; }
        }
      } else {
        // No extractable text → scanned/image PDF → must rasterize and use vision
        const r = await renderPdfToImages(buffer);
        pageImages = r.images;
        result = await parseImageStatement(r.images);
        if (r.truncated) { truncated = true; truncationNote = `Only the first ${r.images.length} of ${r.totalPages} pages were scanned — some transactions may be missing.`; }
      }
    } catch (e) {
      log.error({ err: e, filename: file.name, hasTextLayer }, "PDF parsing failed");
      const hint = hasTextLayer
        ? `AI parsing failed: ${e}`
        : `This PDF has no text layer (likely scanned) and the PDF renderer is unavailable: ${e}`;
      return NextResponse.json({ error: hint }, { status: hasTextLayer ? 500 : 422 });
    }

    // Text-parsed PDFs were never rasterized — render now for the side-by-side
    // comparison view. Non-fatal: if it fails, the UI falls back to the collapsed iframe.
    if (pageImages.length === 0) {
      try {
        const r = await renderPdfToImages(buffer);
        pageImages = r.images;
      } catch (e) {
        log.warn({ err: e, filename: file.name }, "could not rasterize PDF for preview display");
      }
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
      page: r.page,
      yPercent: r.yPercent,
    }));
    const rows = deduplicateFingerprints(rawRows);

    // Text-parsed PDFs have no positional info. Derive it from the PDF text layer
    // (exact, programmatic) and only fall back to the LLM — text→text, never
    // coordinate-guessing — for the stragglers the matcher couldn't place.
    // (Scanned PDFs already carry vision yPercent; their text layer is empty so
    // extractPdfTextBoxes returns [] and this block is a no-op.)
    if (rows.some((r) => r.yPercent == null)) {
      try {
        const bboxPages = await extractPdfTextBoxes(buffer);
        if (bboxPages.length > 0) {
          const { positions, unmatchedIndexes, lines } = matchTransactionsToLines(
            rows.map((r) => ({ amount: r.amount })),
            bboxPages,
          );
          for (const p of positions) {
            const row = rows[p.index];
            if (row && row.yPercent == null) { row.page = p.page; row.yPercent = p.yPercent; }
          }

          // LLM fallback for rows the amount-matcher missed
          const stillUnmatched = unmatchedIndexes.filter((i) => rows[i] && rows[i].yPercent == null);
          if (stillUnmatched.length > 0 && lines.length > 0) {
            const mapped = await mapTransactionsToLines(
              lines,
              stillUnmatched.map((i) => ({ index: i, date: rows[i].date, description: rows[i].description, amount: rows[i].amount })),
            );
            for (const m of mapped) {
              const row = rows[m.index];
              const line = lines[m.lineIndex];
              if (row && line && row.yPercent == null) { row.page = line.page; row.yPercent = line.yPercent; }
            }
          }
        }
      } catch (e) {
        log.warn({ err: e, filename: file.name }, "programmatic transaction locating failed — highlights may be unavailable");
      }
    }

    return NextResponse.json({
      type: "pdf",
      rows,
      account,
      accountId,
      accountIsNew,
      totalRows: rows.length,
      errorRows: 0,
      truncated,
      truncationNote,
      pageImages,
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
      log.error({ err: e, filename: file.name }, "CSV profile suggestion failed");
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
