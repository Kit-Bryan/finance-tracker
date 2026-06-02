import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { importProfiles } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  const rows = await db.select().from(importProfiles).orderBy(importProfiles.name);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, bank, config } = body;
  if (!name || !bank || !config) {
    return NextResponse.json({ error: "name, bank, and config are required" }, { status: 400 });
  }
  const [row] = await db
    .insert(importProfiles)
    .values({ name, bank, config })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
