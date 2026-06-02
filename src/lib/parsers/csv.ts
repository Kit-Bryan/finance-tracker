import { parse } from "csv-parse/sync";
import { ProfileConfig, ParsedRow } from "./types";
import { computeFingerprint } from "./fingerprint";

function parseDate(raw: string, format: string): Date {
  const r = raw.trim();
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
    // fallback: try native parse
    const d = new Date(r);
    if (!isNaN(d.getTime())) return d;
    throw new Error(`Cannot parse date "${r}" with format "${format}"`);
  }

  const d = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(d.getTime())) throw new Error(`Invalid date "${r}"`);
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
      const date = parseDate(record[dateCol], config.dateFormat);
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
