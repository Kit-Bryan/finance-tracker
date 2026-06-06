"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { formatCurrency, startOfMonth, today, formatTxDate, formatTxTime } from "@/lib/format";
import ReviewQueue from "@/components/ReviewQueue";
import AgentChat, { ContextTransaction } from "@/components/AgentChat";
import CategoryCombobox, { CategoryValue } from "@/components/CategoryCombobox";
import FilterCategoryCombobox from "@/components/FilterCategoryCombobox";
import TransactionEditPanel from "@/components/TransactionEditPanel";
import ConfirmDialog from "@/components/ConfirmDialog";

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
  parentCategoryName: string | null;
  accountId: number;
  accountName: string | null;
  categorySource: string | null;
  hidden: boolean;
  notes: string | null;
}

interface Category { id: number; name: string; color: string | null; parentId: number | null; }
interface Account { id: number; name: string; bank: string; }
interface TrashItem {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  currency: string;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string | null;
  deletedAt: string;
  batchId: number | null;
  batchFilename: string | null;
}

interface ImportBatch {
  id: number;
  filename: string;
  status: string;
  importedRows: number | null;
  createdAt: string;
  accountName: string | null;
  bank: string | null;
}

const selectStyle: React.CSSProperties = {
  background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 5,
  color: "var(--text)", fontSize: 13, padding: "6px 10px", outline: "none", fontFamily: "inherit",
};

export default function TransactionsContent() {
  const searchParams = useSearchParams();
  const filterParam = searchParams.get("filter");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const categoryIdParam = searchParams.get("categoryId");

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"list" | "history" | "trash">("list");

  const [filters, setFilters] = useState({
    from: fromParam || startOfMonth(),
    to: toParam || today(),
    accountId: "",
    categoryId: filterParam === "uncategorized" ? "none" : (categoryIdParam || ""),
    search: "",
  });
  // Separate typed value so we can debounce before triggering a fetch
  const [searchInput, setSearchInput] = useState(filters.search);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Transaction | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState<number | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentContext, setAgentContext] = useState<ContextTransaction | null>(null);
  const [trashItems, setTrashItems] = useState<TrashItem[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [purgingId, setPurgingId] = useState<number | null>(null);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [expandedDescriptions, setExpandedDescriptions] = useState<Set<number>>(new Set());
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [generatingNoteId, setGeneratingNoteId] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [hidingId, setHidingId] = useState<number | null>(null);

  const LIMIT = 50;

  const fetchAll = useCallback(async (f: typeof filters, p: number) => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(LIMIT), page: String(p) });
    if (f.from) params.set("from", f.from);
    if (f.to) params.set("to", f.to);
    if (f.accountId) params.set("accountId", f.accountId);
    if (f.categoryId && f.categoryId !== "none") params.set("categoryId", f.categoryId);
    if (f.search) params.set("search", f.search);
    if (showHidden) params.set("includeHidden", "1");
    const data = await fetch(`/api/transactions?${params}`).then((r) => r.json());
    let rows: Transaction[] = data.rows ?? [];
    if (f.categoryId === "none") rows = rows.filter((tx) => !tx.categoryId);
    setTransactions(rows);
    setTotal(data.total ?? 0);
    setLoading(false);
  }, [showHidden]);

  async function hideGoPlusNoise() {
    const res = await fetch("/api/transactions/hide-noise", { method: "POST" });
    const data = await res.json();
    setBulkResult(data.hidden > 0 ? `Hid ${data.hidden} GO+ internal leg${data.hidden !== 1 ? "s" : ""}` : "No GO+ noise found to hide");
    fetchAll(filters, page);
  }

  async function toggleHidden(tx: Transaction) {
    setHidingId(tx.id);
    await fetch(`/api/transactions/${tx.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden: !tx.hidden }),
    });
    setHidingId(null);
    // If we're not showing hidden, the row disappears; otherwise just flip its state
    if (!showHidden && !tx.hidden) {
      setTransactions((prev) => prev.filter((t) => t.id !== tx.id));
    } else {
      setTransactions((prev) => prev.map((t) => t.id === tx.id ? { ...t, hidden: !t.hidden } : t));
    }
  }

  // Cmd+K / Ctrl+K → open agent chat
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setAgentOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const fetchBatches = async () => {
    const data = await fetch("/api/import-batches").then((r) => r.json());
    setBatches(data);
  };

  const fetchTrash = async () => {
    setTrashLoading(true);
    const data = await fetch("/api/trash").then((r) => r.json());
    setTrashItems(data);
    setTrashLoading(false);
  };

  async function saveNote(txId: number, note: string) {
    await fetch(`/api/transactions/${txId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: note }),
    });
    setEditingNoteId(null);
    // Update local state — no full re-fetch, no scroll jump
    setTransactions((prev) => prev.map((t) => t.id === txId ? { ...t, notes: note } : t));
  }

  async function generateNote(txId: number) {
    setGeneratingNoteId(txId);
    const res = await fetch(`/api/transactions/${txId}/note`, { method: "POST" });
    const data = await res.json();
    setGeneratingNoteId(null);
    // Update local state only
    setTransactions((prev) => prev.map((t) => t.id === txId ? { ...t, notes: data.note ?? t.notes } : t));
  }

  async function restoreTransaction(txId: number) {
    setRestoringId(txId);
    await fetch(`/api/trash/${txId}`, { method: "POST" });
    setRestoringId(null);
    setTrashItems((prev) => prev.filter((t) => t.id !== txId));
    fetchAll(filters, page);
  }

  async function permanentlyDelete(txId: number) {
    if (!confirm("Permanently delete this transaction? This cannot be undone.")) return;
    setPurgingId(txId);
    await fetch(`/api/trash/${txId}`, { method: "DELETE" });
    setPurgingId(null);
    setTrashItems((prev) => prev.filter((t) => t.id !== txId));
  }

  async function emptyTrash() {
    if (!confirm(`Permanently delete all ${trashItems.length} transaction${trashItems.length !== 1 ? "s" : ""} in trash? This cannot be undone.`)) return;
    setEmptyingTrash(true);
    await fetch("/api/trash", { method: "DELETE" });
    setEmptyingTrash(false);
    setTrashItems([]);
  }

  useEffect(() => {
    Promise.all([
      fetch("/api/categories").then((r) => r.json()),
      fetch("/api/accounts").then((r) => r.json()),
    ]).then(([cats, accs]) => { setCategories(cats); setAccounts(accs); });
    fetchBatches();
  }, []);

  // Debounce search input → filters.search (300 ms)
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, search: searchInput }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { fetchAll(filters, page); }, [filters, page, fetchAll]);

  const parentCats = categories.filter((c) => !c.parentId);
  const childrenOf = (pid: number) => categories.filter((c) => c.parentId === pid);

  function handleEditSaved() {
    setEditingId(null);
    fetchAll(filters, page);
  }

  async function confirmDeleteTransaction() {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.id);
    setConfirmDelete(null);
    await fetch(`/api/transactions/${confirmDelete.id}`, { method: "DELETE" });
    setDeletingId(null);
    fetchAll(filters, page);
  }

  async function bulkCategorize() {
    setBulkRunning(true);
    setBulkResult(null);
    const res = await fetch("/api/transactions/bulk-categorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const data = await res.json();
    setBulkResult(`Categorized ${data.updated} of ${data.total} transactions`);
    setBulkRunning(false);
    fetchAll(filters, page);
  }

  async function deleteBatch(batchId: number) {
    if (!confirm("Delete this import and all its transactions? This cannot be undone.")) return;
    setDeletingBatch(batchId);
    await fetch(`/api/import-batches/${batchId}`, { method: "DELETE" });
    setDeletingBatch(null);
    fetchBatches();
    fetchAll(filters, page);
  }

  const uncategorizedCount = transactions.filter((tx) => !tx.categoryId).length;
  const totalExpense = transactions.filter((t) => parseFloat(t.amount) < 0).reduce((s, t) => s + parseFloat(t.amount), 0);
  const totalIncome = transactions.filter((t) => parseFloat(t.amount) > 0).reduce((s, t) => s + parseFloat(t.amount), 0);
  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div style={{ padding: "32px 36px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div className="fade-up fade-up-1" style={{ marginBottom: 24, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-syne)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text)" }}>Transactions</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>{loading ? "—" : `${total} transactions`}</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!loading && (
            <div style={{ display: "flex", gap: 16, fontFamily: "var(--font-ibm-mono)", fontSize: 13, marginRight: 8 }}>
              <span style={{ color: "var(--income)" }}>+{formatCurrency(totalIncome, "MYR")}</span>
              <span style={{ color: "var(--expense)" }}>{formatCurrency(totalExpense, "MYR")}</span>
            </div>
          )}
          {uncategorizedCount > 0 && (
            <button onClick={bulkCategorize} disabled={bulkRunning} style={{
              padding: "7px 14px", borderRadius: 6, border: "1px solid #c9a84c44",
              background: "var(--accent-dim)", color: "var(--accent)", fontSize: 12,
              cursor: bulkRunning ? "wait" : "pointer", fontFamily: "inherit",
            }}>
              {bulkRunning ? "Categorizing…" : `✦ AI categorize ${uncategorizedCount}`}
            </button>
          )}
          <button onClick={hideGoPlusNoise} title="Hide all GO+ internal legs (Quick Reload / Cash Out) already imported" style={{
            padding: "7px 14px", borderRadius: 6, border: "1px solid var(--border-2)",
            background: "var(--bg-3)", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
          }}>
            Hide GO+ noise
          </button>
          <button onClick={() => setShowHidden((s) => !s)} title="Toggle hidden transactions (e.g. GO+ internal legs)" style={{
            padding: "7px 14px", borderRadius: 6, border: "1px solid var(--border-2)",
            background: showHidden ? "var(--accent-dim)" : "var(--bg-3)", color: showHidden ? "var(--accent)" : "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
          }}>
            {showHidden ? "✓ Showing hidden" : "Show hidden"}
          </button>
          <button onClick={() => setShowAdd(true)} style={{
            padding: "7px 14px", borderRadius: 6, border: "1px solid var(--border-2)",
            background: "var(--bg-3)", color: "var(--text)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
          }}>
            + Add
          </button>
          <button onClick={() => setAgentOpen(true)} style={{
            padding: "7px 14px", borderRadius: 6, border: "1px solid var(--border-2)",
            background: "var(--bg-3)", color: "var(--accent)", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            ✦ Ask AI
          </button>
        </div>
      </div>

      {bulkResult && (
        <div style={{ padding: "10px 16px", background: "var(--income-dim)", border: "1px solid #4ade8033", borderRadius: 6, fontSize: 13, color: "var(--income)", marginBottom: 16 }}>
          {bulkResult} <button onClick={() => setBulkResult(null)} style={{ background: "none", border: "none", color: "var(--income)", cursor: "pointer", marginLeft: 8 }}>×</button>
        </div>
      )}

      {/* Review Queue */}
      <ReviewQueue
        categories={categories}
        onResolved={() => fetchAll(filters, page)}
        onCategoryCreated={(cat) => setCategories((prev) => [...prev, cat])}
      />

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "1px solid var(--border)" }}>
        {(["list", "history", "trash"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); if (t === "trash") fetchTrash(); }} style={{
            padding: "8px 18px", background: "none", border: "none",
            borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            color: tab === t ? "var(--accent)" : "var(--text-muted)",
            fontSize: 13, cursor: "pointer", fontFamily: "inherit", marginBottom: -1,
          }}>
            {t === "history" ? "Import History" : t === "trash" ? `🗑 Trash${trashItems.length > 0 ? ` (${trashItems.length})` : ""}` : "Transactions"}
          </button>
        ))}
      </div>

      {/* ── LIST TAB ── */}
      {tab === "list" && (
        <>
          {/* Filters */}
          <div className="fade-up fade-up-2" style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "14px 18px", marginBottom: 14, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <FilterInput label="From" type="date" value={filters.from} onChange={(v) => { setFilters((f) => ({ ...f, from: v })); setPage(1); }} />
            <FilterInput label="To" type="date" value={filters.to} onChange={(v) => { setFilters((f) => ({ ...f, to: v })); setPage(1); }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelStyle}>Account</label>
              <select value={filters.accountId} onChange={(e) => { setFilters((f) => ({ ...f, accountId: e.target.value })); setPage(1); }} style={selectStyle}>
                <option value="">All accounts</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative", zIndex: 30 }}>
              <label style={labelStyle}>Category</label>
              <FilterCategoryCombobox
                value={filters.categoryId}
                onChange={(v) => { setFilters((f) => ({ ...f, categoryId: v })); setPage(1); }}
                categories={categories}
              />
            </div>
            <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelStyle}>Search</label>
              <input type="text" placeholder="Search merchant, description, notes…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} style={{ ...selectStyle, width: "100%" }} />
            </div>
            {(filters.categoryId || filters.accountId || searchInput) && (
              <button onClick={() => { setFilters((f) => ({ ...f, accountId: "", categoryId: "", search: "" })); setSearchInput(""); setPage(1); }} style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", paddingBottom: 2 }}>
                Clear
              </button>
            )}
          </div>

          {/* Table */}
          <div className="fade-up fade-up-3" style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", position: "relative", zIndex: 0 }}>
            {loading ? (
              <div style={{ padding: 24 }}>{[...Array(6)].map((_, i) => <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />)}</div>
            ) : transactions.length === 0 ? (
              <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No transactions match these filters.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Date", "Merchant / Description", "Category", "Account", "Amount", ""].map((h, i) => (
                      <th key={i} style={{ padding: "10px 16px", textAlign: h === "Amount" ? "right" : "left", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => {
                    const amt = parseFloat(tx.amount);
                    const isIncome = amt > 0;
                    const isEditing = editingId === tx.id;
                    const isDeleting = deletingId === tx.id;
                    const displayName = tx.merchantNormalized || tx.description;

                    const isExpanded = expandedDescriptions.has(tx.id);

                    return (
                      <tr
                        key={tx.id}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          background: isEditing ? "var(--accent-dim)" : isDeleting ? "var(--expense-dim)" : "transparent",
                          borderLeft: isEditing ? "3px solid var(--accent)" : "3px solid transparent",
                          transition: "background 0.15s, border-color 0.15s",
                          opacity: isDeleting ? 0.5 : tx.hidden ? 0.45 : 1,
                        }}
                        onMouseEnter={(e) => !isEditing && (e.currentTarget.style.background = "var(--bg-3)")}
                        onMouseLeave={(e) => !isEditing && (e.currentTarget.style.background = "transparent")}
                      >
                        {/* Date */}
                        <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                          {formatTxDate(tx.postedAt)}
                          {formatTxTime(tx.postedAt) && (
                            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{formatTxTime(tx.postedAt)}</div>
                          )}
                        </td>

                        {/* Merchant / Description */}
                        <td style={{ padding: "10px 16px", maxWidth: 300, cursor: "pointer" }}
                          onClick={() => setExpandedDescriptions((prev) => { const next = new Set(prev); next.has(tx.id) ? next.delete(tx.id) : next.add(tx.id); return next; })}
                        >
                          <div>
                            <div style={{ fontSize: 13, color: "var(--text)", overflow: isExpanded ? "visible" : "hidden", textOverflow: isExpanded ? "unset" : "ellipsis", whiteSpace: isExpanded ? "normal" : "nowrap", wordBreak: isExpanded ? "break-word" : "normal" }}>
                              {displayName}
                            </div>
                            {tx.notes && (
                              <div style={{ marginTop: 2 }} onClick={(e) => e.stopPropagation()}>
                                <span style={{ fontSize: 11, color: "var(--accent)", fontStyle: "italic" }}>{tx.notes}</span>
                              </div>
                            )}
                            {tx.merchantNormalized && tx.merchantNormalized !== tx.description && (
                              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1, overflow: isExpanded ? "visible" : "hidden", textOverflow: isExpanded ? "unset" : "ellipsis", whiteSpace: isExpanded ? "normal" : "nowrap" }}>
                                {tx.description}
                              </div>
                            )}
                            {!isExpanded && (tx.merchantNormalized || tx.description).length > 35 && (
                              <div className="expand-hint" style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1 }}>click to expand</div>
                            )}
                          </div>
                        </td>

                        {/* Category badge */}
                        <td style={{ padding: "10px 16px" }}>
                          {tx.categoryName
                            ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: (tx.categoryColor ?? "#888") + "22", color: tx.categoryColor ?? "var(--text-muted)", whiteSpace: "nowrap" }}>
                                {tx.parentCategoryName && <span style={{ opacity: 0.6 }}>{tx.parentCategoryName} › </span>}
                                {tx.categoryName}
                              </span>
                            : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                        </td>

                        {/* Account */}
                        <td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.accountName ?? "—"}</td>

                        {/* Amount */}
                        <td style={{ padding: "10px 16px", textAlign: "right", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: isIncome ? "var(--income)" : "var(--expense)" }}>
                            {isIncome ? "+" : ""}{formatCurrency(amt, "MYR")}
                          </span>
                        </td>

                        {/* Hover actions */}
                        <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 4, opacity: 0, transition: "opacity 0.15s" }} className="row-actions">
                            <ActionBtn color="var(--accent)" title="Ask AI" onClick={() => { setAgentContext({ id: tx.id, description: tx.description, merchantNormalized: tx.merchantNormalized, amount: tx.amount, postedAt: tx.postedAt, categoryName: tx.categoryName, notes: tx.notes }); setAgentOpen(true); }}>✦</ActionBtn>
                            <ActionBtn color="var(--text-muted)" title="Edit" onClick={() => setEditingId(isEditing ? null : tx.id)}>✎</ActionBtn>
                            <ActionBtn color="var(--text-muted)" title={tx.hidden ? "Unhide" : "Hide from list"} disabled={hidingId === tx.id} onClick={() => toggleHidden(tx)}>{tx.hidden ? "🚫" : "⊘"}</ActionBtn>
                            <ActionBtn color="var(--expense)" title="Delete" onClick={() => setConfirmDelete(tx)}>✕</ActionBtn>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {totalPages > 1 && (
              <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)" }}>Page {page} of {totalPages}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <PageBtn disabled={page === 1} onClick={() => setPage((p) => p - 1)}>← Prev</PageBtn>
                  <PageBtn disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>Next →</PageBtn>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── HISTORY TAB ── */}
      {tab === "history" && (
        <div className="fade-up fade-up-2" style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          {batches.length === 0 ? (
            <div style={{ padding: 48, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No imports yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Date", "File", "Account", "Imported", "Status", ""].map((h, i) => (
                    <th key={i} style={{ padding: "10px 20px", textAlign: "left", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-3)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "12px 20px", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                      {new Date(b.createdAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                    </td>
                    <td style={{ padding: "12px 20px", fontSize: 13, color: "var(--text)" }}>{b.filename}</td>
                    <td style={{ padding: "12px 20px", fontSize: 12, color: "var(--text-muted)" }}>{b.accountName ?? "—"}</td>
                    <td style={{ padding: "12px 20px", fontSize: 13, fontFamily: "var(--font-ibm-mono)", color: "var(--income)" }}>{b.importedRows ?? 0}</td>
                    <td style={{ padding: "12px 20px" }}>
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: b.status === "complete" ? "var(--income-dim)" : "var(--accent-dim)", color: b.status === "complete" ? "var(--income)" : "var(--accent)" }}>
                        {b.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <button
                        onClick={() => deleteBatch(b.id)}
                        disabled={deletingBatch === b.id}
                        title="Undo this import (deletes all its transactions)"
                        style={{ background: "none", border: "1px solid var(--border-2)", borderRadius: 4, color: "var(--expense)", fontSize: 11, padding: "3px 10px", cursor: "pointer", opacity: deletingBatch === b.id ? 0.4 : 1 }}
                      >
                        {deletingBatch === b.id ? "…" : "Undo"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TRASH TAB ── */}
      {tab === "trash" && (
        <div className="fade-up fade-up-2" style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          {trashLoading ? (
            <div style={{ padding: 24 }}>{[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />)}</div>
          ) : trashItems.length === 0 ? (
            <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Trash is empty — deleted transactions will appear here.
            </div>
          ) : (
            <>
              <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{trashItems.length} deleted transaction{trashItems.length !== 1 ? "s" : ""}</span>
                <button
                  onClick={emptyTrash}
                  disabled={emptyingTrash}
                  style={{ padding: "5px 14px", borderRadius: 5, border: "1px solid #f8717133", background: "var(--expense-dim)", color: "var(--expense)", fontSize: 12, cursor: emptyingTrash ? "wait" : "pointer", fontFamily: "inherit" }}
                >
                  {emptyingTrash ? "Emptying…" : "Empty trash"}
                </button>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Deleted", "Merchant", "Date", "Amount", "Category", "From Import", ""].map((h, i) => (
                      <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trashItems.map((item) => {
                    const amt = parseFloat(item.amount);
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid var(--border)", opacity: restoringId === item.id ? 0.4 : 1, transition: "opacity 0.2s" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-3)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                      >
                        <td style={{ padding: "10px 16px", fontSize: 11, color: "var(--expense)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                          {new Date(item.deletedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td style={{ padding: "10px 16px", maxWidth: 240 }}>
                          <div style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.merchantNormalized || item.description}
                          </div>
                          {item.merchantNormalized && item.merchantNormalized !== item.description && (
                            <div style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.description}</div>
                          )}
                        </td>
                        <td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                          {new Date(item.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })}
                        </td>
                        <td style={{ padding: "10px 16px", fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500, color: amt > 0 ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap" }}>
                          {amt > 0 ? "+" : ""}{formatCurrency(amt, "MYR")}
                        </td>
                        <td style={{ padding: "10px 16px" }}>
                          {item.categoryName ? (
                            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: (item.categoryColor ?? "#888") + "22", color: item.categoryColor ?? "var(--text-muted)" }}>
                              {item.categoryName}
                            </span>
                          ) : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                        </td>
                        <td style={{ padding: "10px 16px", fontSize: 11, color: "var(--text-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {item.batchFilename ?? "—"}
                        </td>
                        <td style={{ padding: "10px 12px" }}>
                          <div style={{ display: "flex", gap: 6 }}>
                            <button
                              onClick={() => restoreTransaction(item.id)}
                              disabled={restoringId === item.id || purgingId === item.id}
                              style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid var(--border-2)", background: "var(--bg-3)", color: "var(--income)", fontSize: 12, cursor: "pointer" }}
                            >
                              {restoringId === item.id ? "…" : "Restore"}
                            </button>
                            <button
                              onClick={() => permanentlyDelete(item.id)}
                              disabled={purgingId === item.id || restoringId === item.id}
                              title="Delete forever"
                              style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid #f8717133", background: "transparent", color: "var(--expense)", fontSize: 12, cursor: "pointer" }}
                            >
                              {purgingId === item.id ? "…" : "Delete forever"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* ── EDIT PANEL ── */}
      <TransactionEditPanel
        transaction={transactions.find((t) => t.id === editingId) ?? null}
        categories={categories}
        onClose={() => setEditingId(null)}
        onSaved={handleEditSaved}
        onCategoryCreated={(cat) => setCategories((prev) => [...prev, cat])}
      />

      {/* ── DELETE CONFIRM ── */}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete transaction?"
        description={confirmDelete ? `${confirmDelete.merchantNormalized || confirmDelete.description} · ${new Date(confirmDelete.postedAt).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" })} · ${parseFloat(confirmDelete.amount) < 0 ? "-" : "+"}MYR ${Math.abs(parseFloat(confirmDelete.amount)).toFixed(2)}` : undefined}
        confirmLabel="Delete"
        confirmColor="var(--expense)"
        onConfirm={confirmDeleteTransaction}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* ── AGENT CHAT ── */}
      <AgentChat
        open={agentOpen}
        onClose={() => { setAgentOpen(false); setAgentContext(null); }}
        onTransactionsChanged={() => fetchAll(filters, page)}
        contextTransaction={agentContext}
      />

      {/* ── ADD TRANSACTION MODAL ── */}
      {showAdd && (
        <AddModal
          categories={categories}
          accounts={accounts}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); fetchAll(filters, page); }}
        />
      )}

      <style>{`
        tr:hover .row-actions { opacity: 1 !important; }
      `}</style>
    </div>
  );
}

function AddModal({ categories: initialCategories, accounts, onClose, onSaved }: {
  categories: Category[]; accounts: Account[];
  onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ description: "", amount: "", postedAt: today(), accountId: accounts[0]?.id ? String(accounts[0].id) : "", categoryId: "" as string | number, notes: "" });
  const [saving, setSaving] = useState(false);
  const [localCategories, setLocalCategories] = useState(initialCategories);
  const [selectedCategory, setSelectedCategory] = useState<CategoryValue | null>(null);

  async function submit() {
    if (!form.description || !form.amount || !form.accountId) return;
    setSaving(true);
    await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        amount: parseFloat(form.amount as string),
        accountId: parseInt(form.accountId),
        categoryId: selectedCategory?.id ?? null,
      }),
    });
    setSaving(false);
    onSaved();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000088", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10, padding: 28, width: 480, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 18, fontWeight: 700, marginBottom: 20, color: "var(--text)" }}>Add Transaction</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Description *">
            <input type="text" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} style={{ ...selectStyle, width: "100%" }} placeholder="e.g. Lunch at Nasi Kandar" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Amount * (negative = expense)">
              <input type="number" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} style={{ ...selectStyle, width: "100%" }} placeholder="-25.00" />
            </Field>
            <Field label="Date *">
              <input type="date" value={form.postedAt} onChange={(e) => setForm((f) => ({ ...f, postedAt: e.target.value }))} style={{ ...selectStyle, width: "100%" }} />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Account *">
              <select value={form.accountId} onChange={(e) => setForm((f) => ({ ...f, accountId: e.target.value }))} style={{ ...selectStyle, width: "100%" }}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
            <Field label="Category">
              <CategoryCombobox
                value={selectedCategory}
                onChange={(cat) => setSelectedCategory(cat)}
                categories={localCategories}
                onCategoryCreated={(cat) => setLocalCategories((prev) => [...prev, cat])}
                placeholder="Uncategorized"
              />
            </Field>
          </div>
          <Field label="Notes">
            <input type="text" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} style={{ ...selectStyle, width: "100%" }} placeholder="Optional" />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 22, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 6, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer" }}>Cancel</button>
          <button onClick={submit} disabled={saving || !form.description || !form.amount || !form.accountId} style={{ padding: "8px 18px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#000", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {saving ? "Saving…" : "Add Transaction"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterInput({ label, type, value, onChange }: { label: string; type: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={labelStyle}>{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={selectStyle} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function ActionBtn({ children, onClick, color, disabled, title }: { children: React.ReactNode; onClick: () => void; color?: string; disabled?: boolean; title?: string }) {
  return (
    <button title={title} onClick={onClick} disabled={disabled} style={{ background: "none", border: "none", color: color ?? "var(--text-muted)", cursor: disabled ? "wait" : "pointer", fontSize: 13, padding: "2px 5px", borderRadius: 3 }}>
      {children}
    </button>
  );
}

function PageBtn({ onClick, disabled, children }: { onClick: () => void; disabled: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ padding: "6px 14px", borderRadius: 5, border: "1px solid var(--border-2)", background: "var(--bg-3)", color: disabled ? "var(--text-dim)" : "var(--text)", fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "var(--font-ibm-mono)" }}>
      {children}
    </button>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" };
