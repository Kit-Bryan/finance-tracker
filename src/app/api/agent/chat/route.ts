import { NextRequest, NextResponse } from "next/server";
import { runAgentTurn, AgentMessage } from "@/lib/ai/agent";

export async function POST(req: NextRequest) {
  const { message, history } = await req.json() as {
    message: string;
    history: AgentMessage[];
  };

  if (!message?.trim()) {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  try {
    const result = await runAgentTurn(history ?? [], message);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
