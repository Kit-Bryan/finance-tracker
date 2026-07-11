import { NextRequest, NextResponse } from "next/server";
import { eq, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importProfiles,
  transactions,
  transactionsStaging,
} from "@/db/schema";
import { categorizeByRules, isGoPlusNoise } from "@/lib/categorizer/rules";
import { bulkCategorize } from "@/lib/ai/categorize";
import { learnMerchant } from "@/lib/categorizer/rules";
import { categories } from "@/db/schema";
import { PreviewRow } from "@/app/api/parse-preview/route";
import { runAllDetectors } from "@/lib/flags/detect";
import { combinePostedAt } from "@/lib/format";
import { saveBatchFile } from "@/lib/uploads";
import { logger } from "@/lib/logger";

interface ConfirmBody {
  accountId: number;
  filename: string;
  rows: PreviewRow[];
  // If the user confirmed a new profile, save it
  saveProfile?: {
    name: string;
    bank: string;
    config: object;
  };
  profileId?: number;
}

export async function POST(req: NextRequest) {
  const log = logger.child({ route: "import-confirm" });

  // Multipart: `payload` (JSON) + optional `file` (the original statement, stored
  // for source trace-back). Plain JSON bodies still work (no file stored).
  let body: ConfirmBody;
  let originalFile: File | null = null;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const fd = await req.formData();
    body = JSON.parse((fd.get("payload") as string) ?? "{}");
    originalFile = fd.get("file") as File | null;
  } else {
    body = await req.json();
  }
  const { accountId, filename, rows, saveProfile, profileId } = body;

  if (!accountId || !filename || !rows?.length) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Optionally save new import profile
  let resolvedProfileId = profileId;
  if (saveProfile) {
    const [saved] = await db
      .insert(importProfiles)
      .values(saveProfile)
      .returning();
    resolvedProfileId = saved.id;
  }

  // Create import batch
  const [batch] = await db
    .insert(importBatches)
    .values({
      accountId,
      profileId: resolvedProfileId ?? null,
      filename,
      status: "processing",
      totalRows: rows.length,
    })
    .returning();

  // Keep the original statement so transactions can be traced back to their
  // exact spot in the source document. Non-fatal if it fails.
  if (originalFile) {
    try {
      const stored = await saveBatchFile(batch.id, filename, Buffer.from(await originalFile.arrayBuffer()));
      await db.update(importBatches).set({ storedFile: stored }).where(eq(importBatches.id, batch.id));
    } catch (err) {
      log.warn({ err, batchId: batch.id }, "could not store original statement file");
    }
  }

  // Insert staging rows
  const validRows = rows.filter((r) => !r.parseError && r.fingerprint);

  if (validRows.length > 0) {
    await db.insert(transactionsStaging).values(
      validRows.map((r) => ({
        batchId: batch.id,
        rawRow: { date: r.date, time: r.time, description: r.description, amount: r.amount, currency: r.currency },
        fingerprint: r.fingerprint,
        promoted: false,
      }))
    );
  }

  // Promote to transactions
  let importedRows = 0;
  const skippedDetails: PreviewRow[] = [];
  let errorRows = rows.filter((r) => !!r.parseError).length;

  for (const row of validRows) {
    const catResult = await categorizeByRules(row.description);

    try {
      const result = await db
        .insert(transactions)
        .values({
          accountId,
          batchId: batch.id,
          categoryId: catResult.categoryId ?? undefined,
          postedAt: combinePostedAt(row.date, row.time),
          amount: String(row.amount),
          currency: row.currency,
          description: row.description,
          fingerprint: row.fingerprint,
          categorySource: catResult.source,
          categoryConfidence: catResult.confidence > 0 ? String(catResult.confidence) : null,
          // GO+ internal legs (reload from / cash out to GO+) are wallet churn, not
          // real income/expense: hide them from the list AND mark them as transfers
          // so insights excludes them deterministically (not AI-categorization-dependent).
          hidden: isGoPlusNoise(row.description),
          isTransfer: isGoPlusNoise(row.description),
          // page/yPercent locate this row on the stored original for trace-back
          rawRow: { date: row.date, time: row.time, description: row.description, amount: row.amount, page: row.page, yPercent: row.yPercent },
        })
        .onConflictDoNothing()
        .returning();

      if (result.length > 0) {
        importedRows++;
      } else {
        skippedDetails.push(row); // keep full row so user can review
      }
    } catch (e) {
      errorRows++;
    }
  }

  // AI bulk categorize: transactions that rules couldn't categorize
  const allCategories = await db.select().from(categories).where(isNull(categories.deletedAt));
  const categoryNames = allCategories.map((c) => c.name);
  const categoryByName = new Map(allCategories.map((c) => [c.name.toLowerCase(), c]));

  const uncategorizedIds = await db
    .select({ id: transactions.id, description: transactions.description, amount: transactions.amount })
    .from(transactions)
    .where(and(eq(transactions.batchId, batch.id), isNull(transactions.categoryId)));

  if (uncategorizedIds.length > 0) {
    const CHUNK = 50;
    for (let i = 0; i < uncategorizedIds.length; i += CHUNK) {
      const chunk = uncategorizedIds.slice(i, i + CHUNK);
      const inputs = chunk.map((r) => ({
        id: r.id,
        description: r.description,
        amount: parseFloat(r.amount as string),
      }));
      const results = await bulkCategorize(inputs, categoryNames);
      for (const result of results) {
        const cat = categoryByName.get(result.categoryName.toLowerCase());
        if (!cat) continue;
        await db
          .update(transactions)
          .set({
            categoryId: cat.id,
            merchantNormalized: result.merchantName,
            categorySource: "agent",
            categoryConfidence: String(Math.min(1, Math.max(0, result.confidence))),
            notes: result.note || null,
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, result.id));
        const tx = chunk.find((r) => r.id === result.id);
        if (tx) await learnMerchant(tx.description, cat.id, "agent");
      }
    }
  }

  await db
    .update(importBatches)
    .set({ status: "complete", importedRows, errorRows })
    .where(eq(importBatches.id, batch.id));

  // Proactively scan the new data for reimbursements + low-confidence categorizations
  try {
    await runAllDetectors();
  } catch (err) {
    log.error({ err, batchId: batch.id }, "flag detection failed after import");
  }

  log.info({ batchId: batch.id, accountId, total: rows.length, importedRows, skipped: skippedDetails.length, errorRows }, "import complete");

  return NextResponse.json({
    batchId: batch.id,
    accountId,
    totalRows: rows.length,
    importedRows,
    skippedRows: skippedDetails.length,
    skippedDetails,       // full row data for user review
    errorRows,
    profileId: resolvedProfileId,
  });
}
