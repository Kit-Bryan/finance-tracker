"use client";

import { useEffect, useState } from "react";
import { formatCurrency } from "@/lib/format";
import CategoryCombobox, { Category, CategoryValue } from "./CategoryCombobox";

interface FlaggedTx {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categorySource: string | null;
  categoryConfidence: string | null;
  accountName: string | null;
}

interface AISuggestion {
  categoryName: string;
  isNew: boolean;
  suggestedParent: string | null;
  confidence: number;
  reasoning: string;
  categoryId: number | null;
  categoryColor: string | null;
}

// Payment methods that don't tell us what was bought
const PAYMENT_METHODS = ["grabpay", "touch n go", "tng", "boost", "shopeepay", "bigpay", "lazada wallet"];

function isPaymentMethod(description: string, merchant: string | null): boolean {
  const text = (merchant ?? description).toLowerCase();
  return PAYMENT_METHODS.some((m) => text.includes(m));
}

interface Props {
  categories: Category[];
  onResolved: () => void;
  onCategoryCreated: (cat: Category) => void;
}

export default function ReviewQueue({ categories, onResolved, onCategoryCreated }: Props) {
  const [items, setItems] = useState<FlaggedTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [selections, setSelections] = useState<Record<number, CategoryValue | null>>({});
  const [hints, setHints] = useState<Record<number, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<number, AISuggestion>>({});
  const [suggesting, setSuggesting] = useState<Record<number, boolean>>({});

  const fetchQueue = async () => {
    const data = await fetch("/api/review-queue").then((r) => r.json());
    setItems(data);
    setLoading(false);
  };

  useEffect(() => { fetchQueue(); }, []);

  // Seed initial selections — only for items not yet touched by the user
  useEffect(() => {
    setSelections((prev) => {
      const next = { ...prev };
      for (const tx of items) {
        if (!(tx.id in next) && tx.categoryId && tx.categoryName) {
          next[tx.id] = { id: tx.categoryId, name: tx.categoryName, color: tx.categoryColor };
        }
      }
      return next;
    });
  }, [items]);

  async function getAISuggestion(tx: FlaggedTx, hint?: string) {
    setSuggesting((s) => ({ ...s, [tx.id]: true }));
    const res = await fetch("/api/categories/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: tx.description,
        hint: hint || hints[tx.id],
        amount: parseFloat(tx.amount),
      }),
    });
    const data: AISuggestion = await res.json();
    setAiSuggestions((s) => ({ ...s, [tx.id]: data }));

    // Auto-select if confident and not a new category
    if (!data.isNew && data.categoryId && data.confidence >= 0.7) {
      setSelections((s) => ({
        ...s,
        [tx.id]: { id: data.categoryId!, name: data.categoryName, color: data.categoryColor },
      }));
    }
    setSuggesting((s) => ({ ...s, [tx.id]: false }));
  }

  async function resolve(txId: number, skip = false) {
    const cat = selections[txId];
    if (!skip && !cat) return;
    setSaving(txId);
    await fetch(`/api/review-queue/${txId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(skip ? { skip: true } : { categoryId: cat!.id }),
    });
    setSaving(null);
    setItems((prev) => prev.filter((t) => t.id !== txId));
    onResolved();
  }

  async function acceptAll() {
    const toAccept = items.filter((tx) => selections[tx.id]);
    for (const tx of toAccept) {
      await resolve(tx.id);
    }
  }

  if (loading || items.length === 0) return null;

  return (
    <div style={{
      background: "#1a1408",
      border: "1px solid #c9a84c44",
      borderRadius: 8,
      marginBottom: 16,
      overflow: "hidden",
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          width: "100%", padding: "12px 20px", background: "none", border: "none",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer", color: "var(--text)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            width: 22, height: 22, borderRadius: "50%",
            background: "var(--accent)", color: "#000",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 700, fontFamily: "var(--font-ibm-mono)",
          }}>{items.length}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>
            Transactions need your input
          </span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            — AI wasn't confident enough to categorize these automatically
          </span>
        </div>
        <span style={{ color: "var(--text-muted)", fontSize: 14 }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div style={{ borderTop: "1px solid #c9a84c22" }}>
          {items.map((tx, idx) => {
            const amt = parseFloat(tx.amount);
            const isIncome = amt > 0;
            const conf = tx.categoryConfidence ? parseFloat(tx.categoryConfidence) : null;
            const displayName = tx.merchantNormalized || tx.description;
            const needsHint = isPaymentMethod(tx.description, tx.merchantNormalized);
            const aiSug = aiSuggestions[tx.id] ?? null;
            const isSuggesting = suggesting[tx.id] ?? false;
            const selected = selections[tx.id] ?? null;

            return (
              <div key={tx.id} style={{
                padding: "16px 20px",
                borderBottom: idx < items.length - 1 ? "1px solid #c9a84c18" : "none",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
                  {/* Date */}
                  <div style={{ minWidth: 52, paddingTop: 2 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)" }}>
                      {new Date(tx.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short" })}
                    </div>
                  </div>

                  {/* Merchant + description */}
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>{displayName}</div>
                    {tx.merchantNormalized && tx.merchantNormalized !== tx.description && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{tx.description}</div>
                    )}

                    {/* Clarification hint for payment methods */}
                    {needsHint && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 4 }}>
                          💳 {displayName} is a payment method — what was this purchase for?
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            type="text"
                            value={hints[tx.id] ?? ""}
                            onChange={(e) => setHints((h) => ({ ...h, [tx.id]: e.target.value }))}
                            onKeyDown={(e) => e.key === "Enter" && getAISuggestion(tx, e.currentTarget.value)}
                            placeholder="e.g. lunch, groceries, Grab ride…"
                            style={{
                              flex: 1, background: "var(--bg-3)", border: "1px solid var(--border-2)",
                              borderRadius: 4, color: "var(--text)", fontSize: 12,
                              padding: "5px 8px", outline: "none", fontFamily: "inherit",
                            }}
                          />
                          <button
                            onClick={() => getAISuggestion(tx)}
                            disabled={isSuggesting || !hints[tx.id]?.trim()}
                            style={{
                              padding: "5px 10px", borderRadius: 4,
                              border: "1px solid #c9a84c33", background: "var(--accent-dim)",
                              color: "var(--accent)", fontSize: 11, cursor: "pointer",
                              opacity: isSuggesting || !hints[tx.id]?.trim() ? 0.5 : 1,
                            }}
                          >
                            {isSuggesting ? "…" : "✦ Ask AI"}
                          </button>
                        </div>
                        {aiSug?.reasoning && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, fontStyle: "italic" }}>
                            {aiSug.reasoning}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Amount */}
                  <div style={{
                    fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500,
                    color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap", paddingTop: 2,
                  }}>
                    {isIncome ? "+" : ""}{formatCurrency(amt, "MYR")}
                  </div>

                  {/* AI confidence badge (non-payment methods) */}
                  {!needsHint && conf !== null && (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, paddingTop: 3 }}>
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>AI:</span>
                      <span style={{
                        fontSize: 10, fontFamily: "var(--font-ibm-mono)",
                        color: conf < 0.5 ? "var(--expense)" : "var(--accent)",
                      }}>
                        {Math.round(conf * 100)}%
                      </span>
                    </div>
                  )}

                  {/* Category combobox */}
                  <div style={{ minWidth: 180 }}>
                    <CategoryCombobox
                      value={selected}
                      onChange={(cat) => setSelections((s) => ({ ...s, [tx.id]: cat }))}
                      categories={categories}
                      aiSuggestion={
                        aiSug
                          ? { name: aiSug.categoryName, confidence: aiSug.confidence, categoryId: aiSug.categoryId, isNew: aiSug.isNew, suggestedParent: aiSug.suggestedParent }
                          : (!needsHint && tx.categoryName && conf !== null)
                            ? { name: tx.categoryName, confidence: conf, categoryId: tx.categoryId, isNew: false, suggestedParent: null }
                            : null
                      }
                      onCategoryCreated={onCategoryCreated}
                      placeholder="Choose category…"
                    />
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 6, paddingTop: 1 }}>
                    <button
                      onClick={() => resolve(tx.id)}
                      disabled={saving === tx.id || !selected}
                      style={{
                        padding: "5px 14px", borderRadius: 5, border: "none",
                        background: saving === tx.id || !selected ? "var(--border-2)" : "var(--accent)",
                        color: saving === tx.id || !selected ? "var(--text-muted)" : "#000",
                        fontSize: 12, fontWeight: 600,
                        cursor: saving === tx.id || !selected ? "not-allowed" : "pointer",
                      }}
                    >
                      {saving === tx.id ? "…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => resolve(tx.id, true)}
                      disabled={saving === tx.id}
                      style={{
                        padding: "5px 12px", borderRadius: 5,
                        border: "1px solid var(--border-2)", background: "transparent",
                        color: "var(--text-muted)", fontSize: 12, cursor: "pointer",
                      }}
                    >
                      Skip
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Accept all footer */}
          {items.filter((tx) => selections[tx.id]).length > 1 && (
            <div style={{
              padding: "12px 20px", borderTop: "1px solid #c9a84c22",
              display: "flex", justifyContent: "flex-end",
            }}>
              <button
                onClick={acceptAll}
                style={{
                  padding: "6px 16px", borderRadius: 5,
                  border: "1px solid #c9a84c33", background: "var(--accent-dim)",
                  color: "var(--accent)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                }}
              >
                Accept all confirmed ({items.filter((tx) => selections[tx.id]).length})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
