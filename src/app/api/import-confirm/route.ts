import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  importBatches,
  importProfiles,
  transactions,
  transactionsStaging,
} from "@/db/schema";
import { categorizeByRules } from "@/lib/categorizer/rules";
import { bulkCategorize } from "@/lib/ai/categorize";
import { learnMerchant } from "@/lib/categorizer/rules";
import { categories } from "@/db/schema";
import { PreviewRow } from "@/app/api/parse-preview/route";

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
  const body: ConfirmBody = await req.json();
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

  // Insert staging rows
  const validRows = rows.filter((r) => !r.parseError && r.fingerprint);

  if (validRows.length > 0) {
    await db.insert(transactionsStaging).values(
      validRows.map((r) => ({
        batchId: batch.id,
        rawRow: { date: r.date, description: r.description, amount: r.amount, currency: r.currency },
        fingerprint: r.fingerprint,
        promoted: false,
      }))
    );
  }

  // Promote to transactions
  let importedRows = 0;
  let skippedRows = 0;
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
          postedAt: new Date(row.date),
          amount: String(row.amount),
          currency: row.currency,
          description: row.description,
          fingerprint: row.fingerprint,
          categorySource: catResult.source,
          categoryConfidence: catResult.confidence > 0 ? String(catResult.confidence) : null,
          rawRow: { date: row.date, description: row.description, amount: row.amount },
        })
        .onConflictDoNothing()
        .returning();

      if (result.length > 0) {
        importedRows++;
      } else {
        skippedRows++; // duplicate fingerprint
      }
    } catch (e) {
      errorRows++;
    }
  }

  // AI bulk categorize: transactions that rules couldn't categorize
  const allCategories = await db.select().from(categories);
  const categoryNames = allCategories.map((c) => c.name);
  const categoryByName = new Map(allCategories.map((c) => [c.name.toLowerCase(), c]));

  const uncategorizedIds = (
    await db
      .select({ id: transactions.id, description: transactions.description, amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.batchId, batch.id))
  ).filter((r) => !r.description.includes("__skip"));

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

  return NextResponse.json({
    batchId: batch.id,
    totalRows: rows.length,
    importedRows,
    skippedRows,
    errorRows,
    profileId: resolvedProfileId,
  });
}
