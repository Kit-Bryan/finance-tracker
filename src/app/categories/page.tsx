"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QK } from "@/lib/queryKeys";

interface Cat {
  id: number;
  name: string;
  parentId: number | null;
  color: string | null;
  isTransfer: boolean;
  role: string | null;   // 'income' | 'transfer' | 'uncategorized' → mandatory, can't be deleted
  txCount: number;
  total: number;
}

const CATEGORY_COLORS = [
  "#f97316", "#3b82f6", "#8b5cf6", "#ec4899", "#eab308",
  "#14b8a6", "#06b6d4", "#6366f1", "#64748b", "#22c55e",
  "#e11d48", "#0ea5e9", "#a855f7", "#f59e0b", "#10b981", "#f43f5e",
];

type PickerMode =
  | { kind: "merge"; source: Cat }
  | { kind: "move"; cat: Cat }
  | { kind: "resolve"; source: Cat; count: number };

export default function CategoriesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [colorFor, setColorFor] = useState<number | null>(null);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [creating, setCreating] = useState<null | { parentId: number | null }>(null);
  const [newName, setNewName] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // ── Query ──────────────────────────────────────────────────────────────────

  const { data: cats = [], isLoading: loading } = useQuery<Cat[]>({
    queryKey: QK.categoriesManage(),
    queryFn: () => fetch("/api/categories/manage").then((r) => r.json()),
  });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      fetch(`/api/categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((r) => r.json()),
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: QK.categoriesManage() });
      const prev = queryClient.getQueryData<Cat[]>(QK.categoriesManage());
      queryClient.setQueryData<Cat[]>(QK.categoriesManage(), (old) =>
        (old ?? []).map((c) => c.id === id ? { ...c, name } : c)
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QK.categoriesManage(), ctx.prev);
    },
    onSettled: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  const recolorMutation = useMutation({
    mutationFn: ({ id, color }: { id: number; color: string }) =>
      fetch(`/api/categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color }),
      }).then((r) => r.json()),
    onMutate: async ({ id, color }) => {
      setColorFor(null);
      await queryClient.cancelQueries({ queryKey: QK.categoriesManage() });
      const prev = queryClient.getQueryData<Cat[]>(QK.categoriesManage());
      queryClient.setQueryData<Cat[]>(QK.categoriesManage(), (old) =>
        (old ?? []).map((c) => c.id === id ? { ...c, color } : c)
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(QK.categoriesManage(), ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  const createMutation = useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId: number | null }) =>
      fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentId }),
      }).then((r) => r.json()),
    onSuccess: () => {
      setCreating(null);
      setNewName("");
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (cat: Cat) => {
      const res = await fetch(`/api/categories/${cat.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const data = await res.json();
        return { conflict: true, count: data.count, cat };
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not delete");
      }
      return { conflict: false };
    },
    onSuccess: (result) => {
      if (result.conflict && result.cat) {
        setPicker({ kind: "resolve", source: result.cat, count: result.count });
      }
    },
    onError: (err: Error) => {
      alert(err.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  const mergeMutation = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: number; targetId: number }) =>
      fetch("/api/categories/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, targetId }),
      }).then((r) => r.json()),
    onSuccess: () => {
      setPicker(null);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  const moveToParentMutation = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number }) =>
      fetch(`/api/categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId }),
      }).then((r) => r.json()),
    onSuccess: () => {
      setPicker(null);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  const makeTopLevelMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: null }),
      }).then((r) => r.json()),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QK.categoriesManage() });
    },
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const parents = cats.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name));
  const childrenOf = (id: number) => cats.filter((c) => c.parentId === id).sort((a, b) => a.name.localeCompare(b.name));

  function rollup(parent: Cat) {
    const kids = childrenOf(parent.id);
    const count = parent.txCount + kids.reduce((s, k) => s + k.txCount, 0);
    const total = parent.total + kids.reduce((s, k) => s + k.total, 0);
    return { count, total, kidCount: kids.length };
  }

  const q = search.trim().toLowerCase();
  const matches = (c: Cat) => c.name.toLowerCase().includes(q);

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  const expandAll = () => setExpanded(new Set(parents.map((p) => p.id)));
  const collapseAll = () => setExpanded(new Set());

  // ── Handlers ──────────────────────────────────────────────────────────────

  function rename(id: number) {
    if (!draftName.trim()) { setEditingId(null); return; }
    renameMutation.mutate({ id, name: draftName.trim() });
  }

  function recolor(id: number, color: string) {
    recolorMutation.mutate({ id, color });
  }

  function create() {
    if (!newName.trim() || !creating) return;
    createMutation.mutate({ name: newName.trim(), parentId: creating.parentId });
  }

  function del(cat: Cat) {
    deleteMutation.mutate(cat);
  }

  async function doPick(target: Cat) {
    if (!picker) return;
    if (picker.kind === "move") {
      moveToParentMutation.mutate({ id: picker.cat.id, parentId: target.id });
    } else {
      mergeMutation.mutate({ sourceId: picker.source.id, targetId: target.id });
    }
  }

  function makeTopLevel(cat: Cat) {
    makeTopLevelMutation.mutate(cat.id);
  }

  // busy state — track which id has a pending mutation
  const busyId = (
    renameMutation.isPending ? (renameMutation.variables as { id: number }).id :
    recolorMutation.isPending ? (recolorMutation.variables as { id: number }).id :
    deleteMutation.isPending ? (deleteMutation.variables as Cat).id :
    makeTopLevelMutation.isPending ? makeTopLevelMutation.variables :
    createMutation.isPending ? -1 :
    null
  );

  // Which parents to render, honoring search
  const visibleParents = parents.filter((p) => {
    if (!q) return true;
    return matches(p) || childrenOf(p.id).some(matches);
  });

  return (
    <div style={{ padding: "32px 36px", maxWidth: 920, margin: "0 auto" }}>
      <style>{`
        .cat-row .cat-actions { opacity: 0; transition: opacity 0.12s; }
        .cat-row:hover .cat-actions { opacity: 1; }
      `}</style>

      {/* Header */}
      <div className="fade-up fade-up-1" style={{ marginBottom: 18, display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontFamily: "var(--font-syne)", fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text)" }}>Categories</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>{loading ? "—" : `${parents.length} groups · ${cats.length} total`}</p>
        </div>
        <button onClick={() => { setCreating({ parentId: null }); setNewName(""); }} style={primaryBtn(false)}>+ New category</button>
      </div>

      {/* Toolbar: search + expand/collapse */}
      <div className="fade-up fade-up-2" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search categories…" style={{ ...inputStyle, flex: 1 }} />
        <button onClick={expandAll} style={ghostBtn}>Expand all</button>
        <button onClick={collapseAll} style={ghostBtn}>Collapse all</button>
      </div>

      {loading ? (
        <div>{[...Array(6)].map((_, i) => <div key={i} className="skeleton" style={{ height: 46, marginBottom: 8, borderRadius: 8 }} />)}</div>
      ) : (
        <div className="fade-up fade-up-3" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleParents.map((parent) => {
            const kids = childrenOf(parent.id);
            const roll = rollup(parent);
            const isOpen = expanded.has(parent.id) || (!!q && (matches(parent) || kids.some(matches)));
            const shownKids = q ? kids.filter((k) => matches(k) || matches(parent)) : kids;
            return (
              <div key={parent.id} style={{ background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {/* Parent header */}
                <div className="cat-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", opacity: busyId === parent.id ? 0.5 : 1 }}>
                  <button onClick={() => toggle(parent.id)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, width: 16, flexShrink: 0 }}>
                    {isOpen ? "▼" : "▶"}
                  </button>
                  <ColorSwatch cat={parent} open={colorFor === parent.id} onOpen={() => setColorFor(colorFor === parent.id ? null : parent.id)} onPick={(c) => recolor(parent.id, c)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editingId === parent.id ? (
                      <NameInput value={draftName} onChange={setDraftName} onSave={() => rename(parent.id)} fallback={parent.name} />
                    ) : (
                      <span onClick={() => { setEditingId(parent.id); setDraftName(parent.name); }} style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", cursor: "text" }}>{parent.name}</span>
                    )}
                    {!isOpen && roll.kidCount > 0 && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{roll.kidCount} sub</span>}
                    {parent.role && <SystemBadge />}
                  </div>
                  <Stats count={roll.count} total={roll.total} muted={!isOpen} onNavigate={() => router.push(`/transactions?categoryId=${parent.id}`)} />
                  <div className="cat-actions" style={{ display: "flex", gap: 4 }}>
                    <RowBtn onClick={() => { setCreating({ parentId: parent.id }); setNewName(""); setExpanded((p) => new Set(p).add(parent.id)); }} title="Add subcategory">+ sub</RowBtn>
                    {!parent.role && <RowBtn onClick={() => setPicker({ kind: "merge", source: parent })} title="Merge into another category">merge</RowBtn>}
                    {!parent.role && <RowBtn onClick={() => del(parent)} title="Delete" danger>delete</RowBtn>}
                  </div>
                </div>

                {/* Children */}
                {isOpen && shownKids.map((kid) => (
                  <div key={kid.id} className="cat-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px 10px 42px", borderTop: "1px solid var(--border)", background: "var(--bg)", opacity: busyId === kid.id ? 0.5 : 1 }}>
                    <ColorSwatch cat={kid} open={colorFor === kid.id} onOpen={() => setColorFor(colorFor === kid.id ? null : kid.id)} onPick={(c) => recolor(kid.id, c)} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {editingId === kid.id ? (
                        <NameInput value={draftName} onChange={setDraftName} onSave={() => rename(kid.id)} fallback={kid.name} />
                      ) : (
                        <span onClick={() => { setEditingId(kid.id); setDraftName(kid.name); }} style={{ fontSize: 13, color: "var(--text)", cursor: "text" }}>{kid.name}</span>
                      )}
                    </div>
                    <Stats count={kid.txCount} total={kid.total} onNavigate={() => router.push(`/transactions?categoryId=${kid.id}`)} />
                    {kid.role && <SystemBadge />}
                    <div className="cat-actions" style={{ display: "flex", gap: 4 }}>
                      <RowBtn onClick={() => setPicker({ kind: "move", cat: kid })} title="Move to another parent">move</RowBtn>
                      <RowBtn onClick={() => makeTopLevel(kid)} title="Promote to top-level">promote</RowBtn>
                      {!kid.role && <RowBtn onClick={() => setPicker({ kind: "merge", source: kid })} title="Merge into another category">merge</RowBtn>}
                      {!kid.role && <RowBtn onClick={() => del(kid)} title="Delete" danger>delete</RowBtn>}
                    </div>
                  </div>
                ))}

                {/* Inline add subcategory */}
                {isOpen && creating?.parentId === parent.id && (
                  <div style={{ borderTop: "1px solid var(--border)", padding: "10px 16px 10px 42px", display: "flex", gap: 8, background: "var(--bg)" }}>
                    <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Subcategory name…" style={inputStyle} />
                    <button onClick={create} disabled={createMutation.isPending} style={primaryBtn(createMutation.isPending)}>Add</button>
                    <button onClick={() => setCreating(null)} style={ghostBtn}>Cancel</button>
                  </div>
                )}
              </div>
            );
          })}

          {/* New top-level inline form */}
          {creating?.parentId === null && (
            <div style={{ background: "var(--bg-2)", border: "1px solid var(--accent)", borderRadius: 8, padding: "12px 16px", display: "flex", gap: 8 }}>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="Category name…" style={inputStyle} />
              <button onClick={create} disabled={createMutation.isPending} style={primaryBtn(createMutation.isPending)}>Add</button>
              <button onClick={() => setCreating(null)} style={ghostBtn}>Cancel</button>
            </div>
          )}

          {visibleParents.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No categories match &quot;{search}&quot;.</div>
          )}
        </div>
      )}

      {picker && <PickerModal mode={picker} cats={cats} onPick={doPick} onCancel={() => setPicker(null)} />}
    </div>
  );
}

function Stats({ count, total, muted, onNavigate }: { count: number; total: number; muted?: boolean; onNavigate?: () => void }) {
  const clickable = count > 0 && !!onNavigate;
  return (
    <div
      onClick={(e) => { if (clickable) { e.stopPropagation(); onNavigate!(); } }}
      title={clickable ? "View in transactions" : undefined}
      style={{
        textAlign: "right", minWidth: 96,
        cursor: clickable ? "pointer" : "default",
        borderRadius: 5, padding: "2px 6px",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { if (clickable) e.currentTarget.style.background = "var(--bg-3)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ fontSize: 12, color: muted ? "var(--text-dim)" : "var(--text-muted)", fontFamily: "var(--font-ibm-mono)" }}>
        {count} tx{clickable ? " ↗" : ""}
      </div>
      {count > 0 && (
        <div style={{ fontSize: 12, fontFamily: "var(--font-ibm-mono)", color: total < 0 ? "var(--expense)" : "var(--income)" }}>{formatCurrency(total, "MYR")}</div>
      )}
    </div>
  );
}

function ColorSwatch({ cat, open, onOpen, onPick }: { cat: Cat; open: boolean; onOpen: () => void; onPick: (c: string) => void }) {
  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={onOpen} title="Change color" style={{ width: 18, height: 18, borderRadius: 4, background: cat.color ?? "#888", border: "1px solid var(--border-2)", cursor: "pointer" }} />
      {open && (
        <div style={{ position: "absolute", top: 24, left: 0, zIndex: 20, background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 8, padding: 8, display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6, width: 230 }}>
          {CATEGORY_COLORS.map((c) => (
            <button key={c} onClick={() => onPick(c)} style={{ width: 22, height: 22, borderRadius: 4, background: c, border: cat.color === c ? "2px solid var(--text)" : "1px solid var(--border-2)", cursor: "pointer" }} />
          ))}
        </div>
      )}
    </div>
  );
}

function NameInput({ value, onChange, onSave, fallback }: { value: string; onChange: (v: string) => void; onSave: () => void; fallback: string }) {
  return (
    <input autoFocus value={value} onChange={(e) => onChange(e.target.value)} onBlur={onSave}
      onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") onChange(fallback); }}
      style={{ ...inputStyle, width: 220 }} />
  );
}

function PickerModal({ mode, cats, onPick, onCancel }: { mode: PickerMode; cats: Cat[]; onPick: (c: Cat) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  let exclude: Set<number>; let title: string; let subtitle: string; let onlyTopLevel = false;

  if (mode.kind === "move") {
    title = `Move "${mode.cat.name}"`; subtitle = "Choose a new parent category"; onlyTopLevel = true;
    exclude = new Set([mode.cat.id]);
  } else if (mode.kind === "merge") {
    title = `Merge "${mode.source.name}"`; subtitle = "Its transactions move to the category you pick, then it's deleted";
    exclude = new Set([mode.source.id, ...cats.filter((c) => c.parentId === mode.source.id).map((c) => c.id)]);
  } else {
    title = `Delete "${mode.source.name}"`;
    subtitle = `This category has ${mode.count} transaction${mode.count !== 1 ? "s" : ""}. Move them to another category, then it's deleted.`;
    exclude = new Set([mode.source.id, ...cats.filter((c) => c.parentId === mode.source.id).map((c) => c.id)]);
  }

  const options = cats
    .filter((c) => !exclude.has(c.id))
    .filter((c) => !onlyTopLevel || c.parentId === null)
    .filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameById = new Map(cats.map((c) => [c.id, c.name]));

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000088", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={onCancel}>
      <div style={{ background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: 10, padding: 24, width: 440, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontFamily: "var(--font-syne)", fontSize: 17, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>{title}</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>{subtitle}</p>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search categories…" style={{ ...inputStyle, width: "100%", marginBottom: 10 }} />
        <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {options.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No matching categories</div>
          ) : options.map((c) => (
            <button key={c.id} onClick={() => onPick(c)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, border: "1px solid transparent", background: "var(--bg-3)", cursor: "pointer", textAlign: "left" }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: c.color ?? "#888", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "var(--text)" }}>
                {c.parentId ? <span style={{ color: "var(--text-muted)" }}>{nameById.get(c.parentId)} › </span> : null}{c.name}
              </span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-ibm-mono)" }}>{c.txCount} tx</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onCancel} style={ghostBtn}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RowBtn({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title?: string; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} style={{ padding: "4px 9px", borderRadius: 5, border: "1px solid var(--border-2)", background: "transparent", color: danger ? "var(--expense)" : "var(--text-muted)", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
      {children}
    </button>
  );
}

function SystemBadge() {
  return (
    <span
      title="Required by the system — can be renamed or recolored, but not deleted or merged."
      style={{ marginLeft: 8, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", padding: "2px 7px", borderRadius: 4, border: "1px solid var(--border-2)", background: "var(--bg-3)", color: "var(--text-muted)", whiteSpace: "nowrap", verticalAlign: "middle", cursor: "help" }}
    >
      🔒 System
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 6,
  color: "var(--text)", fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit",
};
function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: "8px 16px", borderRadius: 6, border: "none",
    background: disabled ? "var(--border-2)" : "var(--accent)",
    color: disabled ? "var(--text-muted)" : "#000",
    fontSize: 13, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
  };
}
const ghostBtn: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border-2)",
  background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer", fontFamily: "inherit",
};
