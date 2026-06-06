import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { runAgentTurn, AgentMessage, ContextTransaction } from "@/lib/ai/agent";
import { db } from "@/db";
import { chatSessions, chatMessages } from "@/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "agent/chat" });

export async function POST(req: NextRequest) {
  const { message, history, sessionId, contextTransaction } = await req.json() as {
    message: string;
    history: AgentMessage[];
    sessionId?: number;
    contextTransaction?: ContextTransaction | null;
  };

  if (!message?.trim()) {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  // Resolve or create session
  let resolvedSessionId = sessionId;
  if (!resolvedSessionId) {
    const [session] = await db
      .insert(chatSessions)
      .values({
        transactionId: contextTransaction?.id ?? null,
        title: message.slice(0, 80),
      })
      .returning();
    resolvedSessionId = session.id;
  } else {
    // Update title from first message if still default
    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, resolvedSessionId));
    if (session?.title === "New conversation") {
      await db.update(chatSessions).set({ title: message.slice(0, 80) }).where(eq(chatSessions.id, resolvedSessionId));
    }
    // Touch updatedAt
    await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, resolvedSessionId));
  }

  // Save user message
  await db.insert(chatMessages).values({
    sessionId: resolvedSessionId,
    role: "user",
    content: message,
  });

  const t0 = Date.now();
  try {
    const result = await runAgentTurn(history ?? [], message, contextTransaction);

    // Save assistant message
    await db.insert(chatMessages).values({
      sessionId: resolvedSessionId,
      role: "assistant",
      content: result.message ?? "",
      toolResults: result.toolResults?.length ? result.toolResults : null,
      pendingAction: result.pendingConfirmation ?? null,
    });

    log.info({ sessionId: resolvedSessionId, ms: Date.now() - t0, tools: result.toolResults?.map((t) => t.toolName) ?? [], pending: result.pendingConfirmation?.type ?? null }, "agent turn complete");
    return NextResponse.json({ ...result, sessionId: resolvedSessionId });
  } catch (e) {
    log.error({ err: e, sessionId: resolvedSessionId }, "agent turn failed");
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
