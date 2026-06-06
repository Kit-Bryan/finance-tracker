import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { flags } from "@/db/schema";

// POST /api/flags/[id]/dismiss — mark a flag dismissed so it never resurfaces.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const flagId = parseInt(id);

  const [flag] = await db.select().from(flags).where(eq(flags.id, flagId));
  if (!flag) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.update(flags).set({ status: "dismissed", updatedAt: new Date() }).where(eq(flags.id, flagId));
  return NextResponse.json({ ok: true });
}
