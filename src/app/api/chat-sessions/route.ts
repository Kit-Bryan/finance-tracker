import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { chatSessions, chatMessages, transactions } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  const sessions = await db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      transactionId: chatSessions.transactionId,
      createdAt: chatSessions.createdAt,
      updatedAt: chatSessions.updatedAt,
    })
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt))
    .limit(50);

  return NextResponse.json(sessions);
}

export async function POST(req: NextRequest) {
  const { transactionId } = await req.json().catch(() => ({}));

  const [session] = await db
    .insert(chatSessions)
    .values({ transactionId: transactionId ?? null, title: "New conversation" })
    .returning();

  return NextResponse.json(session, { status: 201 });
}
