import { PreviewRow } from "@/app/api/parse-preview/route";
import crypto from "crypto";

/**
 * Within a single batch, two transactions can legitimately have the same
 * date + amount + description (e.g. two coffees on the same day).
 * The base fingerprint would be identical, causing the second to be
 * silently skipped as a "duplicate."
 *
 * This function detects collisions and appends a counter suffix so every
 * row in the batch gets a unique fingerprint while still deduplicating
 * across re-imports of the same file.
 */
export function deduplicateFingerprints(rows: PreviewRow[]): PreviewRow[] {
  const seen = new Map<string, number>();

  return rows.map((row) => {
    if (!row.fingerprint) return row;

    const base = row.fingerprint;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    if (count === 1) return row; // first occurrence — keep original fingerprint

    // nth occurrence — append counter hash so it's stable across re-imports
    const uniqueFingerprint = crypto
      .createHash("sha256")
      .update(`${base}:${count}`)
      .digest("hex")
      .slice(0, 64);

    return { ...row, fingerprint: uniqueFingerprint };
  });
}
