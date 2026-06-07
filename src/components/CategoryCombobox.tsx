"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { categoryMatchesQuery } from "@/lib/categoryAliases";

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  color: string | null;
}

export interface CategoryValue {
  id: number;
  name: string;
  color: string | null;
}

interface Props {
  value: CategoryValue | null;
  onChange: (cat: CategoryValue) => void;
  categories: Category[];
  aiSuggestion?: { name: string; confidence: number; categoryId?: number | null; isNew?: boolean; suggestedParent?: string | null } | null;
  onCategoryCreated?: (cat: Category) => void; // notify parent to refresh category list
  placeholder?: string;
  disabled?: boolean;
}

export default function CategoryCombobox({
  value, onChange, categories, aiSuggestion, onCategoryCreated, placeholder = "Search or create…", disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0, above: false });
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMounted(true); }, []);

  // Close on outside click — must exclude the portal div too
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node;
      const inTrigger = containerRef.current?.contains(target);
      const inPortal = portalRef.current?.contains(target);
      if (!inTrigger && !inPortal) {
        setOpen(false);
        setCreating(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const parentCats = categories.filter((c) => !c.parentId);
  const childrenOf = (pid: number) => categories.filter((c) => c.parentId === pid);

  const q = query.toLowerCase().trim();

  // Smart search: direct name matches + children of any matching parent
  const buildSearchResults = () => {
    if (!q) return null;

    const directMatches = new Set(
      categories.filter((c) => categoryMatchesQuery(c.name, q)).map((c) => c.id)
    );

    // If query hits a parent, also include all its children
    const matchingParents = parentCats.filter((p) => categoryMatchesQuery(p.name, q));
    for (const parent of matchingParents) {
      for (const child of childrenOf(parent.id)) {
        directMatches.add(child.id);
      }
      directMatches.add(parent.id);
    }

    // If query hits a child, also include its parent and siblings for context
    const matchingChildren = categories.filter(
      (c) => c.parentId && categoryMatchesQuery(c.name, q)
    );
    for (const child of matchingChildren) {
      if (child.parentId) directMatches.add(child.parentId);
    }

    const matched = categories.filter((c) => directMatches.has(c.id));

    // Group matched results by parent
    const groups: { parent: Category | null; children: Category[] }[] = [];
    const usedParents = new Set<number>();

    for (const p of parentCats) {
      if (!directMatches.has(p.id)) continue;
      const children = childrenOf(p.id).filter((c) => directMatches.has(c.id));
      groups.push({ parent: p, children });
      usedParents.add(p.id);
    }

    // Orphan children whose parent wasn't matched
    const orphans = matched.filter(
      (c) => c.parentId && !usedParents.has(c.parentId)
    );
    if (orphans.length > 0) {
      // Group orphans by their actual parent
      const byParent = new Map<number, Category[]>();
      for (const c of orphans) {
        const pid = c.parentId!;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid)!.push(c);
      }
      for (const [pid, children] of byParent) {
        const parent = categories.find((c) => c.id === pid) ?? null;
        groups.push({ parent, children });
      }
    }

    return groups;
  };

  const searchGroups = buildSearchResults();

  // Default grouped view (no query)
  const defaultGroups: { parent: Category | null; children: Category[] }[] = [];
  for (const p of parentCats) {
    const children = childrenOf(p.id);
    if (children.length > 0) {
      defaultGroups.push({ parent: p, children });
    } else {
      defaultGroups.push({ parent: null, children: [p] });
    }
  }

  const grouped = searchGroups ?? defaultGroups;
  const allFiltered = searchGroups ? searchGroups.flatMap((g) => g.children) : categories;
  const exactMatch = allFiltered.find((c) => c.name.toLowerCase() === q);

  async function createCategory() {
    if (!newName.trim()) return;
    setSaving(true);
    const res = await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), parentId: newParentId }),
    });
    const cat: Category = await res.json();
    setSaving(false);
    setCreating(false);
    setNewName("");
    setNewParentId(null);
    setOpen(false);
    setQuery("");
    onCategoryCreated?.(cat);
    onChange({ id: cat.id, name: cat.name, color: cat.color });
  }

  function openDropdown() {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const above = spaceBelow < 320;
      setDropPos({
        top: above ? rect.top + window.scrollY : rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        above,
      });
    }
    setOpen((o) => !o);
    if (!open) setTimeout(() => inputRef.current?.focus(), 50);
  }

  function selectCat(cat: Category) {
    onChange({ id: cat.id, name: cat.name, color: cat.color });
    setOpen(false);
    setQuery("");
  }

  const displayValue = value?.name ?? "";

  const dropdownContent = (
    <div ref={portalRef} style={{
      position: "fixed",
      top: dropPos.above ? undefined : dropPos.top + 4,
      bottom: dropPos.above ? window.innerHeight - dropPos.top + 4 : undefined,
      left: dropPos.left,
      zIndex: 9999,
      width: Math.max(260, dropPos.width),
      background: "var(--bg-3)",
      border: "1px solid var(--border-2)",
      borderRadius: 7,
      boxShadow: dropPos.above ? "0 -8px 24px #00000055" : "0 8px 24px #00000055",
      overflow: "hidden",
    }}>
      {/* Search input */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <input ref={inputRef} type="text" value={query}
          onChange={(e) => { setQuery(e.target.value); setCreating(false); }}
          placeholder="Search categories…"
          style={{ width: "100%", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12, padding: "5px 8px", outline: "none", fontFamily: "inherit" }}
        />
      </div>
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {aiSuggestion && !q && (
          <div style={{ padding: "6px 10px 2px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.08em", marginBottom: 4 }}>✦ AI SUGGESTION · {Math.round(aiSuggestion.confidence * 100)}% confident</div>
            {aiSuggestion.isNew ? (
              <button onClick={() => { setNewName(aiSuggestion.name); setNewParentId(aiSuggestion.suggestedParent ? (categories.find(c => c.name.toLowerCase() === aiSuggestion.suggestedParent!.toLowerCase())?.id ?? null) : null); setCreating(true); }} style={suggestionBtn}>
                <span style={{ color: "var(--accent)" }}>+ Create &quot;{aiSuggestion.name}&quot;</span>
                {aiSuggestion.suggestedParent && <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 6 }}>under {aiSuggestion.suggestedParent}</span>}
              </button>
            ) : (() => { const cat = categories.find((c) => c.id === aiSuggestion.categoryId || c.name.toLowerCase() === aiSuggestion.name.toLowerCase()); return cat ? (<button onClick={() => selectCat(cat)} style={suggestionBtn}>{cat.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: cat.color }} />}<span style={{ color: cat.color ?? "var(--text)" }}>{cat.name}</span></button>) : null; })()}
          </div>
        )}
        {allFiltered.length === 0 && q && <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 12 }}>No matches — create it below</div>}
        {grouped.map(({ parent, children }, gi) => (
          <div key={gi}>
            {parent && (
              <button key={`p-${parent.id}`} onClick={() => selectCat(parent)}
                style={{ width: "100%", padding: "7px 14px", background: value?.id === parent.id ? "var(--accent-dim)" : "none", border: "none", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: value?.id === parent.id ? "var(--accent)" : "var(--text)", fontFamily: "inherit" }}
                onMouseEnter={(e) => { if (value?.id !== parent.id) e.currentTarget.style.background = "var(--border)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = value?.id === parent.id ? "var(--accent-dim)" : "none"; }}
              >
                {parent.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: parent.color, flexShrink: 0 }} />}
                {parent.name}
                {value?.id === parent.id && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
              </button>
            )}
            {children.map((cat) => (
              <button key={cat.id} onClick={() => selectCat(cat)}
                style={{ width: "100%", padding: "7px 14px", paddingLeft: parent ? 28 : 14, background: value?.id === cat.id ? "var(--accent-dim)" : "none", border: "none", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: value?.id === cat.id ? "var(--accent)" : "var(--text)", fontFamily: "inherit" }}
                onMouseEnter={(e) => { if (value?.id !== cat.id) e.currentTarget.style.background = "var(--border)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = value?.id === cat.id ? "var(--accent-dim)" : "none"; }}
              >
                {cat.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: cat.color, flexShrink: 0 }} />}
                {cat.name}
                {value?.id === cat.id && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
              </button>
            ))}
          </div>
        ))}
        {q && !exactMatch && !creating && <button onClick={() => { setNewName(query); setCreating(true); setQuery(""); }} style={{ ...suggestionBtn, padding: "8px 14px", borderTop: "1px solid var(--border)", color: "var(--accent)" }}>+ Create &quot;{query}&quot;</button>}
        {!q && !creating && <button onClick={() => { setNewName(""); setCreating(true); }} style={{ ...suggestionBtn, padding: "8px 14px", borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>+ New category</button>}
      </div>
      {creating && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", background: "var(--bg-2)" }}>
          <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 8 }}>Create new category</div>
          <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createCategory()} placeholder="Category name…" style={{ ...createInput, marginBottom: 8 }} />
          <select value={newParentId ?? ""} onChange={(e) => setNewParentId(e.target.value ? parseInt(e.target.value) : null)} style={{ ...createInput, marginBottom: 8 }}>
            <option value="">No parent (top-level)</option>
            {parentCats.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={createCategory} disabled={saving || !newName.trim()} style={{ flex: 1, padding: "6px", borderRadius: 4, border: "none", background: saving || !newName.trim() ? "var(--border-2)" : "var(--accent)", color: "#000", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {saving ? "Saving…" : "Create"}
            </button>
            <button onClick={() => setCreating(false)} style={{ padding: "6px 10px", borderRadius: 4, border: "1px solid var(--border-2)", background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );

  const dropdownPortal = open && mounted ? createPortal(dropdownContent, document.body) : null;

  return (
    <div ref={containerRef} style={{ position: "relative", minWidth: 180 }}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={openDropdown}
        style={{
          width: "100%",
          padding: "5px 10px",
          background: "var(--bg-3)",
          border: "1px solid var(--border-2)",
          borderRadius: 5,
          color: value ? (value.color ?? "var(--text)") : "var(--text-muted)",
          fontSize: 12,
          textAlign: "left",
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          fontFamily: "inherit",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value ? (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {value.color && <span style={{ width: 6, height: 6, borderRadius: "50%", background: value.color, flexShrink: 0 }} />}
              {value.name}
            </span>
          ) : placeholder}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>

      {dropdownPortal}
    </div>
  );
}

const suggestionBtn: React.CSSProperties = {
  width: "100%", padding: "6px 10px", background: "none", border: "none",
  textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
  fontSize: 12, fontFamily: "inherit", color: "var(--text)",
};

const createInput: React.CSSProperties = {
  width: "100%", background: "var(--bg-3)", border: "1px solid var(--border-2)",
  borderRadius: 4, color: "var(--text)", fontSize: 12, padding: "6px 8px",
  outline: "none", fontFamily: "inherit",
};
