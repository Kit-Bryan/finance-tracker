"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

type Step = "upload" | "preview" | "done";

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

interface PreviewRow {
  date: string;
  time?: string;
  description: string;
  amount: number;
  currency: string;
  fingerprint: string;
  parseError?: string;
  page?: number;
  yPercent?: number;
}

interface AccountInfo {
  bank: string;
  accountType: string;
  accountNumber: string;
  accountName: string;
}

interface PreviewResponse {
  type: "csv" | "pdf" | "image";
  rows: PreviewRow[];
  suggestedProfile?: Record<string, unknown>;
  profileId?: number;
  account: AccountInfo;
  accountId: number;
  accountIsNew: boolean;
  totalRows: number;
  errorRows: number;
  truncated?: boolean;
  truncationNote?: string;
  pageImages?: string[];
  positionAccuracy?: "exact" | "approximate" | "none";
}

const ACCEPT = ".csv,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,text/csv,application/pdf,image/*";

export default function ImportPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [saveProfile, setSaveProfile] = useState(true);
  const [profileName, setProfileName] = useState("");

  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{
    batchId: number;
    accountId: number;
    importedRows: number;
    skippedRows: number;
    skippedDetails: PreviewRow[];
    errorRows: number;
  } | null>(null);
  const [selectedSkipped, setSelectedSkipped] = useState<Set<number>>(new Set());
  const [forceImporting, setForceImporting] = useState(false);

  // Side-by-side original document preview (PDF/image) — blob URL, no upload needed
  const [showOriginal, setShowOriginal] = useState(true);
  const [fileUrl, setFileUrl] = useState<string | null>(null);

  // Hover-to-highlight (transient) + click-to-pin (persists) + zoom
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [autoHighlight, setAutoHighlight] = useState(true);
  const [zoom, setZoom] = useState(1);
  const imgPaneRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLImageElement | null>>({});

  // Hover takes precedence for live preview; selection persists when not hovering.
  // Gated by the auto-highlight toggle (the pin is remembered while it's off).
  const activeRow = autoHighlight ? (hoveredRow != null ? hoveredRow : selectedRow) : null;

  useEffect(() => {
    if (!file) { setFileUrl(null); return; }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Scroll the active transaction's location into view on the statement image
  useEffect(() => {
    if (activeRow == null || !preview) return;
    const row = preview.rows[activeRow];
    if (!row || row.yPercent == null) return;
    const img = pageRefs.current[row.page ?? 0];
    const pane = imgPaneRef.current;
    if (!img || !pane) return;
    const imgRect = img.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const target = (imgRect.top - paneRect.top) + row.yPercent * imgRect.height + pane.scrollTop - pane.clientHeight / 2;
    pane.scrollTo({ top: target, behavior: "smooth" });
  }, [activeRow, preview, zoom]);

  // The highlight band for the active row: span down to the next transaction on the
  // same page (covers multi-line rows). Falls back to a small centered strip when the
  // span can't be determined confidently — never worse than the original behavior.
  function activeBand(): { page: number; topPct: number; heightPct: number } | null {
    if (activeRow == null || !preview) return null;
    const rows = preview.rows;
    const row = rows[activeRow];
    if (!row || row.yPercent == null) return null;
    const page = row.page ?? 0;
    const top = row.yPercent;

    let nextY: number | null = null;
    for (let j = activeRow + 1; j < rows.length; j++) {
      const r = rows[j];
      if (r.yPercent == null) continue;
      if ((r.page ?? 0) !== page) break;          // moved to another page
      if (r.yPercent > top) { nextY = r.yPercent; break; }
    }

    // A little air above the date line and below the last description line.
    const AIR_TOP = 0.012;
    const AIR_BOTTOM = 0.008;
    if (nextY != null) {
      const gap = nextY - top;
      if (gap > 0 && gap <= 0.15) {
        return { page, topPct: Math.max(0, top - AIR_TOP), heightPct: gap - AIR_BOTTOM + AIR_TOP };
      }
    }
    // Fallback: small centered band (~2 lines)
    return { page, topPct: Math.max(0, top - 0.022), heightPct: 0.044 };
  }
  const band = activeBand();

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  }, []);

  async function handleParse() {
    if (!file) return;
    setParsing(true);
    setParseError("");

    const fd = new FormData();
    fd.append("file", file);

    try {
      const res = await fetch("/api/parse-preview", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) { setParseError(data.error ?? "Parse failed"); setParsing(false); return; }
      setPreview(data);
      setProfileName(data.account?.accountName ?? data.account?.bank ?? "New Profile");
      setStep("preview");
    } catch (e) {
      setParseError(String(e));
    }
    setParsing(false);
  }

  async function handleConfirm() {
    if (!preview || !file) return;
    setConfirming(true);

    const body: Record<string, unknown> = {
      accountId: preview.accountId,
      filename: file.name,
      rows: preview.rows.filter((r) => !r.parseError),
    };

    if (preview.profileId) {
      body.profileId = preview.profileId;
    } else if (preview.suggestedProfile && saveProfile) {
      body.saveProfile = {
        name: profileName,
        bank: preview.account.bank,
        config: preview.suggestedProfile,
      };
    }

    try {
      const res = await fetch("/api/import-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setParseError(data.error ?? "Import failed"); setConfirming(false); return; }
      setResult(data);
      setStep("done");
    } catch (e) {
      setParseError(String(e));
    }
    setConfirming(false);
  }

  async function forceImportSelected() {
    if (!result || selectedSkipped.size === 0) return;
    setForceImporting(true);
    // Original indices in the order they're sent (ascending) — maps to the API's per-row results.
    const sentIndexes = [...selectedSkipped].sort((a, b) => a - b);
    const rows = sentIndexes.map((i) => result.skippedDetails[i]);
    const res = await fetch("/api/import-force", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batchId: result.batchId, accountId: result.accountId, rows }),
    });
    const data = await res.json() as { imported: number; failed: number; results?: boolean[] };

    // Original indices of rows that FAILED — keep these visible in the skip list.
    const failedOriginal = new Set(
      data.results ? sentIndexes.filter((_, k) => !data.results![k]) : []
    );

    setResult((r) => {
      if (!r) return r;
      const newSkipped = r.skippedDetails.filter((_, i) => !selectedSkipped.has(i) || failedOriginal.has(i));
      return {
        ...r,
        importedRows: r.importedRows + data.imported,
        skippedDetails: newSkipped,
        skippedRows: newSkipped.length,
      };
    });
    setSelectedSkipped(new Set());
    setForceImporting(false);
    if (data.failed > 0) {
      setParseError(`${data.failed} transaction${data.failed !== 1 ? "s" : ""} couldn't be imported and remain in the list below.`);
    }
  }

  function reset() {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setResult(null);
    setParseError("");
    setSaveProfile(true);
    setSelectedSkipped(new Set());
    setHoveredRow(null);
    setSelectedRow(null);
  }

  const validRows = preview?.rows.filter((r) => !r.parseError) ?? [];
  const errorRows = preview?.rows.filter((r) => r.parseError) ?? [];
  const totalExpense = validRows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);
  const totalIncome = validRows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);

  const isPdfFile = !!file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
  const isImageFile = !!file && (file.type.startsWith("image/") || IMAGE_RE.test(file.name));
  // Comparison pane uses rasterized page images: PDF pages from the server,
  // or the locally-loaded blob for direct image uploads.
  const comparisonImages = isImageFile
    ? (fileUrl ? [fileUrl] : [])
    : (preview?.pageImages ?? []);
  const canShowOriginal = step === "preview" && comparisonImages.length > 0;
  const splitView = showOriginal && canShowOriginal;

  return (
    <div style={{ padding: "32px 36px", maxWidth: splitView ? 1280 : 860, margin: "0 auto", transition: "max-width 0.2s" }}>
      {/* Header */}
      <div className="fade-up fade-up-1" style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-syne)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text)" }}>
          Import Transactions
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          Upload a bank CSV, PDF, or screenshot — AI detects the bank, parses the transactions, and categorizes automatically.
        </p>
      </div>

      {/* Stepper */}
      <div className="fade-up fade-up-2" style={{ display: "flex", marginBottom: 32 }}>
        {(["upload", "preview", "done"] as Step[]).map((s, i) => {
          const active = step === s;
          const past = ["upload", "preview", "done"].indexOf(step) > i;
          return (
            <div key={s} style={{ display: "flex", alignItems: "center", flex: i < 2 ? 1 : "unset" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 24, height: 24, borderRadius: "50%",
                  border: `1px solid ${active ? "var(--accent)" : past ? "var(--income)" : "var(--border-2)"}`,
                  background: active ? "var(--accent-dim)" : past ? "var(--income-dim)" : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontFamily: "var(--font-ibm-mono)",
                  color: active ? "var(--accent)" : past ? "var(--income)" : "var(--text-muted)",
                }}>
                  {past ? "✓" : i + 1}
                </div>
                <span style={{ fontSize: 12, color: active ? "var(--text)" : "var(--text-muted)", textTransform: "capitalize" }}>{s}</span>
              </div>
              {i < 2 && <div style={{ flex: 1, height: 1, background: "var(--border)", margin: "0 12px" }} />}
            </div>
          );
        })}
      </div>

      {/* ── STEP: UPLOAD ─────────────────────────────────────── */}
      {step === "upload" && (
        <div className="fade-up fade-up-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragging ? "var(--accent)" : file ? "var(--income)" : "var(--border-2)"}`,
              borderRadius: 10,
              padding: "56px 32px",
              textAlign: "center",
              cursor: "pointer",
              background: dragging ? "var(--accent-dim)" : file ? "var(--income-dim)" : "var(--bg-2)",
              transition: "all 0.2s",
              marginBottom: 24,
            }}
          >
            <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: "none" }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file ? (
              <>
                <div style={{ fontSize: 32, marginBottom: 10 }}>
                  {file.name.toLowerCase().endsWith(".pdf") ? "📑" : IMAGE_RE.test(file.name) ? "🖼️" : "📊"}
                </div>
                <div style={{ fontSize: 14, color: "var(--income)", fontWeight: 600 }}>{file.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                  {(file.size / 1024).toFixed(1)} KB · click to change
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>⬆</div>
                <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 6 }}>
                  Drop your bank statement here
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  CSV, PDF, or image (PNG/JPG) · Maybank, CIMB, Touch &apos;n Go, RHB, Public Bank…
                </div>
              </>
            )}
          </div>

          {parseError && (
            <div style={{ padding: "12px 16px", background: "var(--expense-dim)", border: "1px solid #f8717133", borderRadius: 6, color: "var(--expense)", fontSize: 13, marginBottom: 16 }}>
              {parseError}
            </div>
          )}

          <button onClick={handleParse} disabled={!file || parsing} style={primaryBtn(!file || parsing)}>
            {parsing ? "Detecting & parsing…" : "Parse File →"}
          </button>
          {!file && !parsing && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
              Drop or select a file above to continue.
            </p>
          )}
        </div>
      )}

      {/* ── STEP: PREVIEW ────────────────────────────────────── */}
      {step === "preview" && preview && (
        <div className="fade-up fade-up-2">
          {/* Detected bank pill */}
          <div style={{
            background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8,
            padding: "16px 20px", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: "var(--accent-dim)", border: "1px solid #c9a84c33",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 18,
              }}>
                🏦
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  {preview.account.accountName}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {preview.account.bank}
                  {preview.account.accountType !== "unknown" ? ` · ${preview.account.accountType.replace("_", " ")}` : ""}
                  {preview.account.accountNumber ? ` · ****${preview.account.accountNumber.replace(/\D/g, "").slice(-4)}` : ""}
                  {" · "}{preview.accountIsNew ? "new account created" : "matched existing account"}
                </div>
              </div>
            </div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 24 }}>
              <Stat label="Rows" value={String(validRows.length)} />
              <Stat label="Income" value={formatCurrency(totalIncome, "MYR")} color="var(--income)" />
              <Stat label="Expenses" value={formatCurrency(Math.abs(totalExpense), "MYR")} color="var(--expense)" />
              {errorRows.length > 0 && <Stat label="Errors" value={String(errorRows.length)} color="var(--expense)" />}
            </div>

            <span style={{
              fontSize: 11, padding: "3px 10px", borderRadius: 3,
              background: preview.type === "pdf" ? "#6366f122" : preview.type === "image" ? "#f59e0b22" : "#14b8a622",
              color: preview.type === "pdf" ? "#818cf8" : preview.type === "image" ? "#fbbf24" : "#2dd4bf",
            }}>
              {preview.type.toUpperCase()}
            </span>
          </div>

          {/* Truncation warning — we couldn't scan the whole document */}
          {preview.truncated && (
            <div style={{ background: "var(--expense-dim)", border: "1px solid #f8717155", borderRadius: 8, padding: "12px 18px", marginBottom: 14, display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--expense)", marginBottom: 2 }}>
                  This statement may be incomplete
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {preview.truncationNote ?? "The document was too large to scan in full — some transactions may be missing."}
                  {" "}Consider splitting it into smaller files and importing each, then check the totals against your statement.
                </div>
              </div>
            </div>
          )}

          {/* Save profile prompt (CSV, new layout) */}
          {preview.type === "csv" && preview.suggestedProfile && !preview.profileId && (
            <div style={{
              background: "var(--accent-dim)", border: "1px solid #c9a84c33",
              borderRadius: 8, padding: "14px 20px", marginBottom: 14,
              display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 2 }}>
                  New CSV layout detected
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Save as a profile so future {preview.account.bank} imports are instant.
                </div>
              </div>
              <input type="text" value={profileName} onChange={(e) => setProfileName(e.target.value)}
                style={{ ...inputStyle, width: 200 }} placeholder="Profile name" />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text)", cursor: "pointer", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
                Save profile
              </label>
            </div>
          )}

          {/* Collapsed: the real PDF document (for zoom / scroll / verifying the source) */}
          {isPdfFile && fileUrl && (
            <details style={{ marginBottom: 12, background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              <summary style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>
                📄 View original PDF — {file?.name}
              </summary>
              <iframe src={fileUrl} title="Original PDF" style={{ width: "100%", height: 600, border: "none", borderTop: "1px solid var(--border)", background: "#fff", display: "block" }} />
            </details>
          )}

          {/* Toggle + zoom controls */}
          {canShowOriginal && (
            <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, marginBottom: 10 }}>
              {splitView && (
                <>
                  {preview.positionAccuracy && preview.positionAccuracy !== "none" && (
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
                      <input type="checkbox" checked={autoHighlight} onChange={(e) => setAutoHighlight(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
                      Auto-highlight &amp; scroll
                    </label>
                  )}
                  {autoHighlight && preview.positionAccuracy === "exact" && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Hover to locate · click to pin{selectedRow != null ? " · click again to unpin" : ""}</span>
                  )}
                  {autoHighlight && preview.positionAccuracy === "approximate" && (
                    <span style={{ fontSize: 11, color: "#d99a3a" }} title="Positions are estimated by the AI from the image, not read from a text layer — they may be off.">≈ positions are approximate</span>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
                    <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} style={zoomBtn} title="Zoom out">−</button>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
                    <button onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} style={zoomBtn} title="Zoom in">+</button>
                    {zoom !== 1 && <button onClick={() => setZoom(1)} style={{ ...zoomBtn, width: "auto", padding: "0 8px", fontSize: 11 }} title="Reset zoom">Reset</button>}
                  </div>
                </>
              )}
              <button onClick={() => setShowOriginal((s) => !s)} style={ghostBtn}>
                {showOriginal ? "Hide comparison" : "Compare side by side ⇄"}
              </button>
            </div>
          )}

          {/* Rendered pages + parsed transactions (side by side when enabled) */}
          <div style={{
            display: splitView ? "grid" : "block",
            gridTemplateColumns: splitView ? "minmax(0, 1fr) minmax(0, 1fr)" : undefined,
            gap: 14, marginBottom: 20, alignItems: "start",
          }}>
            {/* Rendered document pane */}
            {splitView && (
              <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", position: "sticky", top: 0 }}>
                <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Statement — {file?.name}
                </div>
                <div ref={imgPaneRef} style={{ maxHeight: 600, overflow: "auto", background: "#fff" }}>
                  <div style={{ width: `${zoom * 100}%`, transition: "width 0.15s" }}>
                    {comparisonImages.map((src, i) => {
                      const showBand = !!band && band.page === i;
                      // Pinned (blue) whenever the active row IS the selected row —
                      // including while hovering it. Gold preview is only for hovering
                      // a different, not-yet-pinned row.
                      const pinned = activeRow != null && activeRow === selectedRow;
                      return (
                        <div key={i} style={{ position: "relative" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            ref={(el) => { pageRefs.current[i] = el; }}
                            src={src}
                            alt={`Statement page ${i + 1}`}
                            style={{ width: "100%", display: "block", borderBottom: i < comparisonImages.length - 1 ? "1px solid #ddd" : "none" }}
                          />
                          {showBand && (
                            <div style={{
                              position: "absolute", left: 0, right: 0,
                              top: `${band!.topPct * 100}%`, height: `${band!.heightPct * 100}%`,
                              borderRadius: 2,
                              pointerEvents: "none", transition: "top 0.15s, height 0.15s",
                              ...(pinned
                                ? {
                                    // Pinned — clean solid blue outline
                                    background: "rgba(74,144,226,0.07)",
                                    border: "1px solid #2f6fd0",
                                  }
                                : {
                                    // Hover preview — dashed gold outline
                                    background: "rgba(201,168,76,0.07)",
                                    border: "1px dashed #c9a84c",
                                  }),
                            }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Parsed transactions table */}
            <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ maxHeight: splitView ? 600 : 420, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg-2)", zIndex: 1 }}>
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      {["Date", "Description", "Amount"].map((h) => (
                        <th key={h} style={{
                          padding: "10px 20px", textAlign: h === "Amount" ? "right" : "left",
                          fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase",
                          color: "var(--text-muted)", fontWeight: 500,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, i) => {
                      const isIncome = row.amount > 0;
                      const hasError = !!row.parseError;
                      const locatable = splitView && autoHighlight && row.yPercent != null;
                      return (
                        <tr key={i}
                          onMouseEnter={() => { if (locatable) setHoveredRow(i); }}
                          onMouseLeave={() => setHoveredRow((h) => (h === i ? null : h))}
                          onClick={() => { if (locatable) setSelectedRow((s) => (s === i ? null : i)); }}
                          style={{
                            borderBottom: "1px solid var(--border)",
                            background: selectedRow === i && locatable
                              ? "rgba(74,144,226,0.14)"             // blue pinned — wins even while hovered
                              : hoveredRow === i && locatable
                                ? "var(--accent-dim)"               // gold hover — only for unpinned rows
                                : hasError ? "var(--expense-dim)" : "transparent",
                            borderLeft: selectedRow === i && locatable ? "3px solid #2f6fd0" : "2px solid transparent",
                            cursor: locatable ? "pointer" : "default",
                            transition: "background 0.1s",
                          }}>
                          <td style={{ padding: "9px 20px", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                            {row.date || "—"}{row.time ? ` ${row.time}` : ""}
                          </td>
                          <td style={{ padding: "9px 20px", fontSize: 13, color: hasError ? "var(--expense)" : "var(--text)", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {hasError ? `⚠ ${row.parseError}` : row.description}
                          </td>
                          <td style={{ padding: "9px 20px", textAlign: "right", fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500, color: hasError ? "var(--text-muted)" : isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap" }}>
                            {hasError ? "—" : `${isIncome ? "+" : ""}${formatCurrency(row.amount, "MYR")}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {parseError && (
            <div style={{ padding: "12px 16px", background: "var(--expense-dim)", border: "1px solid #f8717133", borderRadius: 6, color: "var(--expense)", fontSize: 13, marginBottom: 16 }}>
              {parseError}
            </div>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button onClick={reset} style={ghostBtn}>← Back</button>
            <button onClick={handleConfirm} disabled={confirming || validRows.length === 0} style={primaryBtn(confirming || validRows.length === 0)}>
              {confirming ? "Importing…" : `Import ${validRows.length} transactions`}
            </button>
          </div>
        </div>
      )}

      {/* ── STEP: DONE ───────────────────────────────────────── */}
      {step === "done" && result && (
        <div className="fade-up fade-up-2" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {parseError && (
            <div style={{ padding: "12px 16px", background: "var(--expense-dim)", border: "1px solid #f8717133", borderRadius: 6, color: "var(--expense)", fontSize: 13 }}>
              {parseError}
            </div>
          )}
          {/* Summary */}
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "32px", textAlign: "center" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>✓</div>
            <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 20, fontWeight: 700, color: "var(--income)", marginBottom: 20 }}>
              Import complete
            </h2>
            <div style={{ display: "flex", gap: 40, justifyContent: "center", flexWrap: "wrap" }}>
              <Stat label="Imported" value={String(result.importedRows)} color="var(--income)" />
              {result.skippedRows > 0 && <Stat label="Already existed" value={String(result.skippedRows)} color="var(--accent)" />}
              {result.errorRows > 0 && <Stat label="Errors" value={String(result.errorRows)} color="var(--expense)" />}
            </div>
            <div style={{ marginTop: 28, display: "flex", gap: 12, justifyContent: "center" }}>
              <button onClick={reset} style={ghostBtn}>Import another</button>
              <button onClick={() => router.push("/transactions")} style={primaryBtn(false)}>
                View transactions →
              </button>
            </div>
          </div>

          {/* Skipped rows review */}
          {result.skippedDetails.length > 0 && (
            <div style={{ background: "var(--bg-2)", border: "1px solid #c9a84c44", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: "1px solid #c9a84c22", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>
                    {result.skippedDetails.length} transaction{result.skippedDetails.length !== 1 ? "s" : ""} already existed
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>
                    — select any to import anyway
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => setSelectedSkipped(
                      selectedSkipped.size === result.skippedDetails.length
                        ? new Set()
                        : new Set(result.skippedDetails.map((_, i) => i))
                    )}
                    style={{ ...ghostBtn, padding: "5px 12px", fontSize: 12 }}
                  >
                    {selectedSkipped.size === result.skippedDetails.length ? "Deselect all" : "Select all"}
                  </button>
                  {selectedSkipped.size > 0 && (
                    <button
                      onClick={forceImportSelected}
                      disabled={forceImporting}
                      style={{ ...primaryBtn(forceImporting), padding: "5px 16px", fontSize: 12 }}
                    >
                      {forceImporting ? "Importing…" : `Import selected (${selectedSkipped.size})`}
                    </button>
                  )}
                </div>
              </div>

              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {result.skippedDetails.map((row, i) => {
                  const amt = row.amount;
                  const isIncome = amt > 0;
                  const checked = selectedSkipped.has(i);
                  return (
                    <label key={i} style={{
                      display: "flex", alignItems: "center", gap: 14,
                      padding: "10px 20px",
                      borderBottom: "1px solid var(--border)",
                      cursor: "pointer",
                      background: checked ? "var(--accent-dim)" : "transparent",
                      transition: "background 0.1s",
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setSelectedSkipped((prev) => {
                          const next = new Set(prev);
                          next.has(i) ? next.delete(i) : next.add(i);
                          return next;
                        })}
                        style={{ accentColor: "var(--accent)", width: 14, height: 14, flexShrink: 0 }}
                      />
                      <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                        {row.date}
                      </span>
                      <span style={{ flex: 1, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {row.description}
                      </span>
                      <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500, color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap" }}>
                        {isIncome ? "+" : ""}{formatCurrency(amt, "MYR")}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontFamily: "var(--font-ibm-mono)", fontWeight: 600, color: color ?? "var(--text)" }}>{value}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-3)",
  border: "1px solid var(--border-2)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 13,
  padding: "8px 12px",
  outline: "none",
  fontFamily: "inherit",
};

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "10px 24px", borderRadius: 6, border: "none",
    background: disabled ? "var(--border-2)" : "var(--accent)",
    color: disabled ? "var(--text-muted)" : "#000",
    fontSize: 13, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "opacity 0.15s", fontFamily: "inherit",
  };
}

const ghostBtn: React.CSSProperties = {
  padding: "10px 20px", borderRadius: 6,
  border: "1px solid var(--border-2)", background: "transparent",
  color: "var(--text-muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};

const zoomBtn: React.CSSProperties = {
  width: 26, height: 26, borderRadius: 5,
  border: "1px solid var(--border-2)", background: "var(--bg-3)",
  color: "var(--text)", fontSize: 14, cursor: "pointer",
  display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit",
};
