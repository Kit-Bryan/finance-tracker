"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { formatCurrency, formatMonth, formatTxDate, formatTxTime } from "@/lib/format";
import NeedsAttention from "@/components/NeedsAttention";

interface InsightsData {
  summary: {
    totalIncome: number;
    totalExpense: number;
    net: number;
    txCount: number;
    uncategorized: number;
  };
  byCategory: {
    categoryId: number | null;
    categoryName: string | null;
    categoryColor: string | null;
    total: number;
    count: number;
  }[];
  monthlyTrend: { month: string; income: string; expense: string }[];
}

interface Transaction {
  id: number;
  postedAt: string;
  description: string;
  merchantNormalized: string | null;
  amount: string;
  categoryName: string | null;
  categoryColor: string | null;
  parentCategoryName: string | null;
  accountName: string | null;
  notes: string | null;
}

// ── Month nav helpers ─────────────────────────────────────────────────────────

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string) {
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleDateString("en-MY", { month: "long", year: "numeric" });
}

function monthRange(key: string) {
  const [y, m] = key.split("-").map(Number);
  const from = new Date(y, m - 1, 1).toISOString().slice(0, 10);
  const to = new Date(y, m, 0).toISOString().slice(0, 10); // last day of month
  return { from, to };
}

function shiftMonth(key: string, delta: number) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

// ── Components ────────────────────────────────────────────────────────────────

function SummaryCard({ label, value, type, sub }: { label: string; value: number; type: "income" | "expense" | "net"; sub?: string }) {
  const color = type === "income" ? "var(--income)" : type === "expense" ? "var(--expense)" : "var(--accent)";
  const bg = type === "income" ? "var(--income-dim)" : type === "expense" ? "var(--expense-dim)" : "var(--accent-dim)";
  const tag = type === "income" ? "IN" : type === "expense" ? "OUT" : "NET";
  return (
    <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>{label}</span>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: bg, color, fontFamily: "var(--font-ibm-mono)" }}>{tag}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, color, letterSpacing: "-0.02em", fontFamily: "var(--font-ibm-mono)" }}>
        {formatCurrency(value, "MYR")}
      </div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 6, padding: "10px 14px", fontSize: 12, fontFamily: "var(--font-ibm-mono)" }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 4, fontSize: 11 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.fill }}>{formatCurrency(Math.abs(p.value), "MYR")}</div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  // Start with current month, but auto-correct to most recent month with data
  const [month, setMonth] = useState(monthKey(new Date()));
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [recentTx, setRecentTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoSeeked, setAutoSeeked] = useState(false);

  const { from, to } = monthRange(month);
  const currentMonthKey = monthKey(new Date());
  const isCurrentMonth = month === currentMonthKey;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/insights?from=${from}&to=${to}`).then((r) => r.json()),
      fetch(`/api/transactions?limit=8&from=${from}&to=${to}`).then((r) => r.json()),
    ]).then(([ins, txData]) => {
      setInsights(ins);
      setRecentTx(txData.rows ?? []);
      setLoading(false);

      // If current month has no data and we haven't auto-sought yet, go to most recent trend month
      if (!autoSeeked && ins.summary.txCount === 0 && ins.monthlyTrend?.length > 0) {
        const lastMonth = ins.monthlyTrend[ins.monthlyTrend.length - 1]?.month;
        if (lastMonth && lastMonth !== month) {
          setMonth(lastMonth);
        }
        setAutoSeeked(true);
      }
    });
  }, [from, to]);

  const topExpenses = (insights?.byCategory ?? [])
    .filter((c) => c.total < 0)
    .sort((a, b) => a.total - b.total)
    .slice(0, 8)
    .map((c) => ({ ...c, abs: Math.abs(c.total) }));

  const trendData = (insights?.monthlyTrend ?? []).map((m) => ({
    month: formatMonth(m.month),
    income: parseFloat(m.income ?? "0"),
    expense: Math.abs(parseFloat(m.expense ?? "0")),
  }));

  const savingsRate = insights && insights.summary.totalIncome > 0
    ? Math.round((insights.summary.net / insights.summary.totalIncome) * 100)
    : null;

  return (
    <div style={{ padding: "28px 36px", maxWidth: 1100, margin: "0 auto" }}>

      {/* Header + month nav */}
      <div className="fade-up fade-up-1" style={{ marginBottom: 28, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-syne)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text)" }}>Overview</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 3 }}>{monthLabel(month)}</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <NavBtn onClick={() => setMonth((m) => shiftMonth(m, -1))}>←</NavBtn>
          <div style={{ fontSize: 13, color: "var(--text)", minWidth: 110, textAlign: "center", fontFamily: "var(--font-ibm-mono)" }}>
            {monthLabel(month).split(" ")[0]} {monthLabel(month).split(" ")[1]}
          </div>
          <NavBtn onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={isCurrentMonth}>→</NavBtn>
          {!isCurrentMonth && (
            <button onClick={() => setMonth(currentMonthKey)}
              style={{ marginLeft: 6, fontSize: 11, color: "var(--text-muted)", background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontFamily: "inherit" }}>
              Today
            </button>
          )}
        </div>
      </div>

      {/* Proactive flags feed */}
      <NeedsAttention />

      {/* No data state */}
      {!loading && insights?.summary.txCount === 0 && (
        insights?.monthlyTrend.length === 0 ? (
          // First-time user — no data at all
          <div className="fade-up fade-up-2" style={{ padding: "56px 32px", textAlign: "center", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24 }}>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-syne)", letterSpacing: "-0.02em", color: "var(--text)", marginBottom: 8 }}>Welcome to Finance Tracker</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 28, maxWidth: 360, margin: "0 auto 28px" }}>
              Import your first bank statement to start tracking spending, spotting patterns, and getting AI-powered insights.
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginBottom: 28 }}>
              {[
                "Upload a CSV, PDF, or screenshot of any bank statement",
                "Transactions are auto-categorized using AI",
                "Ask the agent to find, edit, or explain any transaction",
              ].map((step, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text-muted)" }}>
                  <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--accent)", color: "#fff", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                  {step}
                </div>
              ))}
            </div>
            <Link href="/import" style={{ display: "inline-block", padding: "9px 20px", background: "var(--accent)", color: "#fff", borderRadius: 6, fontSize: 13, fontWeight: 500, textDecoration: "none" }}>
              Import your first statement →
            </Link>
          </div>
        ) : (
          // Month with no data
          <div className="fade-up fade-up-2" style={{ padding: "40px 32px", textAlign: "center", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 24 }}>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>No transactions for {monthLabel(month)}</div>
            <Link href="/import" style={{ fontSize: 13, color: "var(--accent)", textDecoration: "none" }}>Import a statement →</Link>
          </div>
        )
      )}

      {/* Summary cards */}
      {(loading || (insights?.summary.txCount ?? 0) > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
          {loading ? [0,1,2,3].map((i) => <div key={i} className="skeleton" style={{ height: 100, borderRadius: 8 }} />) : (
            <>
              <SummaryCard label="Income" value={insights!.summary.totalIncome} type="income" sub={`${insights!.summary.txCount} transactions`} />
              <SummaryCard label="Expenses" value={Math.abs(insights!.summary.totalExpense)} type="expense" />
              <SummaryCard label="Net" value={insights!.summary.net} type="net" />
              <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}>
                <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 10 }}>Savings Rate</div>
                <div style={{ fontSize: 28, fontWeight: 600, fontFamily: "var(--font-ibm-mono)", letterSpacing: "-0.02em", color: savingsRate !== null && savingsRate >= 0 ? "var(--income)" : "var(--expense)" }}>
                  {savingsRate !== null ? `${savingsRate}%` : "—"}
                </div>
                {insights!.summary.uncategorized > 0 && (
                  <Link href="/transactions?filter=uncategorized" style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", marginTop: 4, display: "block" }}>
                    {insights!.summary.uncategorized} uncategorized
                  </Link>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Charts */}
      {(loading || (insights?.summary.txCount ?? 0) > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 24 }}>
          {/* Spending by category */}
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 16 }}>Spending by Category</div>
            {loading ? <div className="skeleton" style={{ height: 220 }} /> : topExpenses.length === 0 ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>No expenses this month</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={topExpenses} layout="vertical" margin={{ left: 0, right: 60 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="categoryName" width={100} tick={{ fill: "var(--text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--border)" }} />
                  <Bar dataKey="abs" radius={[0, 3, 3, 0]} maxBarSize={16} label={{ position: "right", formatter: (v: any) => formatCurrency(Number(v), "MYR"), style: { fill: "var(--text-muted)", fontSize: 10 } }}>
                    {topExpenses.map((entry, i) => <Cell key={i} fill={entry.categoryColor ?? "var(--accent)"} fillOpacity={0.85} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* 12-month trend */}
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 16 }}>12-Month Trend</div>
            {loading ? <div className="skeleton" style={{ height: 220 }} /> : trendData.length === 0 ? (
              <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>No trend data yet</div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--income)", display: "inline-block" }} />Income
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-muted)" }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--expense)", display: "inline-block" }} />Expenses
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={196}>
                  <BarChart data={trendData} margin={{ left: 0, right: 0 }}>
                    <XAxis dataKey="month" tick={{ fill: "var(--text-muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis hide />
                    <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--border)" }} />
                    <Bar dataKey="income" fill="var(--income)" fillOpacity={0.7} radius={[2, 2, 0, 0]} maxBarSize={20} />
                    <Bar dataKey="expense" fill="var(--expense)" fillOpacity={0.7} radius={[2, 2, 0, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
        </div>
      )}

      {/* Recent transactions */}
      {(loading || recentTx.length > 0) && (
        <div style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ padding: "14px 24px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>Recent Transactions</span>
            <Link href="/transactions" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>View all →</Link>
          </div>
          {loading ? (
            <div style={{ padding: 24 }}>{[...Array(5)].map((_, i) => <div key={i} className="skeleton" style={{ height: 44, marginBottom: 8 }} />)}</div>
          ) : recentTx.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No transactions — <Link href="/import" style={{ color: "var(--accent)" }}>import a statement</Link>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Date", "Merchant", "Category", "Account", "Amount"].map((h) => (
                    <th key={h} style={{ padding: "10px 24px", textAlign: h === "Amount" ? "right" : "left", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentTx.map((tx) => {
                  const amt = parseFloat(tx.amount);
                  const isIncome = amt > 0;
                  const displayName = tx.merchantNormalized || tx.description;
                  return (
                    <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-3)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      <td style={{ padding: "12px 24px", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                        {formatTxDate(tx.postedAt)}
                        {formatTxTime(tx.postedAt) && (
                          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{formatTxTime(tx.postedAt)}</div>
                        )}
                      </td>
                      <td style={{ padding: "12px 24px", maxWidth: 260 }}>
                        <div style={{ fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
                        {tx.notes && <div style={{ fontSize: 11, color: "var(--accent)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{tx.notes}</div>}
                      </td>
                      <td style={{ padding: "12px 24px" }}>
                        {tx.categoryName
                          ? <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: (tx.categoryColor ?? "#888") + "22", color: tx.categoryColor ?? "var(--text-muted)", whiteSpace: "nowrap" }}>
                              {tx.parentCategoryName && <span style={{ opacity: 0.6 }}>{tx.parentCategoryName} › </span>}
                              {tx.categoryName}
                            </span>
                          : <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>}
                      </td>
                      <td style={{ padding: "12px 24px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{tx.accountName ?? "—"}</td>
                      <td style={{ padding: "12px 24px", textAlign: "right", fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500, color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap" }}>
                        {isIncome ? "+" : ""}{formatCurrency(amt, "MYR")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function NavBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: 5,
      border: "1px solid var(--border-2)", background: "var(--bg-3)",
      color: disabled ? "var(--text-dim)" : "var(--text)",
      fontSize: 13, cursor: disabled ? "not-allowed" : "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      {children}
    </button>
  );
}
