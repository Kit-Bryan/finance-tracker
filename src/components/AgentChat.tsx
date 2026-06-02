"use client";

import { useEffect, useRef, useState } from "react";
import { formatCurrency } from "@/lib/format";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolResults?: { toolName: string; result: unknown }[];
  pendingConfirmation?: PendingAction;
  confirmed?: boolean;
}

interface PendingAction {
  type: "bulk_update_category";
  transactionIds: number[];
  categoryName: string;
  categoryId: number;
  preview: { id: number; description: string; amount: string | number }[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onTransactionsChanged: () => void;
}

export default function AgentChat({ open, onClose, onTransactionsChanged }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const history = messages
    .filter((m) => !m.toolResults)
    .map((m) => ({ role: m.role, content: m.content }));

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      });
      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.message ?? data.error ?? "Something went wrong.",
          toolResults: data.toolResults,
          pendingConfirmation: data.pendingConfirmation,
        },
      ]);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${e}` }]);
    }
    setLoading(false);
  }

  async function confirmAction(msgIdx: number, action: PendingAction) {
    setConfirming(true);
    const res = await fetch("/api/agent/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    setConfirming(false);

    setMessages((prev) =>
      prev.map((m, i) =>
        i === msgIdx ? { ...m, confirmed: true } : m
      )
    );
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `✓ Done — updated ${data.updated} transaction${data.updated !== 1 ? "s" : ""} to **${action.categoryName}**.`,
      },
    ]);
    onTransactionsChanged();
  }

  function dismissAction(msgIdx: number) {
    setMessages((prev) =>
      prev.map((m, i) => (i === msgIdx ? { ...m, confirmed: false, pendingConfirmation: undefined } : m))
    );
  }

  const SUGGESTIONS = [
    "What transactions need review?",
    "Categorize all GrabPay as Food & Drink",
    "What's this OPENAI charge?",
    "Show me all uncategorized transactions",
  ];

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "#00000055", zIndex: 50 }}
      />

      {/* Panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 480,
        background: "var(--bg-2)", borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column", zIndex: 51,
        boxShadow: "-8px 0 32px #00000044",
      }}>
        {/* Header */}
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontFamily: "var(--font-syne)", fontSize: 16, fontWeight: 700, color: "var(--accent)" }}>Finance Agent</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Ask anything about your transactions</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
                I can search your transactions, explain charges, and bulk-update categories. Try:
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    style={{
                      padding: "9px 14px", borderRadius: 6,
                      border: "1px solid var(--border-2)", background: "var(--bg-3)",
                      color: "var(--text)", fontSize: 12, cursor: "pointer",
                      textAlign: "left", fontFamily: "inherit",
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start", gap: 6 }}>
              <div style={{
                maxWidth: "90%", padding: "10px 14px", borderRadius: 8,
                background: msg.role === "user" ? "var(--accent-dim)" : "var(--bg-3)",
                border: msg.role === "user" ? "1px solid #c9a84c33" : "1px solid var(--border)",
                fontSize: 13, color: "var(--text)", lineHeight: 1.5,
                whiteSpace: "pre-wrap",
              }}>
                <SimpleMarkdown text={msg.content} />
              </div>

              {/* Pending confirmation card */}
              {msg.pendingConfirmation && !msg.confirmed && msg.confirmed !== false && (
                <ConfirmCard
                  action={msg.pendingConfirmation}
                  onConfirm={() => confirmAction(idx, msg.pendingConfirmation!)}
                  onDismiss={() => dismissAction(idx)}
                  confirming={confirming}
                />
              )}

              {/* Confirmed state */}
              {msg.confirmed === true && (
                <div style={{ fontSize: 11, color: "var(--income)", padding: "4px 8px", background: "var(--income-dim)", borderRadius: 4 }}>
                  ✓ Applied
                </div>
              )}
              {msg.confirmed === false && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 8px" }}>
                  Dismissed
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div style={{ display: "flex", alignItems: "flex-start" }}>
              <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--bg-3)", border: "1px solid var(--border)" }}>
                <ThinkingDots />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: "14px 16px", borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder="Ask about your transactions…"
            disabled={loading}
            style={{
              flex: 1, background: "var(--bg-3)", border: "1px solid var(--border-2)",
              borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "8px 12px",
              outline: "none", fontFamily: "inherit", opacity: loading ? 0.6 : 1,
            }}
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            style={{
              padding: "8px 16px", borderRadius: 6, border: "none",
              background: loading || !input.trim() ? "var(--border-2)" : "var(--accent)",
              color: loading || !input.trim() ? "var(--text-muted)" : "#000",
              fontSize: 13, fontWeight: 600, cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            }}
          >
            ↑
          </button>
        </div>
      </div>
    </>
  );
}

function ConfirmCard({ action, onConfirm, onDismiss, confirming }: {
  action: PendingAction;
  onConfirm: () => void;
  onDismiss: () => void;
  confirming: boolean;
}) {
  return (
    <div style={{
      width: "100%", border: "1px solid #c9a84c44", borderRadius: 8,
      background: "#1a1408", overflow: "hidden",
    }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #c9a84c22" }}>
        <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>
          Confirm: set {action.preview.length} transaction{action.preview.length !== 1 ? "s" : ""} to <strong>{action.categoryName}</strong>
        </div>
        <div style={{ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {action.preview.map((p) => (
            <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>{p.description}</span>
              <span style={{ fontFamily: "var(--font-ibm-mono)", color: parseFloat(String(p.amount)) < 0 ? "var(--expense)" : "var(--income)" }}>
                {formatCurrency(parseFloat(String(p.amount)), "MYR")}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ padding: "10px 14px", display: "flex", gap: 8 }}>
        <button
          onClick={onConfirm}
          disabled={confirming}
          style={{ padding: "6px 16px", borderRadius: 5, border: "none", background: "var(--accent)", color: "#000", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
        >
          {confirming ? "Applying…" : "Apply"}
        </button>
        <button
          onClick={onDismiss}
          style={{ padding: "6px 12px", borderRadius: 5, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function SimpleMarkdown({ text }: { text: string }) {
  // Minimal bold support
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**")
          ? <strong key={i} style={{ color: "var(--accent)" }}>{part.slice(2, -2)}</strong>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", height: 16 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: "50%", background: "var(--text-muted)",
          animation: "bounce 1.2s ease infinite",
          animationDelay: `${i * 0.2}s`,
        }} />
      ))}
      <style>{`
        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
