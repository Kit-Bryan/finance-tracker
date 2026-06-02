"use client";

import { useState, useEffect } from "react";
import CategoryCombobox, { Category, CategoryValue } from "./CategoryCombobox";
import { formatCurrency } from "@/lib/format";

interface Transaction {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  currency: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string | null;
  notes: string | null;
}

interface Props {
  transaction: Transaction | null;
  categories: Category[];
  onClose: () => void;
  onSaved: (updates: Partial<Transaction>) => void;
  onCategoryCreated: (cat: Category) => void;
}

export default function TransactionEditPanel({ transaction: tx, categories, onClose, onSaved, onCategoryCreated }: Props) {
  const [description, setDescription] = useState("");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<CategoryValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [generatingNote, setGeneratingNote] = useState(false);

  useEffect(() => {
    if (!tx) return;
    setDescription(tx.merchantNormalized || tx.description);
    setDate(new Date(tx.postedAt).toISOString().slice(0, 10));
    setNotes(tx.notes ?? "");
    setAmount(String(parseFloat(tx.amount)));
    setCategory(tx.categoryId && tx.categoryName ? { id: tx.categoryId, name: tx.categoryName, color: tx.categoryColor } : null);
  }, [tx?.id]);

  if (!tx) return null;

  const amt = parseFloat(tx.amount);
  const isIncome = amt > 0;

  async function save() {
    if (!tx) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      description,
      postedAt: date,
      notes,
      amount: parseFloat(amount),
      categoryId: category?.id ?? null,
    };
    await fetch(`/api/transactions/${tx.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    onSaved({ ...body, postedAt: date } as any);
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
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#00000033", zIndex: 50 }} />

      {/* Panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 360,
        background: "var(--bg-2)", borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column", zIndex: 51,
        boxShadow: "-8px 0 32px #00000044",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "var(--font-syne)", fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Edit Transaction</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {/* Pinned transaction card */}
        <div style={{ padding: "14px 20px", background: "var(--bg-3)", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{tx.merchantNormalized || tx.description}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4, gap: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {new Date(tx.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "long", year: "numeric" })}
              {tx.accountName && ` · ${tx.accountName}`}
            </span>
            <span style={{ fontFamily: "var(--font-ibm-mono)", fontSize: 15, fontWeight: 600, color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap", flexShrink: 0 }}>
              {isIncome ? "+" : "−"}{formatCurrency(Math.abs(amt), "MYR")}
            </span>
          </div>
        </div>

        {/* Form */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: 16 }}>

          <Field label="Merchant name">
            <input value={description} onChange={(e) => setDescription(e.target.value)}
              style={inputStyle} placeholder="Merchant name" />
          </Field>

          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={inputStyle} />
          </Field>

          <Field label="Note">
            <div style={{ display: "flex", gap: 8 }}>
              <input value={notes} onChange={(e) => setNotes(e.target.value)}
                style={{ ...inputStyle, flex: 1, color: notes ? "var(--accent)" : "var(--text)" }}
                placeholder="Add a note…" />
              <button onClick={generateNote} disabled={generatingNote} title="AI: generate note"
                style={{ background: "none", border: "1px solid var(--border-2)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13, padding: "0 10px", flexShrink: 0, opacity: generatingNote ? 0.4 : 0.7, transition: "opacity 0.15s" }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = generatingNote ? "0.4" : "0.7")}
              >
                {generatingNote ? "…" : "✦"}
              </button>
            </div>
          </Field>

          <Field label="Category">
            <CategoryCombobox
              value={category}
              onChange={setCategory}
              categories={categories}
              onCategoryCreated={onCategoryCreated}
              placeholder="— Uncategorized"
            />
          </Field>

          <Field label="Amount (MYR)">
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
              style={{ ...inputStyle, fontFamily: "var(--font-ibm-mono)" }} />
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Negative = expense · Positive = income
            </div>
          </Field>
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)", display: "flex", gap: 10 }}>
          <button onClick={save} disabled={saving} style={{
            flex: 1, padding: "10px", borderRadius: 6, border: "none",
            background: saving ? "var(--border-2)" : "var(--income)",
            color: "#000", fontSize: 13, fontWeight: 700, cursor: saving ? "not-allowed" : "pointer",
          }}>
            {saving ? "Saving…" : "✓  Save changes"}
          </button>
          <button onClick={onClose} style={{
            padding: "10px 18px", borderRadius: 6,
            border: "1px solid var(--border-2)", background: "transparent",
            color: "var(--text-muted)", fontSize: 13, cursor: "pointer",
          }}>
            Cancel
          </button>
        </div>
      </div>
    </>
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

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--bg-3)", border: "1px solid var(--border-2)",
  borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "9px 12px",
  outline: "none", fontFamily: "inherit",
};
