import { parse } from "csv-parse/sync";
import { ProfileConfig, ParsedRow } from "./types";
import { computeFingerprint } from "./fingerprint";

// Parse "HH:MM", "HH:MM:SS", optionally with AM/PM, into [hours, minutes, seconds] (24h).
function parseTimeParts(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4]?.toLowerCase();
  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return [hh, mm, ss];
}

function parseDateTime(rawDate: string, format: string, rawTime?: string): Date {
  let r = rawDate.trim();
  let timeStr = rawTime?.trim() ?? "";

  // A time embedded in the date cell, e.g. "12/08/2025 14:30:00" or "2025-08-12T14:30"
  const embedded = r.match(/^(.*?)[ T]+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)\s*$/);
  if (embedded) {
    r = embedded[1].trim();
    if (!timeStr) timeStr = embedded[2];
  }

  let year: number, month: number, day: number;
  if (format === "MM/DD/YYYY") {
    [month, day, year] = r.split("/").map(Number);
  } else if (format === "DD/MM/YYYY") {
    [day, month, year] = r.split("/").map(Number);
  } else if (format === "YYYY-MM-DD") {
    [year, month, day] = r.split("-").map(Number);
  } else if (format === "MM-DD-YYYY") {
    [month, day, year] = r.split("-").map(Number);
  } else {
    const d = new Date(r);
    if (!isNaN(d.getTime())) return d;
    throw new Error(`Cannot parse date "${r}" with format "${format}"`);
  }

  const t = timeStr ? parseTimeParts(timeStr) : null;
  const d = t
    ? new Date(Date.UTC(year, month - 1, day, t[0], t[1], t[2]))
    : new Date(Date.UTC(year, month - 1, day));
  if (isNaN(d.getTime())) throw new Error(`Invalid date "${rawDate}"`);
  return d;
}

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function findColumn(
  headers: string[],
  target: string
): string | undefined {
  const norm = normalizeKey(target);
  return headers.find((h) => normalizeKey(h) === norm);
}

export function parseCSV(
  csvText: string,
  config: ProfileConfig,
  accountId: number
): ParsedRow[] {
  const records: Record<string, string>[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter: config.delimiter ?? ",",
    from_line: (config.skipRows ?? 0) + 1,
  });

  if (records.length === 0) return [];

  const headers = Object.keys(records[0]);

  const dateCol = findColumn(headers, config.dateColumn);
  const timeCol = config.timeColumn ? findColumn(headers, config.timeColumn) : undefined;
  const descCol = findColumn(headers, config.descriptionColumn);
  const amountCol = config.amountColumn
    ? findColumn(headers, config.amountColumn)
    : undefined;
  const debitCol = config.debitColumn
    ? findColumn(headers, config.debitColumn)
    : undefined;
  const creditCol = config.creditColumn
    ? findColumn(headers, config.creditColumn)
    : undefined;

  if (!dateCol) throw new Error(`Date column "${config.dateColumn}" not found in headers: ${headers.join(", ")}`);
  if (!descCol) throw new Error(`Description column "${config.descriptionColumn}" not found`);
  if (!amountCol && !debitCol) throw new Error("No amount or debit column found");

  const rows: ParsedRow[] = [];

  for (const record of records) {
    try {
      const date = parseDateTime(record[dateCol], config.dateFormat, timeCol ? record[timeCol] : undefined);
      const description = record[descCol].trim();

      let amount: number;

      if (amountCol) {
        const raw = record[amountCol].replace(/[,$\s]/g, "");
        amount = parseFloat(raw);
        if (isNaN(amount)) throw new Error(`Invalid amount "${record[amountCol]}"`);
      } else {
        // separate debit / credit columns
        const debitRaw = debitCol ? record[debitCol].replace(/[,$\s]/g, "") : "0";
        const creditRaw = creditCol ? record[creditCol].replace(/[,$\s]/g, "") : "0";
        const debit = parseFloat(debitRaw) || 0;
        const credit = parseFloat(creditRaw) || 0;
        // debit = money out = negative
        amount = (config.debitIsPositive ? -debit : debit) + credit;
      }

      const currency = config.currency ?? "USD";
      const fingerprint = computeFingerprint(accountId, date, amount, description);

      rows.push({ date, description, amount, currency, rawRow: record, fingerprint });
    } catch (e: unknown) {
      rows.push({
        date: new Date(),
        description: "",
        amount: 0,
        currency: config.currency ?? "USD",
        rawRow: record,
        fingerprint: "",
        parseError: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return rows;
}
