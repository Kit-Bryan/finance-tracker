import { NextRequest, NextResponse } from "next/server";
import { confirmPendingAction, PendingAction } from "@/lib/ai/agent";

export async function POST(req: NextRequest) {
  const { action } = await req.json() as { action: PendingAction };
  if (!action) return NextResponse.json({ error: "No action provided" }, { status: 400 });

  const result = await confirmPendingAction(action);
  return NextResponse.json(result);
}
