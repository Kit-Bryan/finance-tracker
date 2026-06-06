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
      if (text) lines.push({ page: pageIdx, yPercent: Math.max(0, Math.min(1, yc / page.height)), text });
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

// Score how strongly a line contains a given amount.
// 2 = signed match (e.g. "56.60-" / "189.60+") — distinguishes the amount column
//     from the running-balance column, very reliable.
// 1 = bare numeric match — weaker (could be a balance or other figure).
function amountScore(lineText: string, amount: number): number {
  const norm = lineText.replace(/,/g, "");
  const abs = Math.abs(amount).toFixed(2);
  const esc = abs.replace(".", "\\.");
  const signed = amount < 0 ? `${abs}-` : `${abs}+`;
  if (norm.includes(signed)) return 2;
  if (new RegExp(`(?<![\\d.])${esc}(?![\\d])`).test(norm)) return 1;
  return 0;
}

// Walk transactions and lines together (both are in statement order, top-to-bottom)
// and assign each transaction the line where its amount appears. Signed matches win;
// bare-number matches are a fallback. Anything unmatched is returned for the LLM pass.
export function matchTransactionsToLines(
  transactions: { amount: number }[],
  pages: BBoxPage[],
): MatchResult {
  const lines = reconstructLines(pages);
  const positions: { index: number; page: number; yPercent: number }[] = [];
  const unmatchedIndexes: number[] = [];
  let pointer = 0;

  transactions.forEach((tx, index) => {
    let strongAt = -1;
    let weakAt = -1;
    for (let i = pointer; i < lines.length; i++) {
      const s = amountScore(lines[i].text, tx.amount);
      if (s === 2) { strongAt = i; break; }
      if (s === 1 && weakAt === -1) weakAt = i;
    }
    const at = strongAt !== -1 ? strongAt : weakAt;
    if (at !== -1) {
      positions.push({ index, page: lines[at].page, yPercent: lines[at].yPercent });
      pointer = at + 1; // monotonic: never match earlier than the previous row
    } else {
      unmatchedIndexes.push(index);
    }
  });

  return { positions, unmatchedIndexes, lines };
}
