"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatCurrency, startOfMonth, today, formatTxDate, formatTxTime } from "@/lib/format";
import ReviewQueue from "@/components/ReviewQueue";
import AgentChat, { ContextTransaction } from "@/components/AgentChat";
import CategoryCombobox, { CategoryValue } from "@/components/CategoryCombobox";
import FilterCategoryCombobox from "@/components/FilterCategoryCombobox";
import TransactionEditPanel, { DetailTransaction } from "@/components/TransactionEditPanel";
import ConfirmDialog from "@/components/ConfirmDialog";
import ReimbursePicker from "@/components/ReimbursePicker";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { QK } from "@/lib/queryKeys";

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
  reimbursementForId: number | null;
  reimbursementForName: string | null;
  reimbursementForAmount: string | null;
  reimbursementForPostedAt: string | null;
  reimbursedTotal: string | null;
  notes: string | null;
}

interface Category { id: number; name: string; color: string | null; parentId: number | null; isTransfer?: boolean; }
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

interface TxListData {
  rows: Transaction[];
  total: number;
  totalIncome: number;   // true income across the whole filtered range (excl. transfers/repayments)
  totalExpense: number;
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

  const queryClient = useQueryClient();

  // ── UI state (kept as local state) ────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<"list" | "history" | "trash">("list");
  const [filters, setFilters] = useState({
    from: fromParam || startOfMonth(),
    to: toParam || today(),
    accountId: "",
    categoryId: filterParam === "uncategorized" ? "none" : (categoryIdParam || ""),
    search: "",
  });
  const [searchInput, setSearchInput] = useState(filters.search);
  const [showHidden, setShowHidden] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  // A linked expense may fall outside the current filter range; when the panel needs
  // one that isn't in the loaded rows, we fetch it on demand and stash it here.
  const [fetchedDetail, setFetchedDetail] = useState<Transaction | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DetailTransaction | null>(null);
  const [reimburseFor, setReimburseFor] = useState<DetailTransaction | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentContext, setAgentContext] = useState<ContextTransaction | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);   // header "⋯ More" menu
  const [kebabFor, setKebabFor] = useState<number | null>(null);  // per-row "⋯" menu
  const LIMIT = 50;

  // Build query key params object
  const txFilterParams: Record<string, string | number | boolean> = {
    page,
    limit: LIMIT,
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.accountId ? { accountId: filters.accountId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    ...(showHidden ? { includeHidden: true } : {}),
  };
  const txKey = QK.transactions(txFilterParams);

  // ── Queries ───────────────────────────────────────────────────────────────

  const { data: txData, isLoading: loading } = useQuery<TxListData>({
    queryKey: txKey,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(LIMIT), page: String(page) });
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.accountId) params.set("accountId", filters.accountId);
      if (filters.categoryId) params.set("categoryId", filters.categoryId);
      if (filters.search) params.set("search", filters.search);
      if (showHidden) params.set("includeHidden", "1");
      return fetch(`/api/transactions?${params}`).then((r) => r.json());
    },
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: QK.categories(),
    queryFn: () => fetch("/api/categories").then((r) => r.json()),
  });

  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: QK.accounts(),
    queryFn: () => fetch("/api/accounts").then((r) => r.json()),
  });

  const { data: batches = [] } = useQuery<ImportBatch[]>({
    queryKey: QK.batches(),
    queryFn: () => fetch("/api/import-batches").then((r) => r.json()),
  });

  const { data: trashItems = [], isLoading: trashLoading } = useQuery<TrashItem[]>({
    queryKey: QK.trash(),
    queryFn: () => fetch("/api/trash").then((r) => r.json()),
    enabled: tab === "trash",
  });

  const transactions = txData?.rows ?? [];
  const total = txData?.total ?? 0;

  // ── Debounce search ────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, search: searchInput }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── Cmd+K / Ctrl+K → open agent chat ──────────────────────────────────────
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

  // ── Close popover menus on any outside click ───────────────────────────────
  useEffect(() => {
    if (!moreOpen && kebabFor == null) return;
    const close = () => { setMoreOpen(false); setKebabFor(null); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [moreOpen, kebabFor]);

  // ── Mutations ─────────────────────────────────────────────────────────────

  const deleteTransactionMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/transactions/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onMutate: async (id) => {
      setDeletingId(id);
      await queryClient.cancelQueries({ queryKey: ['transactions'] });
      const prev = queryClient.getQueryData<TxListData>(txKey);
      queryClient.setQueryData<TxListData>(txKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          rows: old.rows.filter((t) => t.id !== id),
          total: (old.total ?? 0) - 1,
        };
      });
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(txKey, ctx.prev);
    },
    onSettled: () => {
      setDeletingId(null);
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const restoreTransactionMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/trash/${id}`, { method: "POST" }).then((r) => r.json()),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: QK.trash() });
      const prev = queryClient.getQueryData<TrashItem[]>(QK.trash());
      queryClient.setQueryData<TrashItem[]>(QK.trash(), (old) =>
        (old ?? []).filter((t) => t.id !== id)
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QK.trash(), ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.trash() });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/trash/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: QK.trash() });
      const prev = queryClient.getQueryData<TrashItem[]>(QK.trash());
      queryClient.setQueryData<TrashItem[]>(QK.trash(), (old) =>
        (old ?? []).filter((t) => t.id !== id)
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QK.trash(), ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.trash() });
    },
  });

  const emptyTrashMutation = useMutation({
    mutationFn: () =>
      fetch("/api/trash", { method: "DELETE" }).then((r) => r.json()),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: QK.trash() });
      const prev = queryClient.getQueryData<TrashItem[]>(QK.trash());
      queryClient.setQueryData<TrashItem[]>(QK.trash(), []);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QK.trash(), ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.trash() });
    },
  });

  const toggleHiddenMutation = useMutation({
    mutationFn: ({ id, hidden }: { id: number; hidden: boolean }) =>
      fetch(`/api/transactions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden }),
      }).then((r) => r.json()),
    onMutate: async ({ id, hidden }) => {
      await queryClient.cancelQueries({ queryKey: txKey });
      const prev = queryClient.getQueryData<TxListData>(txKey);
      queryClient.setQueryData<TxListData>(txKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          rows: showHidden
            ? old.rows.map((t) => t.id === id ? { ...t, hidden } : t)
            : old.rows.filter((t) => t.id !== id),
        };
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(txKey, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const reimburseMutation = useMutation({
    mutationFn: ({ repaymentId, expenseId }: { repaymentId: number; expenseId: number | null }) =>
      fetch(`/api/transactions/${repaymentId}/reimburse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expenseId }),
      }).then((r) => r.json()),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['review-queue'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
  });

  const bulkCategorizeMutation = useMutation({
    mutationFn: () =>
      fetch("/api/transactions/bulk-categorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json()),
    onSuccess: (data) => {
      setBulkResult(`Categorized ${data.updated} of ${data.total} transactions`);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const deleteBatchMutation = useMutation({
    mutationFn: (batchId: number) =>
      fetch(`/api/import-batches/${batchId}`, { method: "DELETE" }).then((r) => r.json()),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.batches() });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const addTransactionMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => {
      setShowAdd(false);
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  // ── Derived ───────────────────────────────────────────────────────────────

  const uncategorizedCount = transactions.filter((tx) => !tx.categoryId).length;
  // True income/expense for the whole filtered range — computed server-side (not a page sum),
  // excludes transfers + repayments, and stable regardless of the hidden toggle.
  const totalIncome = txData?.totalIncome ?? 0;
  const totalExpense = txData?.totalExpense ?? 0;
  const totalPages = Math.ceil(total / LIMIT);

  // The transaction shown in the detail panel: prefer the live row (stays fresh after
  // edits); fall back to a fetched out-of-range transaction.
  const detailTx =
    transactions.find((t) => t.id === editingId) ??
    (fetchedDetail?.id === editingId ? fetchedDetail : null);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function hideGoPlusNoise() {
    const res = await fetch("/api/transactions/hide-noise", { method: "POST" });
    const data = await res.json();
    setBulkResult(data.hidden > 0 ? `Hid ${data.hidden} GO+ internal leg${data.hidden !== 1 ? "s" : ""}` : "No GO+ noise found to hide");
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }

  function handleEditSaved() {
    setEditingId(null);
    setFetchedDetail(null);
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
  }

  function closeDetail() {
    setEditingId(null);
    setFetchedDetail(null);
  }

  // Open the detail panel for a transaction. If it isn't in the loaded rows
  // (e.g. a linked expense outside the current date range), fetch it on demand.
  async function openDetail(id: number) {
    setEditingId(id);
    const inRows = transactions.some((t) => t.id === id);
    if (inRows) { setFetchedDetail(null); return; }
    try {
      const tx = await fetch(`/api/transactions/${id}`).then((r) => r.json());
      if (tx && !tx.error) setFetchedDetail(tx as Transaction);
    } catch { /* leave panel empty if it fails */ }
  }

  function confirmDeleteTransaction() {
    if (!confirmDelete) return;
    setConfirmDelete(null);
    deleteTransactionMutation.mutate(confirmDelete.id);
  }

  function permanentlyDelete(txId: number) {
    if (!confirm("Permanently delete this transaction? This cannot be undone.")) return;
    permanentDeleteMutation.mutate(txId);
  }

  function emptyTrash() {
    if (!confirm(`Permanently delete all ${trashItems.length} transaction${trashItems.length !== 1 ? "s" : ""} in trash? This cannot be undone.`)) return;
    emptyTrashMutation.mutate();
  }

  function deleteBatch(batchId: number) {
    if (!confirm("Delete this import and all its transactions? This cannot be undone.")) return;
    deleteBatchMutation.mutate(batchId);
  }

  // ── Render ────────────────────────────────────────────────────────────────

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
            <button onClick={() => bulkCategorizeMutation.mutate()} disabled={bulkCategorizeMutation.isPending} style={{
              padding: "7px 14px", borderRadius: 6, border: "1px solid #c9a84c44",
              background: "var(--accent-dim)", color: "var(--accent)", fontSize: 12,
              cursor: bulkCategorizeMutation.isPending ? "wait" : "pointer", fontFamily: "inherit",
            }}>
              {bulkCategorizeMutation.isPending ? "Categorizing…" : `✦ AI categorize ${uncategorizedCount}`}
            </button>
          )}
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

          {/* ⋯ More — occasional/maintenance actions */}
          <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMoreOpen((s) => !s)} title="More options" style={{
              padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border-2)",
              background: moreOpen ? "var(--bg-3)" : "transparent", color: "var(--text-muted)", fontSize: 14, cursor: "pointer", fontFamily: "inherit", lineHeight: 1,
            }}>
              ⋯{showHidden && <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", marginLeft: 6, verticalAlign: "middle" }} />}
            </button>
            {moreOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60, minWidth: 210, background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 8, padding: 6, boxShadow: "0 8px 28px #00000055" }}>
                <MenuItem onClick={() => { setShowHidden((s) => !s); setMoreOpen(false); }}>
                  {showHidden ? "✓ Showing hidden" : "Show hidden transactions"}
                </MenuItem>
                <MenuItem onClick={() => { hideGoPlusNoise(); setMoreOpen(false); }}>
                  Hide GO+ noise
                </MenuItem>
              </div>
            )}
          </div>
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
        onResolved={() => queryClient.invalidateQueries({ queryKey: ['transactions'] })}
        onCategoryCreated={(cat) => {
          queryClient.setQueryData<Category[]>(QK.categories(), (old) => [...(old ?? []), cat]);
        }}
      />

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16, borderBottom: "1px solid var(--border)" }}>
        {(["list", "history", "trash"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
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
                    const repaid = tx.reimbursedTotal != null ? parseFloat(tx.reimbursedTotal) : 0;
                    const isRepaidExpense = !tx.reimbursementForId && repaid !== 0;
                    const net = amt + repaid;

                    return (
                      <tr
                        key={tx.id}
                        onClick={() => openDetail(tx.id)}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          background: isEditing ? "var(--accent-dim)" : isDeleting ? "var(--expense-dim)" : "transparent",
                          borderLeft: isEditing ? "3px solid var(--accent)" : "3px solid transparent",
                          transition: "background 0.15s, border-color 0.15s",
                          opacity: isDeleting ? 0.5 : tx.hidden ? 0.45 : 1,
                          cursor: "pointer",
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
                        <td style={{ padding: "10px 16px", maxWidth: 300 }}>
                          <div style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {displayName}
                          </div>
                          {tx.notes && (
                            <div style={{ fontSize: 11, color: "var(--accent)", fontStyle: "italic", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.notes}</div>
                          )}
                          {tx.merchantNormalized && tx.merchantNormalized !== tx.description && (
                            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {tx.description}
                            </div>
                          )}
                        </td>

                        {/* Category badge (or repayment indicator) */}
                        <td style={{ padding: "10px 16px" }}>
                          {tx.reimbursementForId
                            ? <span title={`Repayment netted into "${tx.reimbursementForName ?? "an expense"}" — not counted as its own income`} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: "var(--accent-dim)", color: "var(--accent)", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", display: "inline-block", verticalAlign: "bottom" }}>↩ Repayment{tx.reimbursementForName ? ` → ${tx.reimbursementForName}` : ""}</span>
                            : tx.categoryName
                              ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: (tx.categoryColor ?? "#888") + "22", color: tx.categoryColor ?? "var(--text-muted)", whiteSpace: "nowrap" }}>
                                  {tx.parentCategoryName && <span style={{ opacity: 0.6 }}>{tx.parentCategoryName} › </span>}
                                  {tx.categoryName}
                                </span>
                              : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                        </td>

                        {/* Account */}
                        <td style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.accountName ?? "—"}</td>

                        {/* Amount (net for repaid expenses) */}
                        <td style={{ padding: "10px 16px", textAlign: "right", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                          {isRepaidExpense ? (
                            <>
                              <span title="Your net cost after repayments" style={{ fontSize: 13, fontWeight: 600, color: net < 0 ? "var(--expense)" : "var(--income)" }}>
                                {net > 0 ? "+" : ""}{formatCurrency(net, "MYR")}
                              </span>
                              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1 }}>
                                <span style={{ textDecoration: "line-through" }}>{formatCurrency(amt, "MYR")}</span>
                                {" · "}repaid +{formatCurrency(Math.abs(repaid), "MYR")}
                              </div>
                            </>
                          ) : (
                            <span style={{ fontSize: 13, fontWeight: 500, color: isIncome ? "var(--income)" : "var(--expense)" }}>
                              {isIncome ? "+" : ""}{formatCurrency(amt, "MYR")}
                            </span>
                          )}
                        </td>

                        {/* Per-row kebab — quick actions (full set lives in the detail panel) */}
                        <td style={{ padding: "10px 12px", whiteSpace: "nowrap", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                          <div style={{ position: "relative", display: "inline-block" }}>
                            <button
                              className="row-kebab"
                              title="Quick actions"
                              onClick={(e) => { e.stopPropagation(); setKebabFor(kebabFor === tx.id ? null : tx.id); }}
                              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 16, padding: "2px 6px", borderRadius: 4, lineHeight: 1 }}
                            >
                              ⋯
                            </button>
                            {kebabFor === tx.id && (
                              <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 40, minWidth: 150, background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 8, padding: 6, boxShadow: "0 8px 28px #00000055", textAlign: "left" }}>
                                <MenuItem onClick={() => { toggleHiddenMutation.mutate({ id: tx.id, hidden: !tx.hidden }); setKebabFor(null); }}>
                                  {tx.hidden ? "Unhide" : "Hide from list"}
                                </MenuItem>
                                <MenuItem danger onClick={() => { setConfirmDelete(tx); setKebabFor(null); }}>
                                  Delete
                                </MenuItem>
                              </div>
                            )}
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
                        disabled={deleteBatchMutation.isPending && deleteBatchMutation.variables === b.id}
                        title="Undo this import (deletes all its transactions)"
                        style={{ background: "none", border: "1px solid var(--border-2)", borderRadius: 4, color: "var(--expense)", fontSize: 11, padding: "3px 10px", cursor: "pointer", opacity: (deleteBatchMutation.isPending && deleteBatchMutation.variables === b.id) ? 0.4 : 1 }}
                      >
                        {deleteBatchMutation.isPending && deleteBatchMutation.variables === b.id ? "…" : "Undo"}
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
                  disabled={emptyTrashMutation.isPending}
                  style={{ padding: "5px 14px", borderRadius: 5, border: "1px solid #f8717133", background: "var(--expense-dim)", color: "var(--expense)", fontSize: 12, cursor: emptyTrashMutation.isPending ? "wait" : "pointer", fontFamily: "inherit" }}
                >
                  {emptyTrashMutation.isPending ? "Emptying…" : "Empty trash"}
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
                    const isRestoring = restoreTransactionMutation.isPending && restoreTransactionMutation.variables === item.id;
                    const isPurging = permanentDeleteMutation.isPending && permanentDeleteMutation.variables === item.id;
                    return (
                      <tr key={item.id} style={{ borderBottom: "1px solid var(--border)", opacity: isRestoring ? 0.4 : 1, transition: "opacity 0.2s" }}
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
                              onClick={() => restoreTransactionMutation.mutate(item.id)}
                              disabled={isRestoring || isPurging}
                              style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid var(--border-2)", background: "var(--bg-3)", color: "var(--income)", fontSize: 12, cursor: "pointer" }}
                            >
                              {isRestoring ? "…" : "Restore"}
                            </button>
                            <button
                              onClick={() => permanentlyDelete(item.id)}
                              disabled={isPurging || isRestoring}
                              title="Delete forever"
                              style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid #f8717133", background: "transparent", color: "var(--expense)", fontSize: 12, cursor: "pointer" }}
                            >
                              {isPurging ? "…" : "Delete forever"}
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
        transaction={detailTx}
        categories={categories}
        onClose={closeDetail}
        onSaved={handleEditSaved}
        onCategoryCreated={(cat) => {
          queryClient.setQueryData<Category[]>(QK.categories(), (old) => [...(old ?? []), cat]);
        }}
        onAskAI={(tx) => {
          setAgentContext({ id: tx.id, description: tx.description, merchantNormalized: tx.merchantNormalized, amount: tx.amount, postedAt: tx.postedAt, categoryName: tx.categoryName, notes: tx.notes });
          setAgentOpen(true);
          closeDetail();
        }}
        onToggleHidden={(tx) => toggleHiddenMutation.mutate({ id: tx.id, hidden: !tx.hidden })}
        onDelete={(tx) => { setConfirmDelete(tx); closeDetail(); }}
        onReimburse={(tx) => setReimburseFor(tx)}
        onOpenLinked={(id) => openDetail(id)}
        hidingBusy={toggleHiddenMutation.isPending}
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
        onTransactionsChanged={() => queryClient.invalidateQueries({ queryKey: ['transactions'] })}
        contextTransaction={agentContext}
      />

      {/* ── ADD TRANSACTION MODAL ── */}
      {showAdd && (
        <AddModal
          categories={categories}
          accounts={accounts}
          onClose={() => setShowAdd(false)}
          onSaved={(body) => addTransactionMutation.mutate(body)}
        />
      )}

      {/* ── REIMBURSEMENT PICKER ── */}
      {reimburseFor && (
        <ReimbursePicker
          repayment={reimburseFor}
          busy={reimburseMutation.isPending}
          onPick={(expenseId) => { reimburseMutation.mutate({ repaymentId: reimburseFor.id, expenseId }); setReimburseFor(null); }}
          onClose={() => setReimburseFor(null)}
        />
      )}

      <style>{`
        .row-kebab { opacity: 0; transition: opacity 0.15s; }
        tr:hover .row-kebab { opacity: 1; }
        .row-kebab:hover { background: var(--bg-2) !important; color: var(--text) !important; }
      `}</style>
    </div>
  );
}

function AddModal({ categories: initialCategories, accounts, onClose, onSaved }: {
  categories: Category[]; accounts: Account[];
  onClose: () => void; onSaved: (body: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({ description: "", amount: "", postedAt: today(), accountId: accounts[0]?.id ? String(accounts[0].id) : "", categoryId: "" as string | number, notes: "" });
  const [amountType, setAmountType] = useState<"expense" | "income">("expense");
  const [saving, setSaving] = useState(false);
  const [localCategories, setLocalCategories] = useState(initialCategories);
  const [selectedCategory, setSelectedCategory] = useState<CategoryValue | null>(null);

  async function submit() {
    if (!form.description || !form.amount || !form.accountId) return;
    setSaving(true);
    const absAmount = Math.abs(parseFloat(form.amount as string));
    onSaved({
      ...form,
      amount: amountType === "expense" ? -absAmount : absAmount,
      accountId: parseInt(form.accountId),
      categoryId: selectedCategory?.id ?? null,
    });
    setSaving(false);
  }

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    padding: "7px 16px", borderRadius: 5, border: "none", fontSize: 12, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
    background: active ? (amountType === "expense" ? "var(--expense)" : "var(--income)") : "var(--bg-3)",
    color: active ? "#fff" : "var(--text-muted)",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000088", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onClose}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10, padding: 28, width: 480, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 18, fontWeight: 700, marginBottom: 20, color: "var(--text)" }}>Add Transaction</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Description *">
            <input type="text" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} style={{ ...selectStyle, width: "100%" }} placeholder="e.g. Lunch at Nasi Kandar" />
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Amount *">
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ display: "flex", background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 6, padding: 3, gap: 2, flexShrink: 0 }}>
                  <button type="button" onClick={() => setAmountType("expense")} style={toggleStyle(amountType === "expense")}>Expense</button>
                  <button type="button" onClick={() => setAmountType("income")} style={toggleStyle(amountType === "income")}>Income</button>
                </div>
                <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} style={{ ...selectStyle, width: "100%", minWidth: 0 }} placeholder="25.00" />
              </div>
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

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 5,
        background: "none", border: "none", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
        color: danger ? "var(--expense)" : "var(--text)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-3)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
    >
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
