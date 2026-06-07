import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { mergeCategories } from "@/lib/categories";

// POST /api/categories/merge  { sourceId, targetId }
// Reassigns all of source's transactions to target, then soft-deletes source.
export async function POST(req: NextRequest) {
  const { sourceId, targetId } = await req.json();
  if (!sourceId || !targetId) {
    return NextResponse.json({ error: "sourceId and targetId are required" }, { status: 400 });
  }
  if (sourceId === targetId) {
    return NextResponse.json({ error: "Cannot merge a category into itself" }, { status: 400 });
  }

  const [source] = await db.select().from(categories).where(eq(categories.id, sourceId));
  const [target] = await db.select().from(categories).where(eq(categories.id, targetId));
  if (!source || !target) return NextResponse.json({ error: "Category not found" }, { status: 404 });
  if (source.deletedAt || target.deletedAt) return NextResponse.json({ error: "Category not found" }, { status: 404 });

  // Merging deletes the source — system categories are mandatory and can't be removed this way.
  if (source.role) {
    return NextResponse.json({ error: `The ${source.name} category is required by the system and can't be merged away.` }, { status: 400 });
  }

  try {
    const result = await mergeCategories(sourceId, targetId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
