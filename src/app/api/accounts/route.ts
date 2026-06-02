import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { accounts } from "@/db/schema";

export async function GET() {
  const rows = await db.select().from(accounts).orderBy(accounts.name);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, bank, currency } = body;
  if (!name || !bank) {
    return NextResponse.json({ error: "name and bank are required" }, { status: 400 });
  }
  const [row] = await db.insert(accounts).values({ name, bank, currency: currency ?? "USD" }).returning();
  return NextResponse.json(row, { status: 201 });
}
