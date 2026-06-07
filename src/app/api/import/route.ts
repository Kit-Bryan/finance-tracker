import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import {
  importBatches,
  importProfiles,
  transactionsStaging,
  transactions,
} from "@/db/schema";
import { parseCSV } from "@/lib/parsers/csv";
import { categorizeByRules } from "@/lib/categorizer/rules";
import { eq } from "drizzle-orm";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const accountId = parseInt(formData.get("accountId") as string);
  const profileId = parseInt(formData.get("profileId") as string);

  if (!file || isNaN(accountId) || isNaN(profileId)) {
    return NextResponse.json({ error: "Missing file, accountId, or profileId" }, { status: 400 });
  }

  // Load profile
  const [profile] = await db
    .select()
    .from(importProfiles)
    .where(eq(importProfiles.id, profileId));

  if (!profile) {
    return NextResponse.json({ error: "Import profile not found" }, { status: 404 });
  }

  // Create batch
  const [batch] = await db
    .insert(importBatches)
    .values({
      accountId,
      profileId,
      filename: file.name,
      status: "processing",
    })
    .returning();

  const csvText = await file.text();
  let parsedRows;

  try {
    parsedRows = parseCSV(csvText, profile.config as Parameters<typeof parseCSV>[1], accountId);
  } catch (e: unknown) {
    await db
      .update(importBatches)
      .set({ status: "failed", errors: [{ message: e instanceof Error ? e.message : String(e) }] })
      .where(eq(importBatches.id, batch.id));
    return NextResponse.json({ error: "CSV parse failed", details: String(e) }, { status: 422 });
  }

  // Insert staging rows
  const stagingInserts = parsedRows.map((row) => ({
    batchId: batch.id,
    rawRow: row.rawRow,
    fingerprint: row.fingerprint || null,
    parseError: row.parseError || null,
    promoted: false,
  }));

  if (stagingInserts.length > 0) {
    await db.insert(transactionsStaging).values(stagingInserts);
  }

  // Promote valid rows to transactions
  let importedRows = 0;
  let errorRows = 0;
  const errors: unknown[] = [];

  for (const row of parsedRows) {
    if (row.parseError || !row.fingerprint) {
      errorRows++;
      errors.push({ row: row.rawRow, error: row.parseError });
      continue;
    }

    // Categorize
    const catResult = await categorizeByRules(row.description);

    try {
      await db
        .insert(transactions)
        .values({
          accountId,
          batchId: batch.id,
          categoryId: catResult.categoryId ?? undefined,
          postedAt: row.date,
          amount: String(row.amount),
          currency: row.currency,
          description: row.description,
          fingerprint: row.fingerprint,
          categorySource: catResult.source,
          categoryConfidence: catResult.confidence > 0 ? String(catResult.confidence) : null,
          rawRow: row.rawRow,
        })
        .onConflictDoNothing();

      importedRows++;
    } catch (e: unknown) {
      errorRows++;
      errors.push({ row: row.rawRow, error: String(e) });
    }
  }

  await db
    .update(importBatches)
    .set({
      status: "complete",
      totalRows: parsedRows.length,
      importedRows,
      errorRows,
      errors: errors.length > 0 ? errors : null,
    })
    .where(eq(importBatches.id, batch.id));

  return NextResponse.json({
    batchId: batch.id,
    totalRows: parsedRows.length,
    importedRows,
    errorRows,
    errors: errors.slice(0, 10),
  });
}
