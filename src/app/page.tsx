"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { formatCurrency, formatMonth, startOfMonth, today } from "@/lib/format";

interface InsightsData {
  period: { from: string; to: string };
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
  amount: string;
  currency: string;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string | null;
}

function SummaryCard({
  label,
  value,
  type,
  delay,
}: {
  label: string;
  value: number;
  type: "income" | "expense" | "net";
  delay: string;
}) {
  const color =
    type === "income" ? "var(--income)" : type === "expense" ? "var(--expense)" : "var(--accent)";
  const bg =
    type === "income"
      ? "var(--income-dim)"
      : type === "expense"
      ? "var(--expense-dim)"
      : "var(--accent-dim)";

  return (
    <div
      className={`fade-up ${delay}`}
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>
          {label}
        </span>
        <span
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 3,
            background: bg,
            color,
            fontFamily: "var(--font-ibm-mono)",
            letterSpacing: "0.05em",
          }}
        >
          {type === "income" ? "IN" : type === "expense" ? "OUT" : "NET"}
        </span>
      </div>
      <span
        style={{
          fontSize: 28,
          fontWeight: 600,
          color,
          letterSpacing: "-0.02em",
          fontFamily: "var(--font-ibm-mono)",
        }}
      >
        {formatCurrency(value)}
      </span>
    </div>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: "var(--bg-3)",
        border: "1px solid var(--border-2)",
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 12,
        fontFamily: "var(--font-ibm-mono)",
      }}
    >
      <div style={{ color: "var(--text-muted)", marginBottom: 4, fontSize: 11 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.fill }}>
          {formatCurrency(Math.abs(p.value))}
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const [recentTx, setRecentTx] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  const from = startOfMonth();
  const to = today();

  useEffect(() => {
    Promise.all([
      fetch(`/api/insights?from=${from}&to=${to}`).then((r) => r.json()),
      fetch(`/api/transactions?limit=8`).then((r) => r.json()),
    ]).then(([ins, txData]) => {
      setInsights(ins);
      setRecentTx(txData.rows ?? []);
      setLoading(false);
    });
  }, []);

  const topCategories = insights?.byCategory
    .filter((c) => c.total < 0)
    .sort((a, b) => a.total - b.total)
    .slice(0, 8)
    .map((c) => ({ ...c, abs: Math.abs(c.total) })) ?? [];

  const trendData = insights?.monthlyTrend.map((m) => ({
    month: formatMonth(m.month),
    income: parseFloat(m.income ?? "0"),
    expense: Math.abs(parseFloat(m.expense ?? "0")),
  })) ?? [];

  return (
    <div style={{ padding: "32px 36px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div className="fade-up fade-up-1" style={{ marginBottom: 32 }}>
        <h1
          style={{
            fontFamily: "var(--font-syne)",
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: "var(--text)",
          }}
        >
          Overview
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
          {new Date(from).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 28 }}>
        {loading ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 100, borderRadius: 8 }} />
          ))
        ) : (
          <>
            <SummaryCard label="Income" value={insights!.summary.totalIncome} type="income" delay="fade-up-2" />
            <SummaryCard label="Expenses" value={Math.abs(insights!.summary.totalExpense)} type="expense" delay="fade-up-3" />
            <SummaryCard label="Net" value={insights!.summary.net} type="net" delay="fade-up-4" />
          </>
        )}
      </div>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 28 }}>
        {/* Spending by category */}
        <div
          className="fade-up fade-up-3"
          style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}
        >
          <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 20 }}>
            Spending by Category
          </div>
          {loading ? (
            <div className="skeleton" style={{ height: 200 }} />
          ) : topCategories.length === 0 ? (
            <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No expense data this month
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={topCategories} layout="vertical" margin={{ left: 0, right: 12 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="categoryName"
                  width={90}
                  tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--border)" }} />
                <Bar dataKey="abs" radius={[0, 3, 3, 0]} maxBarSize={16}>
                  {topCategories.map((entry, i) => (
                    <Cell key={i} fill={entry.categoryColor ?? "#c9a84c"} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Monthly trend */}
        <div
          className="fade-up fade-up-4"
          style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "20px 24px" }}
        >
          <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 20 }}>
            12-Month Trend
          </div>
          {loading ? (
            <div className="skeleton" style={{ height: 200 }} />
          ) : trendData.length === 0 ? (
            <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No trend data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={trendData} margin={{ left: 0, right: 0 }}>
                <XAxis dataKey="month" tick={{ fill: "var(--text-muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: "var(--border)" }} />
                <Bar dataKey="income" fill="var(--income)" fillOpacity={0.7} radius={[2, 2, 0, 0]} maxBarSize={20} />
                <Bar dataKey="expense" fill="var(--expense)" fillOpacity={0.7} radius={[2, 2, 0, 0]} maxBarSize={20} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Recent transactions */}
      <div
        className="fade-up fade-up-5"
        style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}
      >
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Recent Transactions
          </span>
          <Link href="/transactions" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
            View all →
          </Link>
        </div>

        {loading ? (
          <div style={{ padding: 24 }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 36, marginBottom: 8 }} />
            ))}
          </div>
        ) : recentTx.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No transactions yet.{" "}
            <Link href="/import" style={{ color: "var(--accent)" }}>
              Import a CSV
            </Link>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Date", "Description", "Category", "Account", "Amount"].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "10px 24px",
                      textAlign: h === "Amount" ? "right" : "left",
                      fontSize: 10,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      color: "var(--text-muted)",
                      fontWeight: 500,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentTx.map((tx) => {
                const amt = parseFloat(tx.amount);
                const isIncome = amt > 0;
                return (
                  <tr
                    key={tx.id}
                    style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-3)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "12px 24px", fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)", whiteSpace: "nowrap" }}>
                      {new Date(tx.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </td>
                    <td style={{ padding: "12px 24px", fontSize: 13, color: "var(--text)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {tx.description}
                    </td>
                    <td style={{ padding: "12px 24px" }}>
                      {tx.categoryName ? (
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: (tx.categoryColor ?? "#888") + "22", color: tx.categoryColor ?? "var(--text-muted)" }}>
                          {tx.categoryName}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 24px", fontSize: 12, color: "var(--text-muted)" }}>
                      {tx.accountName ?? "—"}
                    </td>
                    <td style={{ padding: "12px 24px", textAlign: "right", fontFamily: "var(--font-ibm-mono)", fontSize: 13, fontWeight: 500, color: isIncome ? "var(--income)" : "var(--expense)", whiteSpace: "nowrap" }}>
                      {isIncome ? "+" : ""}{formatCurrency(amt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {!loading && (insights?.summary.uncategorized ?? 0) > 0 && (
          <div style={{ padding: "12px 24px", borderTop: "1px solid var(--border)", background: "var(--accent-dim)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 12, color: "var(--accent)" }}>
              {insights!.summary.uncategorized} uncategorized transaction{insights!.summary.uncategorized !== 1 ? "s" : ""}
            </span>
            <Link href="/transactions?filter=uncategorized" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
              Review →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
