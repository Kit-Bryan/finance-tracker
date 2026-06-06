import { NextResponse } from "next/server";
import { runAllDetectors } from "@/lib/flags/detect";

// POST /api/flags/scan — run all detectors (idempotent). Called on dashboard load and after import.
export async function POST() {
  const result = await runAllDetectors();
  return NextResponse.json(result);
}
