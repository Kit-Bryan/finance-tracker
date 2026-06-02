import crypto from "crypto";

export function computeFingerprint(
  accountId: number,
  date: Date,
  amount: number,
  description: string
): string {
  const normalized = [
    String(accountId),
    date.toISOString().slice(0, 10),
    amount.toFixed(2),
    description.trim().toLowerCase().replace(/\s+/g, " "),
  ].join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 64);
}
