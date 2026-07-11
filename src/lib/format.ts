export function formatCurrency(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function formatMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split("-");
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(
    new Date(Number(y), Number(m) - 1)
  );
}

// Local-date strings, built without toISOString(): converting local midnight to
// UTC shifts the date back a day in UTC+8 (and today() would lag before 8am).
export function startOfMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Timestamp helpers ──────────────────────────────────────────────────────────
// Transactions are stored with their literal statement wall-clock time in the UTC
// frame (date-only rows stay at 00:00 UTC, identical to before). Display in UTC so
// the time shown matches the statement regardless of the viewer's timezone.

// Build a postedAt timestamp from a "YYYY-MM-DD" date and optional "HH:MM[:SS]" time.
export function combinePostedAt(date: string, time?: string | null): Date {
  const [y, m, d] = date.split("-").map(Number);
  if (time && /^\d{1,2}:\d{2}/.test(time.trim())) {
    const [hh, mm, ss] = time.trim().split(":").map((n) => parseInt(n, 10) || 0);
    return new Date(Date.UTC(y, m - 1, d, hh, mm, ss || 0));
  }
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatTxDate(d: string | Date): string {
  return new Date(d).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Returns "h:mm AM/PM" in UTC, or null when the time is midnight (i.e. date-only).
export function formatTxTime(d: string | Date): string | null {
  const date = new Date(d);
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) return null;
  return date.toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" });
}
