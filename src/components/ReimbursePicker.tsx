"use client";

import { useEffect, useState } from "react";
import { formatCurrency, formatTxDate } from "@/lib/format";

export interface ReimbursableTx {
  id: number;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  reimbursementForId?: number | null;
}

interface Candidate {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  categoryName: string | null;
  categoryColor: string | null;
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 5,
  color: "var(--text)", fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit",
};

/**
 * Modal that links a repayment to the expense it paid back. Presentational:
 * it fetches candidate expenses and calls onPick(expenseId | null); the parent
 * performs the actual POST + refresh.
 */
export default function ReimbursePicker({ repayment, busy, onPick, onClose }: {
  repayment: ReimbursableTx;
  busy?: boolean;
  onPick: (expenseId: number | null) => void;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch(`/api/transactions/${repayment.id}/reimburse`)
      .then((r) => r.json())
      .then((d) => { setCandidates(Array.isArray(d) ? d : []); setLoading(false); });
  }, [repayment.id]);

  const repaymentAmt = parseFloat(repayment.amount);
  const filtered = candidates.filter((c) => (c.merchantNormalized || c.description).toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000088", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }} onClick={onClose}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10, padding: 24, width: 480, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Mark as repayment</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
          Link <strong style={{ color: "var(--text)" }}>{repayment.merchantNormalized || repayment.description}</strong> ({repaymentAmt > 0 ? "+" : ""}{formatCurrency(repaymentAmt, "MYR")}) to the expense it paid you back for. It’ll be netted into that expense (so your share is correct) and won’t count as income.
        </p>

        {repayment.reimbursementForId != null && (
          <button onClick={() => onPick(null)} disabled={busy} style={{ width: "100%", marginBottom: 12, padding: "8px 12px", borderRadius: 6, border: "1px solid #f8717133", background: "var(--expense-dim)", color: "var(--expense)", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            Remove current repayment link
          </button>
        )}

        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search expenses…" style={{ ...inputStyle, width: "100%", marginBottom: 10 }} />

        <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {loading ? (
            [...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 40, borderRadius: 6 }} />)
          ) : filtered.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No nearby expenses (±21 days) to link to.</div>
          ) : filtered.map((c) => (
            <button key={c.id} onClick={() => onPick(c.id)} disabled={busy}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, border: "1px solid transparent", background: "var(--bg-3)", cursor: "pointer", textAlign: "left" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}>
              <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>{formatTxDate(c.postedAt)}</span>
              <span style={{ flex: 1, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.merchantNormalized || c.description}
                {c.categoryName && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 11 }}>· {c.categoryName}</span>}
              </span>
              <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 13, color: "var(--expense)", whiteSpace: "nowrap" }}>{formatCurrency(parseFloat(c.amount), "MYR")}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
