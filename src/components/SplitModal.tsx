"use client";

import { useState } from "react";
import CategoryCombobox, { Category, CategoryValue } from "./CategoryCombobox";
import { formatCurrency } from "@/lib/format";

export interface SplittableTx {
  id: number;
  amount: string;
  description: string;
  merchantNormalized: string | null;
}

interface Row { description: string; amount: string; category: CategoryValue | null; }

const inputStyle: React.CSSProperties = {
  background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 5,
  color: "var(--text)", fontSize: 13, padding: "8px 10px", outline: "none", fontFamily: "inherit",
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Split one transaction into several that sum to the original (e.g. separate a shared
 * portion from a personal one so only the shared part gets a repayment linked). The
 * original is soft-deleted; the parts are created as new transactions.
 */
export default function SplitModal({ transaction: tx, categories, onClose, onSaved, onCategoryCreated }: {
  transaction: SplittableTx;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
  onCategoryCreated: (c: Category) => void;
}) {
  const original = parseFloat(tx.amount);
  const sign = original < 0 ? -1 : 1;
  const originalAbs = round2(Math.abs(original));
  const kind = original < 0 ? "expense" : "income";

  const [rows, setRows] = useState<Row[]>([
    { description: tx.merchantNormalized || tx.description, amount: "", category: null },
    { description: tx.merchantNormalized || tx.description, amount: "", category: null },
  ]);
  const [saving, setSaving] = useState(false);

  const allocated = round2(rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
  const remaining = round2(originalAbs - allocated);
  const balanced = Math.abs(remaining) <= 0.02;

  function update(i: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function addRow() { setRows((prev) => [...prev, { description: tx.merchantNormalized || tx.description, amount: "", category: null }]); }
  function removeRow(i: number) { setRows((prev) => prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev); }
  // Put whatever is left into this row.
  function fillRest(i: number) {
    const others = round2(rows.reduce((s, r, idx) => idx === i ? s : s + (parseFloat(r.amount) || 0), 0));
    const rest = round2(originalAbs - others);
    if (rest > 0) update(i, { amount: rest.toFixed(2) });
  }

  async function save() {
    if (!balanced) return;
    if (rows.some((r) => !r.description.trim() || !(parseFloat(r.amount) > 0))) {
      alert("Each split needs a description and an amount greater than 0.");
      return;
    }
    setSaving(true);
    const splits = rows.map((r) => ({
      amount: round2(sign * Math.abs(parseFloat(r.amount))),
      description: r.description.trim(),
      categoryId: r.category?.id ?? null,
    }));
    const res = await fetch(`/api/transactions/${tx.id}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ splits }),
    });
    setSaving(false);
    if (!res.ok) { const d = await res.json().catch(() => ({})); alert(d.error ?? "Could not split"); return; }
    onSaved();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000088", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 210 }} onClick={onClose}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10, padding: 24, width: 600, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Split transaction</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
          Split <strong style={{ color: "var(--text)" }}>{tx.merchantNormalized || tx.description}</strong> ({kind} of {formatCurrency(originalAbs, "MYR")}) into parts that sum to the original. The original is replaced by these.
        </p>

        <div style={{ display: "flex", gap: 16, padding: "10px 14px", borderRadius: 8, background: "var(--bg-3)", border: `1px solid ${balanced ? "var(--border-2)" : "#f8717155"}`, marginBottom: 12, fontFamily: "var(--font-ibm-mono)", fontSize: 13 }}>
          <span style={{ color: "var(--text-muted)" }}>Allocated <strong style={{ color: "var(--text)" }}>{formatCurrency(allocated, "MYR")}</strong> of {formatCurrency(originalAbs, "MYR")}</span>
          <span style={{ marginLeft: "auto", color: balanced ? "var(--income)" : "var(--expense)" }}>
            {balanced ? "Balanced ✓" : remaining > 0 ? `${formatCurrency(remaining, "MYR")} left` : `Over by ${formatCurrency(-remaining, "MYR")}`}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 320, overflowY: "auto" }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input value={r.description} onChange={(e) => update(i, { description: e.target.value })} placeholder="Description" style={{ ...inputStyle, flex: 1 }} />
              <div style={{ width: 150 }}>
                <CategoryCombobox value={r.category} onChange={(c) => update(i, { category: c })} categories={categories} onCategoryCreated={onCategoryCreated} placeholder="Category" />
              </div>
              <input type="number" step="0.01" min="0" value={r.amount} onChange={(e) => update(i, { amount: e.target.value })} placeholder="0.00" style={{ ...inputStyle, width: 90, textAlign: "right", fontFamily: "var(--font-ibm-mono)" }} />
              <button onClick={() => fillRest(i)} title="Fill with the remaining amount" style={{ fontSize: 11, padding: "6px 8px", borderRadius: 4, border: "1px solid var(--border-2)", background: "transparent", color: "var(--accent)", cursor: "pointer", fontFamily: "inherit" }}>rest</button>
              <button onClick={() => removeRow(i)} disabled={rows.length <= 2} title="Remove" style={{ fontSize: 14, padding: "4px 8px", borderRadius: 4, border: "none", background: "transparent", color: rows.length <= 2 ? "var(--text-dim)" : "var(--expense)", cursor: rows.length <= 2 ? "not-allowed" : "pointer" }}>✕</button>
            </div>
          ))}
        </div>

        <button onClick={addRow} style={{ marginTop: 10, fontSize: 12, padding: "6px 12px", borderRadius: 5, border: "1px dashed var(--border-2)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontFamily: "inherit" }}>+ Add split</button>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={save} disabled={saving || !balanced} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: balanced ? "var(--accent)" : "var(--border-2)", color: balanced ? "#000" : "var(--text-muted)", fontSize: 13, fontWeight: 600, cursor: saving || !balanced ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {saving ? "Splitting…" : "Split"}
          </button>
        </div>
      </div>
    </div>
  );
}
