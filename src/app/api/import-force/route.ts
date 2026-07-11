import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { db } from "@/db";
import { transactions, importBatches } from "@/db/schema";
import { categorizeByRules, isGoPlusNoise } from "@/lib/categorizer/rules";
import { PreviewRow } from "@/app/api/parse-preview/route";
import { combinePostedAt } from "@/lib/format";
import { logger } from "@/lib/logger";

interface ForceBody {
  batchId: number;
  accountId: number;
  rows: PreviewRow[];
}

export async function POST(req: NextRequest) {
  const log = logger.child({ route: "import-force" });
  const { batchId, accountId, rows }: ForceBody = await req.json();
  if (!batchId || !accountId || !rows?.length) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }

  let imported = 0;
  let failed = 0;
  const results: boolean[] = []; // per-row success, aligned to the input `rows` order

  for (const row of rows) {
    const catResult = await categorizeByRules(row.description);

    // Generate a new unique fingerprint so it doesn't conflict
    const forceFingerprint = crypto
      .createHash("sha256")
      .update(`force:${row.fingerprint}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 64);

    try {
      await db.insert(transactions).values({
        accountId,
        batchId,
        categoryId: catResult.categoryId ?? undefined,
        postedAt: combinePostedAt(row.date, row.time),
        amount: String(row.amount),
        currency: row.currency,
        description: row.description,
        fingerprint: forceFingerprint,
        categorySource: catResult.source,
        categoryConfidence: catResult.confidence > 0 ? String(catResult.confidence) : null,
        hidden: isGoPlusNoise(row.description),
        isTransfer: isGoPlusNoise(row.description),
        rawRow: { date: row.date, time: row.time, description: row.description, amount: row.amount },
      });
      imported++;
      results.push(true);
    } catch (err) {
      failed++;
      results.push(false);
      log.error({ err, batchId, description: row.description }, "force-import row failed");
    }
  }

  // Update batch imported count
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (batch) {
    await db.update(importBatches).set({ importedRows: (batch.importedRows ?? 0) + imported }).where(eq(importBatches.id, batchId));
  }

  if (failed > 0) log.warn({ batchId, imported, failed }, "force-import completed with failures");
  return NextResponse.json({ imported, failed, results });
}
