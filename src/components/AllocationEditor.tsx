"use client";

import { useEffect, useMemo, useState } from "react";
import { formatCurrency, formatTxDate } from "@/lib/format";

export interface RepaymentRef {
  id: number;
  description: string;
  merchantNormalized: string | null;
  amount: string; // positive (income)
}

interface Candidate {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  categoryName: string | null;
  categoryColor: string | null;
  expenseFull: number;
  repaidByOthers: number;
  currentFromThis: number;
  remainingNeed: number;
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 5,
  color: "var(--text)", fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Allocate one incoming repayment across one or more expenses. Per-expense the user
 * sets "covers full" or a partial amount; a live readout shows how much of the
 * repayment is still unallocated (which stays as income). Saves the whole set at once.
 */
export default function AllocationEditor({ repayment, onClose, onSaved }: {
  repayment: RepaymentRef;
  onClose: () => void;
  onSaved: () => void;
}) {
  const repaymentAmount = round2(Math.abs(parseFloat(repayment.amount)));
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  // expenseId -> allocated amount (string for editing)
  const [alloc, setAlloc] = useState<Record<number, string>>({});

  useEffect(() => {
    fetch(`/api/transactions/${repayment.id}/reimburse`)
      .then((r) => r.json())
      .then((d) => {
        const cands: Candidate[] = Array.isArray(d?.candidates) ? d.candidates : [];
        setCandidates(cands);
        const init: Record<number, string> = {};
        for (const c of cands) if (c.currentFromThis > 0) init[c.id] = c.currentFromThis.toFixed(2);
        setAlloc(init);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [repayment.id]);

  const allocatedTotal = useMemo(
    () => round2(Object.values(alloc).reduce((s, v) => s + (parseFloat(v) || 0), 0)),
    [alloc]
  );
  const remaining = round2(repaymentAmount - allocatedTotal);
  const over = remaining < -0.001;

  function setAmount(id: number, value: string) {
    setAlloc((prev) => {
      const next = { ...prev };
      if (value === "" ) { delete next[id]; return next; }
      next[id] = value;
      return next;
    });
  }

  // "Full" = cover this expense's remaining need, capped by what's left of the repayment.
  function coverFull(c: Candidate) {
    const current = parseFloat(alloc[c.id] || "0") || 0;
    const otherAllocated = allocatedTotal - current;
    const cap = round2(repaymentAmount - otherAllocated);
    const target = round2(Math.min(c.remainingNeed, cap));
    if (target <= 0) return;
    setAmount(c.id, target.toFixed(2));
  }

  async function save() {
    setSaving(true);
    const allocations = Object.entries(alloc)
      .map(([expenseId, v]) => ({ expenseId: Number(expenseId), amount: round2(parseFloat(v) || 0) }))
      .filter((a) => a.amount > 0);
    const res = await fetch(`/api/transactions/${repayment.id}/reimburse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocations }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error ?? "Could not save allocations");
      return;
    }
    onSaved();
  }

  const filtered = candidates.filter((c) => (c.merchantNormalized || c.description).toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000088", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }} onClick={onClose}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10, padding: 24, width: 560, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Allocate repayment</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
          Split <strong style={{ color: "var(--text)" }}>{repayment.merchantNormalized || repayment.description}</strong> (+{formatCurrency(repaymentAmount, "MYR")}) across the expenses it paid you back for. Each expense can be covered fully or partially. Anything left over stays as income.
        </p>

        {/* Live running balance */}
        <div style={{ display: "flex", gap: 16, padding: "10px 14px", borderRadius: 8, background: "var(--bg-3)", border: `1px solid ${over ? "#f8717155" : "var(--border-2)"}`, marginBottom: 12, fontFamily: "var(--font-ibm-mono)", fontSize: 13 }}>
          <span style={{ color: "var(--text-muted)" }}>Allocated <strong style={{ color: "var(--text)" }}>{formatCurrency(allocatedTotal, "MYR")}</strong> of {formatCurrency(repaymentAmount, "MYR")}</span>
          <span style={{ marginLeft: "auto", color: over ? "var(--expense)" : remaining > 0.001 ? "var(--income)" : "var(--text-muted)" }}>
            {over ? `Over by ${formatCurrency(-remaining, "MYR")}` : remaining > 0.001 ? `${formatCurrency(remaining, "MYR")} left → income` : "Fully allocated"}
          </span>
        </div>

        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search expenses…" style={{ ...inputStyle, width: "100%", marginBottom: 10 }} />

        <div style={{ maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {loading ? (
            [...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 48, borderRadius: 6 }} />)
          ) : filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No nearby expenses (±21 days) to link to.</div>
          ) : filtered.map((c) => {
            const val = alloc[c.id] ?? "";
            const active = (parseFloat(val) || 0) > 0;
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, border: `1px solid ${active ? "var(--accent)" : "var(--border-2)"}`, background: "var(--bg-3)" }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap", width: 56 }}>{formatTxDate(c.postedAt)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.merchantNormalized || c.description}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {formatCurrency(c.expenseFull, "MYR")} full
                    {c.repaidByOthers > 0.001 && ` · ${formatCurrency(c.repaidByOthers, "MYR")} repaid by others`}
                  </div>
                </div>
                <button onClick={() => coverFull(c)} title="Cover what's still owed on this expense" style={{ fontSize: 11, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border-2)", background: "transparent", color: "var(--accent)", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>Full</button>
                <input
                  type="number" step="0.01" min="0" value={val}
                  onChange={(e) => setAmount(c.id, e.target.value)}
                  placeholder="0.00"
                  style={{ ...inputStyle, width: 88, textAlign: "right", padding: "6px 8px", fontFamily: "var(--font-ibm-mono)" }}
                />
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
          <button onClick={save} disabled={saving || over} style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: over ? "var(--border-2)" : "var(--accent)", color: over ? "var(--text-muted)" : "#000", fontSize: 13, fontWeight: 600, cursor: saving || over ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
            {saving ? "Saving…" : "Save allocations"}
          </button>
        </div>
      </div>
    </div>
  );
}
