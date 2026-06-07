"use client";

import { useState, useEffect } from "react";
import CategoryCombobox, { Category, CategoryValue } from "./CategoryCombobox";
import { formatCurrency } from "@/lib/format";

export interface DetailTransaction {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  currency: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  parentCategoryName?: string | null;
  accountName: string | null;
  notes: string | null;
  hidden: boolean;
  allocatedIn: string | null;   // repayments applied TO this expense
  allocatedOut: string | null;  // how much of this income row is applied to expenses
}

interface AllocOut { allocationId: number; expenseId: number; amount: string; name: string | null; postedAt: string; txAmount: string; }
interface AllocIn { allocationId: number; repaymentId: number; amount: string; name: string | null; postedAt: string; txAmount: string; }

interface Props {
  transaction: DetailTransaction | null;
  categories: Category[];
  refreshKey?: number;   // bump to force the allocation lists to refetch
  onClose: () => void;
  onSaved: (updates: Partial<DetailTransaction>) => void;
  onCategoryCreated: (cat: Category) => void;
  // Hub actions — handled by the parent
  onAskAI: (tx: DetailTransaction) => void;
  onToggleHidden: (tx: DetailTransaction) => void;
  onDelete: (tx: DetailTransaction) => void;
  onAllocate: (tx: DetailTransaction) => void;
  onSplit: (tx: DetailTransaction) => void;
  onOpenLinked: (id: number) => void;
  hidingBusy?: boolean;
}

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
const round2 = (n: number) => Math.round(n * 100) / 100;

export default function TransactionEditPanel({
  transaction: tx, categories, refreshKey, onClose, onSaved, onCategoryCreated,
  onAskAI, onToggleHidden, onDelete, onAllocate, onSplit, onOpenLinked, hidingBusy,
}: Props) {
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<CategoryValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [generatingNote, setGeneratingNote] = useState(false);
  const [allocOut, setAllocOut] = useState<AllocOut[]>([]);
  const [allocIn, setAllocIn] = useState<AllocIn[]>([]);

  useEffect(() => {
    if (!tx) return;
    setDescription(tx.merchantNormalized || tx.description);
    setDate(new Date(tx.postedAt).toISOString().slice(0, 10));
    setNotes(tx.notes ?? "");
    setAmount(String(parseFloat(tx.amount)));
    setCategory(tx.categoryId && tx.categoryName ? { id: tx.categoryId, name: tx.categoryName, color: tx.categoryColor } : null);
  }, [tx?.id]);

  // Fetch both-direction allocation lists for the repayment/expense sections.
  useEffect(() => {
    if (!tx) return;
    let live = true;
    fetch(`/api/transactions/${tx.id}`)
      .then((r) => r.json())
      .then((d) => { if (!live) return; setAllocOut(d.allocationsOut ?? []); setAllocIn(d.allocationsIn ?? []); })
      .catch(() => {});
    return () => { live = false; };
  }, [tx?.id, refreshKey]);

  if (!tx) return null;

  const amt = parseFloat(tx.amount);
  const isIncome = amt > 0;
  const allocatedOut = round2(allocOut.reduce((s, a) => s + parseFloat(a.amount), 0));
  const allocatedIn = round2(allocIn.reduce((s, a) => s + parseFloat(a.amount), 0));
  const unallocated = round2(Math.abs(amt) - allocatedOut);
  const isRepaidExpense = !isIncome && allocatedIn > 0.001;
  const net = round2(amt + allocatedIn - allocatedOut);

  async function save() {
    if (!tx) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      description, postedAt: date, notes, amount: parseFloat(amount), categoryId: category?.id ?? null,
    };
    await fetch(`/api/transactions/${tx.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    onSaved({ ...body, postedAt: date } as Partial<DetailTransaction>);
    onClose();
  }

  async function generateNote() {
    if (!tx) return;
    setGeneratingNote(true);
    const res = await fetch(`/api/transactions/${tx.id}/note`, { method: "POST" });
    const data = await res.json();
    if (data.note) setNotes(data.note);
    setGeneratingNote(false);
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#00000033", zIndex: 50 }} />

      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 390, background: "var(--bg-2)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", zIndex: 51, boxShadow: "-8px 0 32px #00000044" }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "var(--font-syne)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Transaction</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {/* Pinned card */}
        <div style={{ padding: "14px 20px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", flex: 1 }}>{tx.merchantNormalized || tx.description}</div>
            {tx.hidden && <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 3, background: "var(--bg-2)", color: "var(--text-muted)", border: "1px solid var(--border-2)" }}>Hidden</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4, gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {fmtDate(tx.postedAt)}{tx.accountName && ` · ${tx.accountName}`}
            </span>
            <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 15, fontWeight: 600, color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap", flexShrink: 0 }}>
              {isIncome ? "+" : "−"}{formatCurrency(Math.abs(amt), "MYR")}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* ── Income row: allocate across expenses ── */}
          {isIncome && (
            <div style={{ border: "1px solid #c9a84c33", background: "var(--accent-dim)", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 6 }}>↩ Repayment allocation</div>
              {allocOut.length > 0 ? (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                    {allocOut.map((a) => (
                      <button key={a.allocationId} onClick={() => onOpenLinked(a.expenseId)} title="Open this expense"
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-2)", background: "var(--bg-2)", cursor: "pointer", textAlign: "left" }}
                        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-2)")}>
                        <span style={{ flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {a.name}{a.postedAt && <span style={{ color: "var(--text-muted)" }}> · {fmtDate(a.postedAt)}</span>}
                        </span>
                        <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 12, color: "var(--income)" }}>{formatCurrency(parseFloat(a.amount), "MYR")}</span>
                        <span style={{ color: "var(--text-muted)" }}>→</span>
                      </button>
                    ))}
                  </div>
                  <Row label="Applied to expenses" value={formatCurrency(allocatedOut, "MYR")} color="var(--text)" />
                  <Row label="Left over (income)" value={formatCurrency(unallocated, "MYR")} color={unallocated > 0.001 ? "var(--income)" : "var(--text-muted)"} bold />
                </>
              ) : (
                <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 8 }}>
                  If this money paid you back for one or more expenses, allocate it so those expenses show your true net cost.
                </p>
              )}
              <button onClick={() => onAllocate(tx)} style={linkBtnStyle}>{allocOut.length > 0 ? "Edit allocations" : "Allocate to expenses"}</button>
            </div>
          )}

          {/* ── Repaid expense breakdown ── */}
          {isRepaidExpense && (
            <div style={{ border: "1px solid var(--border-2)", background: "var(--bg-3)", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 8 }}>Repaid expense</div>
              <Row label="Full amount" value={formatCurrency(Math.abs(amt), "MYR")} color="var(--text)" />
              <Row label="Repaid to you" value={`+${formatCurrency(allocatedIn, "MYR")}`} color="var(--income)" />
              <div style={{ borderTop: "1px solid var(--border)", margin: "6px 0" }} />
              <Row label="Your net cost" value={formatCurrency(Math.abs(net), "MYR")} color={net < 0 ? "var(--expense)" : "var(--income)"} bold />
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
                {allocIn.map((a) => (
                  <button key={a.allocationId} onClick={() => onOpenLinked(a.repaymentId)} title="Open this repayment"
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-2)", background: "var(--bg-2)", cursor: "pointer", textAlign: "left" }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-2)")}>
                    <span style={{ flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.name}{a.postedAt && <span style={{ color: "var(--text-muted)" }}> · {fmtDate(a.postedAt)}</span>}
                    </span>
                    <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 12, color: "var(--income)" }}>+{formatCurrency(parseFloat(a.amount), "MYR")}</span>
                    <span style={{ color: "var(--text-muted)" }}>→</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <Field label="Merchant name">
            <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} placeholder="Merchant name" />
          </Field>
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Note">
            <div style={{ display: "flex", gap: 8 }}>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inputStyle, flex: 1, color: notes ? "var(--accent)" : "var(--text)" }} placeholder="Add a note…" />
              <button onClick={generateNote} disabled={generatingNote} title="AI: generate note"
                style={{ background: "none", border: "1px solid var(--border-2)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: "0 10px", flexShrink: 0, opacity: generatingNote ? 0.4 : 0.7 }}>
                {generatingNote ? "…" : "✦"}
              </button>
            </div>
          </Field>
          <Field label="Category">
            <CategoryCombobox value={category} onChange={setCategory} categories={categories} onCategoryCreated={onCategoryCreated} placeholder="— Uncategorized" />
          </Field>
          <Field label="Amount (MYR)">
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...inputStyle, fontFamily: "var(--font-ibm-mono)" }} />
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Negative = expense · Positive = income</div>
          </Field>

          {/* Secondary actions */}
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <SecondaryBtn onClick={() => onSplit(tx)}>Split</SecondaryBtn>
            <SecondaryBtn onClick={() => onAskAI(tx)} color="var(--accent)">✦ Ask AI</SecondaryBtn>
            <SecondaryBtn onClick={() => onToggleHidden(tx)} disabled={hidingBusy}>{tx.hidden ? "Unhide" : "Hide from list"}</SecondaryBtn>
            <SecondaryBtn onClick={() => onDelete(tx)} color="var(--expense)">Delete</SecondaryBtn>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", display: "flex", gap: 10 }}>
          <button onClick={save} disabled={saving} style={{ flex: 1, padding: "10px", borderRadius: 6, border: "none", background: saving ? "var(--border-2)" : "var(--income)", color: "#000", fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer" }}>
            {saving ? "Saving…" : "✓  Save changes"}
          </button>
          <button onClick={onClose} style={{ padding: "10px 18px", borderRadius: 6, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, color, bold }: { label: string; value: string; color: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0" }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 13, color, fontWeight: bold ? 700 : 500 }}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>{label}</label>
      {children}
    </div>
  );
}

function SecondaryBtn({ children, onClick, color, disabled }: { children: React.ReactNode; onClick: () => void; color?: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border-2)", background: "var(--bg-3)", color: color ?? "var(--text-muted)", fontSize: 12, cursor: disabled ? "wait" : "pointer", fontFamily: "inherit" }}>
      {children}
    </button>
  );
}

const linkBtnStyle: React.CSSProperties = {
  background: "none", border: "none", color: "var(--accent)", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "8px 0 0", textAlign: "left",
};
const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "9px 12px", outline: "none", fontFamily: "inherit",
};
