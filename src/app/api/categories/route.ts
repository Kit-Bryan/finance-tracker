import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";

export async function GET() {
  const rows = await db.select().from(categories).where(isNull(categories.deletedAt)).orderBy(categories.name);
  return NextResponse.json(rows);
}

const CATEGORY_COLORS = [
  "#f97316", "#3b82f6", "#8b5cf6", "#ec4899", "#eab308",
  "#14b8a6", "#06b6d4", "#6366f1", "#64748b", "#22c55e",
  "#e11d48", "#0ea5e9", "#a855f7", "#f59e0b", "#10b981",
];

export async function POST(req: NextRequest) {
  const { eq } = await import("drizzle-orm");
  const { name, parentId, color } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  let resolvedColor = color ?? null;

  if (parentId) {
    // Inherit parent color
    const [parent] = await db.select().from(categories).where(and(eq(categories.id, parentId), isNull(categories.deletedAt)));
    resolvedColor = resolvedColor ?? parent?.color ?? null;
  } else if (!resolvedColor) {
    // Auto-assign from palette — pick one not already used by existing top-level categories
    const existing = await db.select({ color: categories.color }).from(categories).where(isNull(categories.deletedAt));
    const usedColors = new Set(existing.map((c) => c.color).filter(Boolean));
    resolvedColor = CATEGORY_COLORS.find((c) => !usedColors.has(c)) ?? CATEGORY_COLORS[0];
  }

  const [row] = await db
    .insert(categories)
    .values({ name: name.trim(), parentId: parentId ?? null, color: resolvedColor })
    .returning();

  return NextResponse.json(row, { status: 201 });
}
