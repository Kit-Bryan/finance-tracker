"use client";

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/format";
import CategoryCombobox, { Category, CategoryValue } from "./CategoryCombobox";
import SourceViewerModal from "./SourceViewerModal";

interface ReimbursementCandidate {
  id: number;
  description: string;
  amount: number;
  date: string;
}

interface FlagData {
  reimbursementIds?: number[];
  totalReimbursed?: number;
  yourShare?: number;
  expenseAmount?: number;
  candidates?: ReimbursementCandidate[];
}

interface Flag {
  id: number;
  transactionId: number;
  type: "reimbursement" | "low_confidence";
  severity: "info" | "warning";
  reason: string;
  data: FlagData | null;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string | null;
  // Source trace-back
  batchId: number | null;
  batchStoredFile: string | null;
  sourcePage: number | null;
  sourceYPercent: number | null;
}

export default function NeedsAttention() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [selections, setSelections] = useState<Record<number, CategoryValue | null>>({});
  const [expanded, setExpanded] = useState(true);
  const [sourceFor, setSourceFor] = useState<Flag | null>(null);

  async function load() {
    // Scan first (idempotent) so existing data surfaces, then fetch
    await fetch("/api/flags/scan", { method: "POST" }).catch(() => {});
    const [f, cats] = await Promise.all([
      fetch("/api/flags").then((r) => r.json()),
      fetch("/api/categories").then((r) => r.json()),
    ]);
    setFlags(Array.isArray(f) ? f : []);
    setCategories(cats);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function dismiss(flagId: number) {
    setBusy(flagId);
    await fetch(`/api/flags/${flagId}/dismiss`, { method: "POST" });
    setFlags((prev) => prev.filter((f) => f.id !== flagId));
    setBusy(null);
  }

  async function linkReimbursement(flag: Flag) {
    setBusy(flag.id);
    await fetch(`/api/flags/${flag.id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    setFlags((prev) => prev.filter((f) => f.id !== flag.id));
    setBusy(null);
  }

  async function categorize(flag: Flag) {
    const cat = selections[flag.id];
    if (!cat) return;
    setBusy(flag.id);
    await fetch(`/api/flags/${flag.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: cat.id }),
    });
    setFlags((prev) => prev.filter((f) => f.id !== flag.id));
    setBusy(null);
  }

  if (loading || flags.length === 0) return null;

  const reimbursements = flags.filter((f) => f.type === "reimbursement");
  const lowConfidence = flags.filter((f) => f.type === "low_confidence");

  return (
    <div className="fade-up fade-up-1" style={{ background: "#1a1408", border: "1px solid #c9a84c44", borderRadius: 8, marginBottom: 24, overflow: "hidden" }}>
      {/* Header */}
      <button onClick={() => setExpanded((e) => !e)} style={{ width: "100%", padding: "12px 20px", background: "none", border: "none", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 22, height: 22, borderRadius: "50%", background: "var(--accent)", color: "#000", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, fontFamily: "var(--font-ibm-mono)" }}>{flags.length}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>Needs your attention</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            — {reimbursements.length > 0 && `${reimbursements.length} possible reimbursement${reimbursements.length !== 1 ? "s" : ""}`}
            {reimbursements.length > 0 && lowConfidence.length > 0 && ", "}
            {lowConfidence.length > 0 && `${lowConfidence.length} to review`}
          </span>
        </div>
        <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid #c9a84c22" }}>
          {/* Reimbursement cards */}
          {reimbursements.map((flag) => {
            const d = flag.data ?? {};
            const name = flag.merchantNormalized || flag.description;
            return (
              <div key={flag.id} style={{ padding: "16px 20px", borderBottom: "1px solid #c9a84c18" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "var(--accent-dim)", color: "var(--accent)", fontFamily: "var(--font-ibm-mono)" }}>REIMBURSEMENT</span>
                  <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{name}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto", fontFamily: "var(--font-ibm-mono)" }}>
                    {new Date(flag.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short" })}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>{flag.reason}</div>

                {/* Breakdown */}
                <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 10, paddingLeft: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span style={{ color: "var(--text-muted)" }}>Paid</span>
                    <span style={{ fontFamily: "var(--font-ibm-mono)", color: "var(--expense)" }}>{formatCurrency(d.expenseAmount ?? parseFloat(flag.amount), "MYR")}</span>
                  </div>
                  {d.candidates?.map((c) => (
                    <div key={c.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>↩ {c.description}</span>
                      <span style={{ fontFamily: "var(--font-ibm-mono)", color: "var(--income)" }}>+{formatCurrency(c.amount, "MYR")}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, paddingTop: 5, marginTop: 2, borderTop: "1px solid #c9a84c22" }}>
                    <span style={{ color: "var(--text)", fontWeight: 600 }}>Your share</span>
                    <span style={{ fontFamily: "var(--font-ibm-mono)", fontWeight: 600, color: (d.yourShare ?? 0) < 0 ? "var(--expense)" : "var(--income)" }}>{formatCurrency(d.yourShare ?? 0, "MYR")}</span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  {flag.batchStoredFile && (
                    <button onClick={() => setSourceFor(flag)} title="See where this appears in the original statement" style={ghostBtn}>📄</button>
                  )}
                  <button onClick={() => linkReimbursement(flag)} disabled={busy === flag.id} style={primaryBtn(busy === flag.id)}>
                    {busy === flag.id ? "Linking…" : "Link reimbursements"}
                  </button>
                  <button onClick={() => dismiss(flag.id)} disabled={busy === flag.id} style={ghostBtn}>Not a reimbursement</button>
                </div>
              </div>
            );
          })}

          {/* Low-confidence cards */}
          {lowConfidence.map((flag) => {
            const amt = parseFloat(flag.amount);
            const isIncome = amt > 0;
            const name = flag.merchantNormalized || flag.description;
            const selected = selections[flag.id] ?? null;
            return (
              <div key={flag.id} style={{ padding: "14px 20px", borderBottom: "1px solid #c9a84c18", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "var(--expense-dim)", color: "var(--expense)", fontFamily: "var(--font-ibm-mono)", flexShrink: 0 }}>REVIEW</span>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 13, color: "var(--text)" }}>{name}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                    {new Date(flag.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short" })}
                    {flag.categoryName ? ` · currently ${flag.categoryName}` : " · uncategorized"}
                  </div>
                </div>
                <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500, color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap" }}>
                  {isIncome ? "+" : ""}{formatCurrency(amt, "MYR")}
                </span>
                <div style={{ minWidth: 180 }}>
                  <CategoryCombobox
                    value={selected}
                    onChange={(cat) => setSelections((s) => ({ ...s, [flag.id]: cat }))}
                    categories={categories}
                    onCategoryCreated={(cat) => setCategories((prev) => [...prev, cat])}
                    placeholder="Choose category…"
                  />
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {flag.batchStoredFile && (
                    <button onClick={() => setSourceFor(flag)} title="See where this appears in the original statement" style={ghostBtn}>📄</button>
                  )}
                  <button onClick={() => categorize(flag)} disabled={busy === flag.id || !selected} style={primaryBtn(busy === flag.id || !selected)}>
                    {busy === flag.id ? "…" : "Confirm"}
                  </button>
                  <button onClick={() => dismiss(flag.id)} disabled={busy === flag.id} style={ghostBtn}>Dismiss</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sourceFor && sourceFor.batchId != null && (
        <SourceViewerModal
          batchId={sourceFor.batchId}
          page={sourceFor.sourcePage}
          yPercent={sourceFor.sourceYPercent}
          label={`${sourceFor.merchantNormalized || sourceFor.description} · ${formatCurrency(parseFloat(sourceFor.amount), "MYR")}`}
          onClose={() => setSourceFor(null)}
        />
      )}
    </div>
  );
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 14px", borderRadius: 5, border: "none",
    background: disabled ? "var(--border-2)" : "var(--accent)",
    color: disabled ? "var(--text-muted)" : "#000",
    fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
  };
}

const ghostBtn: React.CSSProperties = {
  padding: "6px 12px", borderRadius: 5, border: "1px solid var(--border-2)",
  background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
};
