import { NextRequest, NextResponse } from "next/server";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { getFamilyIds, countTransactionsFor } from "@/lib/categories";

// PATCH /api/categories/[id] — update name, color, parentId (reparent), or isTransfer
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const catId = parseInt(id);
  const body = await req.json();
  const { name, color, parentId, isTransfer } = body as {
    name?: string;
    color?: string;
    parentId?: number | null;
    isTransfer?: boolean;
  };

  const [cat] = await db.select().from(categories).where(eq(categories.id, catId));
  if (!cat || cat.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updates: Record<string, unknown> = {};
  if (name !== undefined) {
    if (!name.trim()) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    updates.name = name.trim();
  }
  if (color !== undefined) updates.color = color;
  if (isTransfer !== undefined) updates.isTransfer = isTransfer;

  // Reparenting — enforce the two-level hierarchy invariant
  if (parentId !== undefined) {
    if (parentId === catId) {
      return NextResponse.json({ error: "A category can't be its own parent" }, { status: 400 });
    }
    if (parentId !== null) {
      const [target] = await db.select().from(categories).where(eq(categories.id, parentId));
      if (!target || target.deletedAt) {
        return NextResponse.json({ error: "Target parent not found" }, { status: 400 });
      }
      if (target.parentId !== null) {
        return NextResponse.json({ error: "Can only nest under a top-level category" }, { status: 400 });
      }
      // The category being moved must not itself have children (would create 3 levels)
      const kids = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.parentId, catId), isNull(categories.deletedAt)));
      if (kids.length > 0) {
        return NextResponse.json(
          { error: "This category has subcategories — move or remove them before nesting it" },
          { status: 400 }
        );
      }
    }
    updates.parentId = parentId;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await db.update(categories).set(updates).where(eq(categories.id, catId));

  // Recoloring a top-level category propagates to its children (keeps the visual grouping)
  if (color !== undefined && cat.parentId === null) {
    await db
      .update(categories)
      .set({ color })
      .where(and(eq(categories.parentId, catId), isNull(categories.deletedAt)));
  }

  return NextResponse.json({ ok: true });
}

// DELETE /api/categories/[id] — soft delete, but blocked while any transaction still uses it.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const catId = parseInt(id);

  const [cat] = await db.select().from(categories).where(eq(categories.id, catId));
  if (!cat || cat.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (cat.name.toLowerCase() === "uncategorized") {
    return NextResponse.json({ error: "The Uncategorized category can't be deleted" }, { status: 400 });
  }

  const family = await getFamilyIds(catId);
  const count = await countTransactionsFor(family);

  if (count > 0) {
    // Block — caller must resolve the transactions first (move them elsewhere / merge)
    return NextResponse.json(
      { error: "in_use", inUse: true, count },
      { status: 409 }
    );
  }

  await db.update(categories).set({ deletedAt: new Date() }).where(inArray(categories.id, family));
  return NextResponse.json({ ok: true });
}
