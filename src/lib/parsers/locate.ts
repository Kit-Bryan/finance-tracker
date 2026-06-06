import { BBoxPage } from "@/lib/parsers/render";

export interface StatementLine {
  page: number;     // 0-based page index
  yPercent: number; // 0–1 vertical center of the line on its page
  text: string;     // full line text, words left-to-right
}

export interface MatchResult {
  positions: { index: number; page: number; yPercent: number }[];
  unmatchedIndexes: number[];
  lines: StatementLine[]; // all reconstructed lines, for the LLM fallback
}

// Group a page's words into visual lines by vertical proximity, computing each
// line's vertical center as a fraction of page height.
export function reconstructLines(pages: BBoxPage[]): StatementLine[] {
  const lines: StatementLine[] = [];

  pages.forEach((page, pageIdx) => {
    if (!page.words.length || !page.height) return;

    const words = [...page.words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);

    // Rotated pages: pdftotext mislabels the page as the unrotated MediaBox
    // (e.g. 595×842 portrait) but emits word coordinates in the rendered/visual
    // space (e.g. 842 wide × 595 tall) — which is also how pdftoppm renders the
    // image. Detect that (words extend past the declared width) and normalize Y
    // by the TRUE visual height so highlight positions match the displayed image.
    const maxX = Math.max(...words.map((w) => w.xMax));
    const visualHeight = maxX > page.width + 2 ? page.width : page.height;

    const heights = words.map((w) => w.yMax - w.yMin).filter((h) => h > 0).sort((a, b) => a - b);
    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 8;
    const threshold = medianH * 0.6;

    let group: BBoxPage["words"] = [];
    let groupCenter = 0;

    const flush = () => {
      if (!group.length) return;
      const sorted = [...group].sort((a, b) => a.xMin - b.xMin);
      const text = sorted.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
      const yc = group.reduce((s, w) => s + (w.yMin + w.yMax) / 2, 0) / group.length;
      if (text) lines.push({ page: pageIdx, yPercent: Math.max(0, Math.min(1, yc / visualHeight)), text });
      group = [];
    };

    for (const w of words) {
      const center = (w.yMin + w.yMax) / 2;
      if (group.length === 0) {
        group = [w];
        groupCenter = center;
      } else if (Math.abs(center - groupCenter) <= threshold) {
        group.push(w);
        groupCenter = group.reduce((s, x) => s + (x.yMin + x.yMax) / 2, 0) / group.length;
      } else {
        flush();
        group = [w];
        groupCenter = center;
      }
    }
    flush();
  });

  return lines;
}

// Pull money-looking numbers out of a line. A decimal point is required, which
// naturally excludes long reference/account integers (e.g. 202506121310...190).
// Tolerates "RM", thousands commas, and any number of decimals (RM0.9985, 10,759.46).
function lineAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /\d[\d,]*\.\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[0].replace(/,/g, ""));
    if (!Number.isNaN(v)) out.push(v);
  }
  return out;
}

// Does a line contain the given amount, compared by VALUE (not string)? This makes
// matching format-agnostic across banks — no assumptions about decimals or signs.
function hasAmount(lineText: string, amount: number): boolean {
  const target = Math.abs(amount);
  return lineAmounts(lineText).some((v) => Math.abs(v - target) < 0.005);
}

// Plausible string renderings of an ISO (YYYY-MM-DD) date as they appear in
// Malaysian statements: D/M/Y and DD/MM/YY(YY) with / - . separators, plus ISO.
// (M/D/Y is deliberately excluded — it would create false matches and MY banks
// don't use it.)
function dateVariants(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [];
  const y = m[1], yy = y.slice(2);
  const mo1 = String(parseInt(m[2], 10)), mo2 = m[2];
  const d1 = String(parseInt(m[3], 10)), d2 = m[3];
  const out = new Set<string>();
  for (const s of ["/", "-", "."]) {
    out.add(`${d1}${s}${mo1}${s}${y}`);
    out.add(`${d2}${s}${mo2}${s}${y}`);
    out.add(`${d1}${s}${mo1}${s}${yy}`);
    out.add(`${d2}${s}${mo2}${s}${yy}`);
    out.add(`${y}${s}${mo2}${s}${d2}`);
  }
  return [...out];
}

const WINDOW = 120; // lines to look ahead from the last match (a few rows of slack)

// Walk transactions and lines together (both in statement order, top-to-bottom).
// A row's top line carries BOTH its date and its amount, so we prefer the first
// line that has both — this disambiguates repeated amounts, balance-column
// collisions, and sign-less formats (e.g. TNG eWallet). Falls back to amount-only,
// then leaves the rest for the LLM pass.
export function matchTransactionsToLines(
  transactions: { amount: number; date: string }[],
  pages: BBoxPage[],
): MatchResult {
  const lines = reconstructLines(pages);
  const positions: { index: number; page: number; yPercent: number }[] = [];
  const unmatchedIndexes: number[] = [];
  let pointer = 0;

  transactions.forEach((tx, index) => {
    const variants = dateVariants(tx.date);
    const end = Math.min(lines.length, pointer + WINDOW);

    // Pass 1: earliest line with amount AND date (the row's top line)
    let at = -1;
    for (let i = pointer; i < end; i++) {
      if (hasAmount(lines[i].text, tx.amount) && variants.some((v) => lines[i].text.includes(v))) { at = i; break; }
    }
    // Pass 2: earliest line with just the amount
    if (at === -1) {
      for (let i = pointer; i < end; i++) {
        if (hasAmount(lines[i].text, tx.amount)) { at = i; break; }
      }
    }

    if (at !== -1) {
      positions.push({ index, page: lines[at].page, yPercent: lines[at].yPercent });
      pointer = at + 1; // monotonic: never match earlier than the previous row
    } else {
      unmatchedIndexes.push(index);
    }
  });

  return { positions, unmatchedIndexes, lines };
}
