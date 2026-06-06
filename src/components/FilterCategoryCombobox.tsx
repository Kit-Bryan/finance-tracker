"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Category } from "./CategoryCombobox";
import { categoryMatchesQuery } from "@/lib/categoryAliases";

interface Props {
  value: string; // "" = all, "none" = uncategorized, "123" = category id
  onChange: (val: string) => void;
  categories: Category[];
}

const SPECIAL = [
  { value: "", label: "All categories", color: null },
  { value: "none", label: "Uncategorized", color: "var(--text-muted)" },
];

export default function FilterCategoryCombobox({ value, onChange, categories }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0, above: false });
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const portalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as Node;
      const inTrigger = containerRef.current?.contains(target);
      const inPortal = portalRef.current?.contains(target);
      if (!inTrigger && !inPortal) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function openDropdown() {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const above = window.innerHeight - rect.bottom < 320;
      setDropPos({ top: rect.bottom + window.scrollY, left: rect.left + window.scrollX, width: rect.width, above });
    }
    setOpen((o) => !o);
    if (!open) setTimeout(() => inputRef.current?.focus(), 50);
  }

  const parentCats = categories.filter((c) => !c.parentId);
  const childrenOf = (pid: number) => categories.filter((c) => c.parentId === pid);

  const q = query.toLowerCase().trim();

  // Smart search — same logic as CategoryCombobox
  const buildGroups = () => {
    if (!q) {
      const groups: { parent: Category | null; children: Category[] }[] = [];
      for (const p of parentCats) {
        const children = childrenOf(p.id);
        groups.push(children.length > 0 ? { parent: p, children } : { parent: null, children: [p] });
      }
      return groups;
    }

    const matched = new Set<number>();
    categories.filter((c) => categoryMatchesQuery(c.name, q)).forEach((c) => matched.add(c.id));
    parentCats.filter((p) => categoryMatchesQuery(p.name, q)).forEach((p) => {
      matched.add(p.id);
      childrenOf(p.id).forEach((c) => matched.add(c.id));
    });
    categories.filter((c) => c.parentId && categoryMatchesQuery(c.name, q)).forEach((c) => {
      if (c.parentId) matched.add(c.parentId);
    });

    const groups: { parent: Category | null; children: Category[] }[] = [];
    const usedParents = new Set<number>();
    for (const p of parentCats) {
      if (!matched.has(p.id)) continue;
      const children = childrenOf(p.id).filter((c) => matched.has(c.id));
      groups.push({ parent: p, children });
      usedParents.add(p.id);
    }
    const orphans = categories.filter((c) => c.parentId && matched.has(c.id) && !usedParents.has(c.parentId!));
    if (orphans.length) {
      const byParent = new Map<number, Category[]>();
      orphans.forEach((c) => { const pid = c.parentId!; byParent.set(pid, [...(byParent.get(pid) ?? []), c]); });
      byParent.forEach((children, pid) => {
        groups.push({ parent: categories.find((c) => c.id === pid) ?? null, children });
      });
    }
    return groups;
  };

  const groups = buildGroups();

  // Display label for current value
  const displayLabel = () => {
    if (value === "") return { label: "All categories", color: null };
    if (value === "none") return { label: "Uncategorized", color: "var(--text-muted)" };
    const cat = categories.find((c) => String(c.id) === value);
    return cat ? { label: cat.name, color: cat.color } : { label: "All categories", color: null };
  };

  const { label, color } = displayLabel();

  const dropdownContent = (
    <div ref={portalRef} style={{
      position: "fixed",
      top: dropPos.above ? undefined : dropPos.top + 4,
      bottom: dropPos.above ? window.innerHeight - dropPos.top + 4 : undefined,
      left: dropPos.left,
      zIndex: 9999,
      minWidth: Math.max(220, dropPos.width),
      background: "var(--bg-3)",
      border: "1px solid var(--border-2)",
      borderRadius: 7,
      boxShadow: dropPos.above ? "0 -8px 24px #00000055" : "0 8px 24px #00000055",
      overflow: "hidden",
    }}>
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
        <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search categories…"
          style={{ width: "100%", background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontSize: 12, padding: "5px 8px", outline: "none", fontFamily: "inherit" }}
        />
      </div>
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {!q && SPECIAL.map((s) => (
          <button key={s.value} onClick={() => { onChange(s.value); setOpen(false); setQuery(""); }}
            style={{ width: "100%", padding: "8px 14px", background: value === s.value ? "var(--accent-dim)" : "none", border: "none", textAlign: "left", cursor: "pointer", fontSize: 13, color: value === s.value ? "var(--accent)" : "var(--text-muted)", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "space-between" }}
            onMouseEnter={(e) => { if (value !== s.value) e.currentTarget.style.background = "var(--border)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = value === s.value ? "var(--accent-dim)" : "none"; }}
          >
            {s.label}{value === s.value && <span style={{ fontSize: 11 }}>✓</span>}
          </button>
        ))}
        {!q && <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />}
        {groups.length === 0 && q && <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 12 }}>No matches</div>}
        {groups.map(({ parent, children }, gi) => (
          <div key={gi}>
            {parent && (
              <button onClick={() => { onChange(String(parent.id)); setOpen(false); setQuery(""); }}
                style={{ width: "100%", padding: "7px 14px", background: value === String(parent.id) ? "var(--accent-dim)" : "none", border: "none", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: value === String(parent.id) ? "var(--accent)" : "var(--text)", fontFamily: "inherit" }}
                onMouseEnter={(e) => { if (value !== String(parent.id)) e.currentTarget.style.background = "var(--border)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = value === String(parent.id) ? "var(--accent-dim)" : "none"; }}
              >
                {parent.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: parent.color, flexShrink: 0 }} />}
                {parent.name}
                {value === String(parent.id) && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
              </button>
            )}
            {children.map((cat) => (
              <button key={cat.id} onClick={() => { onChange(String(cat.id)); setOpen(false); setQuery(""); }}
                style={{ width: "100%", padding: "7px 14px 7px", paddingLeft: parent ? 28 : 14, background: value === String(cat.id) ? "var(--accent-dim)" : "none", border: "none", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: value === String(cat.id) ? "var(--accent)" : "var(--text)", fontFamily: "inherit" }}
                onMouseEnter={(e) => { if (value !== String(cat.id)) e.currentTarget.style.background = "var(--border)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = value === String(cat.id) ? "var(--accent-dim)" : "none"; }}
              >
                {cat.color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: cat.color, flexShrink: 0 }} />}
                {cat.name}
                {value === String(cat.id) && <span style={{ marginLeft: "auto", fontSize: 11 }}>✓</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button type="button" onClick={openDropdown}
        style={{ width: "100%", padding: "6px 10px", background: "var(--bg-3)", border: "1px solid var(--border-2)", borderRadius: 5, color: color ?? "var(--text)", fontSize: 13, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, fontFamily: "inherit" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {color && color !== "var(--text-muted)" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />}
          {label}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>
      {open && mounted && createPortal(dropdownContent, document.body)}
    </div>
  );
}
