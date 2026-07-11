"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  batchId: number;
  /** 0-based page index of the transaction row on the source document, if known */
  page: number | null;
  /** 0–1 vertical position of the row on that page, if known */
  yPercent: number | null;
  /** Display label for the transaction being traced */
  label: string;
  onClose: () => void;
}

// Shows the stored original statement for a batch, scrolled to (and highlighting)
// the spot where a specific transaction appears.
export default function SourceViewerModal({ batchId, page, yPercent, label, onClose }: Props) {
  const [pages, setPages] = useState<string[]>([]);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const paneRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLImageElement | null>>({});
  const scrolledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Metadata only — the pages themselves are served as real images from the
    // server-side render cache, so the browser can cache them too. The ?v=
    // token (file mtime) busts caches when a statement is re-synced.
    fetch(`/api/import-batches/${batchId}/pages`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(data.error ?? "Could not load the source document"); setLoading(false); return; }
        const count: number = data.pageCount ?? 0;
        setPages(Array.from({ length: count }, (_, i) => `/api/import-batches/${batchId}/pages/${i}?v=${data.version ?? 0}`));
        setFilename(data.filename ?? "");
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError("Could not load the source document"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [batchId]);

  // Scroll the highlighted spot into view once its page image has a real height.
  // Uses rect math — img.offsetTop is relative to its position:relative wrapper
  // (~0 for every page), so it can't locate the page within the pane.
  function maybeScroll() {
    if (scrolledRef.current || yPercent == null) return;
    const img = pageRefs.current[page ?? 0];
    const pane = paneRef.current;
    if (!img || !pane || img.clientHeight === 0) return;
    const imgRect = img.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const target = (imgRect.top - paneRect.top) + pane.scrollTop + yPercent * imgRect.height - pane.clientHeight / 2;
    pane.scrollTop = Math.max(0, target);
    scrolledRef.current = true;
  }

  // Data-URL images are often `complete` before React attaches onLoad, and big
  // pages can take seconds to decode — poll until layout heights are real.
  useEffect(() => {
    if (pages.length === 0 || yPercent == null) return;
    const timer = setInterval(() => {
      maybeScroll();
      if (scrolledRef.current) clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasHighlight = yPercent != null;

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10,
        // Definite height (not just maxHeight) so the flex-basis-0 document pane
        // gets the remaining space instead of collapsing to zero.
        width: "min(1000px, 94vw)", height: "90vh", display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {label}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Source — {filename || `import batch #${batchId}`}
              {!hasHighlight && !loading && !error && " · no saved position for this row (showing full document)"}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", padding: "4px 8px" }}>✕</button>
        </div>

        {/* Document */}
        {/* minHeight: 0 lets this flex child shrink below its content height —
            without it the pane grows to full document height, the modal clips
            it, and scrollTop can never move (clientHeight === scrollHeight). */}
        <div ref={paneRef} style={{ overflow: "auto", background: "#fff", flex: "1 1 0", minHeight: 0 }}>
          {loading && (
            <div style={{ padding: 60, textAlign: "center", color: "#666", fontSize: 13 }}>Rendering statement…</div>
          )}
          {error && (
            <div style={{ padding: 60, textAlign: "center", color: "#a33", fontSize: 13 }}>{error}</div>
          )}
          {pages.map((src, i) => (
            <div key={i} style={{ position: "relative" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={(el) => { pageRefs.current[i] = el; }}
                src={src}
                alt={`Statement page ${i + 1}`}
                onLoad={maybeScroll}
                style={{ width: "100%", display: "block", borderBottom: i < pages.length - 1 ? "1px solid #ddd" : "none" }}
              />
              {hasHighlight && (page ?? 0) === i && (
                <div style={{
                  position: "absolute", left: 0, right: 0,
                  top: `${Math.max(0, (yPercent! - 0.022) * 100)}%`, height: "4.4%",
                  background: "rgba(201,168,76,0.10)", border: "1px solid #c9a84c",
                  borderRadius: 2, pointerEvents: "none",
                }} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
