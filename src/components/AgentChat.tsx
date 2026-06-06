"use client";

import { useEffect, useRef, useState } from "react";
import { formatCurrency } from "@/lib/format";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolResults?: { toolName: string; result: unknown }[];
  pendingConfirmation?: PendingAction;
  confirmed?: boolean;
  sessionId?: number;
}

interface PendingAction {
  type: "bulk_update_category" | "edit_transaction" | "split_transaction" | "link_reimbursements";
  // bulk
  transactionIds?: number[];
  categoryName?: string;
  categoryId?: number;
  preview?: { id: number; description: string; amount: string | number }[];
  // edit
  transactionId?: number;
  changes?: { field: string; oldValue: unknown; newValue: unknown }[];
  description?: string;
  // split
  originalAmount?: number;
  originalDescription?: string;
  originalDate?: string;
  splits?: { amount: number; description: string; notes?: string; categoryName?: string | null; categoryId?: number | null }[];
  // link_reimbursements
  expenseId?: number;
  expenseDescription?: string;
  expenseAmount?: number;
  expenseDate?: string;
  expenseCategoryName?: string | null;
  reimbursementTransactions?: { id: number; description: string; amount: number; date: string }[];
  totalReimbursed?: number;
  yourShare?: number;
}

interface ChatSession {
  id: number;
  title: string | null;
  transactionId: number | null;
  createdAt: string;
}

export interface ContextTransaction {
  id: number;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  postedAt: string;
  categoryName: string | null;
  notes: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onTransactionsChanged: () => void;
  contextTransaction?: ContextTransaction | null;
}

export default function AgentChat({ open, onClose, onTransactionsChanged, contextTransaction }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingSession, setLoadingSession] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
      fetchSessions();
      // New transaction context → reset chat
      if (contextTransaction) {
        setMessages([]);
        setSessionId(null);
      }
    }
  }, [open, contextTransaction?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function fetchSessions() {
    const data = await fetch("/api/chat-sessions").then((r) => r.json());
    setSessions(data);
  }

  async function loadSession(id: number) {
    setLoadingSession(true);
    const data = await fetch(`/api/chat-sessions/${id}`).then((r) => r.json());
    setSessionId(id);
    setMessages(data.messages.map((m: any) => ({
      role: m.role,
      content: m.content,
      toolResults: m.toolResults,
      pendingConfirmation: m.pendingAction,
    })));
    setShowHistory(false);
    setLoadingSession(false);
  }

  async function deleteSession(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/chat-sessions/${id}`, { method: "DELETE" });
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (sessionId === id) { setSessionId(null); setMessages([]); }
  }

  function newChat() {
    setMessages([]);
    setSessionId(null);
    setShowHistory(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  const history = messages.map((m) => ({ role: m.role, content: m.content }));

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
        body: JSON.stringify({
          message: text,
          history,
          sessionId,
          contextTransaction,
        }),
      });
      const data = await res.json();
      setSessionId(data.sessionId ?? sessionId);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.message ?? data.error ?? "Something went wrong.",
          toolResults: data.toolResults,
          pendingConfirmation: data.pendingConfirmation,
        },
      ]);
      fetchSessions();
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
    setMessages((prev) => prev.map((m, i) => i === msgIdx ? { ...m, confirmed: true } : m));
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: data.message ?? `✓ Done — ${data.updated} transaction${data.updated !== 1 ? "s" : ""} updated.`,
    }]);
    onTransactionsChanged();
  }

  function dismissAction(msgIdx: number) {
    setMessages((prev) => prev.map((m, i) => i === msgIdx ? { ...m, confirmed: false, pendingConfirmation: undefined } : m));
  }

  const SUGGESTIONS = contextTransaction
    ? [
        "Change the date to the next day",
        "Make the note shorter",
        "What category should this be?",
        "Split this transaction into two",
      ]
    : [
        "What transactions need review?",
        "Categorize all GrabPay as Food & Drink",
        "Find group dinner reimbursements",
        "What did I spend most on this month?",
      ];

  if (!open) return null;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#00000055", zIndex: 50 }} />
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 500,
        background: "var(--bg-2)", borderLeft: "1px solid var(--border)",
        display: "flex", flexDirection: "column", zIndex: 51,
        boxShadow: "-8px 0 32px #00000044",
      }}>
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "var(--font-syne)", fontSize: 15, fontWeight: 700, color: "var(--accent)" }}>Finance Agent</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={newChat} title="New chat" style={iconBtn}>+</button>
            <button onClick={() => setShowHistory((h) => !h)} title="Chat history" style={{ ...iconBtn, color: showHistory ? "var(--accent)" : "var(--text-muted)" }}>☰</button>
            <button onClick={onClose} style={iconBtn}>✕</button>
          </div>
        </div>

        {/* History sidebar overlay */}
        {showHistory && (
          <div style={{
            position: "absolute", top: 49, left: 0, right: 0, bottom: 0,
            background: "var(--bg-2)", zIndex: 10, overflowY: "auto",
            borderTop: "1px solid var(--border)",
          }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>
              Conversation History
            </div>
            {sessions.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No history yet</div>
            ) : sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => loadSession(s.id)}
                style={{
                  padding: "12px 16px", borderBottom: "1px solid var(--border)",
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                  background: sessionId === s.id ? "var(--accent-dim)" : "transparent",
                }}
                onMouseEnter={(e) => { if (sessionId !== s.id) e.currentTarget.style.background = "var(--bg-3)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = sessionId === s.id ? "var(--accent-dim)" : "transparent"; }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: sessionId === s.id ? "var(--accent)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.title ?? "Untitled"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {new Date(s.createdAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
                <button
                  onClick={(e) => deleteSession(s.id, e)}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "2px 4px", flexShrink: 0 }}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Pinned transaction card */}
        {contextTransaction && (
          <div style={{
            padding: "10px 18px", borderBottom: "1px solid var(--border)",
            background: "var(--bg-3)",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Editing</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {contextTransaction.merchantNormalized || contextTransaction.description}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                {new Date(contextTransaction.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                {contextTransaction.categoryName && ` · ${contextTransaction.categoryName}`}
              </div>
            </div>
            <div style={{
              fontFamily: "var(--font-ibm-mono)", fontSize: 15, fontWeight: 600,
              color: parseFloat(contextTransaction.amount) < 0 ? "var(--expense)" : "var(--income)",
              whiteSpace: "nowrap",
            }}>
              {parseFloat(contextTransaction.amount) > 0 ? "+" : ""}{formatCurrency(parseFloat(contextTransaction.amount), "MYR")}
            </div>
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && !loadingSession && (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 14 }}>
                {contextTransaction
                  ? `Ask me anything about this transaction, or tell me what to change.`
                  : `I can search your transactions, explain charges, and make bulk changes.`}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    style={{ padding: "9px 14px", borderRadius: 6, border: "1px solid var(--border-2)", background: "var(--bg-3)", color: "var(--text)", fontSize: 12, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start", gap: 6 }}>
              <div style={{
                maxWidth: "92%", padding: "10px 14px", borderRadius: 8,
                background: msg.role === "user" ? "var(--accent-dim)" : "var(--bg-3)",
                border: msg.role === "user" ? "1px solid #c9a84c33" : "1px solid var(--border)",
                fontSize: 13, color: "var(--text)", lineHeight: 1.55, whiteSpace: "pre-wrap",
              }}>
                <SimpleMarkdown text={msg.content} />
              </div>

              {/* Confirmation cards */}
              {msg.pendingConfirmation && !msg.confirmed && msg.confirmed !== false && (
                <ConfirmCard
                  action={msg.pendingConfirmation}
                  onConfirm={() => confirmAction(idx, msg.pendingConfirmation!)}
                  onDismiss={() => dismissAction(idx)}
                  confirming={confirming}
                />
              )}
              {msg.confirmed === true && <div style={{ fontSize: 11, color: "var(--income)", padding: "3px 8px", background: "var(--income-dim)", borderRadius: 4 }}>✓ Applied</div>}
              {msg.confirmed === false && <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "3px 8px" }}>Dismissed</div>}
            </div>
          ))}

          {loading && (
            <div style={{ display: "flex" }}>
              <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--bg-3)", border: "1px solid var(--border)" }}>
                <ThinkingDots />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
            placeholder={contextTransaction ? "Tell me what to change…" : "Ask about your transactions…"}
            disabled={loading}
            style={{
              flex: 1, background: "var(--bg-3)", border: "1px solid var(--border-2)",
              borderRadius: 6, color: "var(--text)", fontSize: 13, padding: "8px 12px",
              outline: "none", fontFamily: "inherit", opacity: loading ? 0.6 : 1,
            }}
          />
          <button onClick={send} disabled={loading || !input.trim()}
            style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: loading || !input.trim() ? "var(--border-2)" : "var(--accent)", color: loading || !input.trim() ? "var(--text-muted)" : "#000", fontSize: 13, fontWeight: 600, cursor: loading || !input.trim() ? "not-allowed" : "pointer" }}>
            ↑
          </button>
        </div>
      </div>
    </>
  );
}

function ConfirmCard({ action, onConfirm, onDismiss, confirming }: {
  action: PendingAction; onConfirm: () => void; onDismiss: () => void; confirming: boolean;
}) {
  return (
    <div style={{ width: "100%", border: "1px solid #c9a84c44", borderRadius: 8, background: "#1a1408", overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid #c9a84c22" }}>
        {/* bulk_update_category */}
        {action.type === "bulk_update_category" && (
          <>
            <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 6 }}>
              Set {action.preview?.length} transaction{action.preview?.length !== 1 ? "s" : ""} to <strong>{action.categoryName}</strong>
            </div>
            <div style={{ maxHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
              {action.preview?.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-muted)" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>{p.description}</span>
                  <span style={{ fontFamily: "var(--font-ibm-mono)", color: parseFloat(String(p.amount)) < 0 ? "var(--expense)" : "var(--income)" }}>
                    {formatCurrency(parseFloat(String(p.amount)), "MYR")}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* edit_transaction */}
        {action.type === "edit_transaction" && (
          <>
            <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 6 }}>
              Edit: {action.description}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {action.changes?.map((c, i) => (
                <div key={i} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ color: "var(--text-muted)", minWidth: 80, textTransform: "capitalize" }}>{c.field}</span>
                  <span style={{ color: "var(--expense)", textDecoration: "line-through", opacity: 0.7 }}>{String(c.oldValue ?? "—")}</span>
                  <span style={{ color: "var(--text-muted)" }}>→</span>
                  <span style={{ color: "var(--income)" }}>{String(c.newValue)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* split_transaction */}
        {action.type === "split_transaction" && (
          <>
            <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 6 }}>
              Split: {action.originalDescription} ({formatCurrency(action.originalAmount ?? 0, "MYR")})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {action.splits?.map((s, i) => (
                <div key={i} style={{ fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div>
                    <span style={{ color: "var(--text)" }}>{s.description}</span>
                    {s.categoryName && <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>· {s.categoryName}</span>}
                    {s.notes && <span style={{ color: "var(--text-muted)", marginLeft: 6, fontStyle: "italic" }}>· {s.notes}</span>}
                  </div>
                  <span style={{ fontFamily: "var(--font-ibm-mono)", color: s.amount < 0 ? "var(--expense)" : "var(--income)", whiteSpace: "nowrap" }}>
                    {formatCurrency(s.amount, "MYR")}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
              Original will be moved to trash
            </div>
          </>
        )}

        {/* link_reimbursements */}
        {action.type === "link_reimbursements" && (
          <>
            <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, marginBottom: 8 }}>
              Link reimbursements → {action.expenseDescription}
            </div>
            {/* Original expense row */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid #c9a84c22" }}>
              <span style={{ color: "var(--text-muted)" }}>{action.expenseDate} · {action.expenseCategoryName ?? "Uncategorized"}</span>
              <span style={{ fontFamily: "var(--font-ibm-mono)", color: "var(--expense)" }}>
                {formatCurrency(action.expenseAmount ?? 0, "MYR")}
              </span>
            </div>
            {/* Reimbursement rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
              {action.reimbursementTransactions?.map((r) => (
                <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>
                    ↩ {r.description}
                  </span>
                  <span style={{ fontFamily: "var(--font-ibm-mono)", color: "var(--income)", whiteSpace: "nowrap", marginLeft: 8 }}>
                    +{formatCurrency(r.amount, "MYR")}
                  </span>
                </div>
              ))}
            </div>
            {/* Net result */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, paddingTop: 6, borderTop: "1px solid #c9a84c22" }}>
              <span style={{ color: "var(--text)", fontWeight: 600 }}>Your share</span>
              <span style={{ fontFamily: "var(--font-ibm-mono)", fontWeight: 600, color: (action.yourShare ?? 0) < 0 ? "var(--expense)" : "var(--income)" }}>
                {formatCurrency(action.yourShare ?? 0, "MYR")}
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
              The dashboard will show MYR {Math.abs(action.yourShare ?? 0).toFixed(2)} instead of MYR {Math.abs(action.expenseAmount ?? 0).toFixed(2)} for this expense.
            </div>
          </>
        )}
      </div>
      <div style={{ padding: "10px 14px", display: "flex", gap: 8 }}>
        <button onClick={onConfirm} disabled={confirming}
          style={{ padding: "6px 16px", borderRadius: 5, border: "none", background: "var(--accent)", color: "#000", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
          {confirming ? "Applying…" : "Apply"}
        </button>
        <button onClick={onDismiss}
          style={{ padding: "6px 12px", borderRadius: 5, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function SimpleMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>{parts.map((part, i) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={i} style={{ color: "var(--accent)" }}>{part.slice(2, -2)}</strong>
        : <span key={i}>{part}</span>
    )}</>
  );
}

function ThinkingDots() {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", height: 16 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-muted)", animation: "bounce 1.2s ease infinite", animationDelay: `${i * 0.2}s` }} />
      ))}
      <style>{`@keyframes bounce { 0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-5px);opacity:1} }`}</style>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  background: "none", border: "none", color: "var(--text-muted)", fontSize: 15,
  cursor: "pointer", padding: "4px 8px", borderRadius: 4,
};
