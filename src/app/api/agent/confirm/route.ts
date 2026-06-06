import { NextRequest, NextResponse } from "next/server";
import { confirmPendingAction, PendingAction } from "@/lib/ai/agent";
import { logger } from "@/lib/logger";

const log = logger.child({ route: "agent/confirm" });

export async function POST(req: NextRequest) {
  const { action } = await req.json() as { action: PendingAction };
  if (!action) return NextResponse.json({ error: "No action provided" }, { status: 400 });

  try {
    const result = await confirmPendingAction(action);
    log.info({ actionType: action.type, updated: result.updated }, "agent action confirmed");
    return NextResponse.json(result);
  } catch (err) {
    log.error({ err, actionType: action.type }, "agent action failed");
    return NextResponse.json({ error: "Failed to apply action" }, { status: 500 });
  }
}
