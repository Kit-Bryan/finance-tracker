import { NextResponse } from "next/server";
import { desc, eq, isNull, and } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, accounts } from "@/db/schema";

export async function GET() {
  const batches = await db
    .select({
      id: importBatches.id,
      filename: importBatches.filename,
      status: importBatches.status,
      totalRows: importBatches.totalRows,
      importedRows: importBatches.importedRows,
      errorRows: importBatches.errorRows,
      createdAt: importBatches.createdAt,
      accountId: importBatches.accountId,
      accountName: accounts.name,
      bank: accounts.bank,
    })
    .from(importBatches)
    .leftJoin(accounts, eq(importBatches.accountId, accounts.id))
    .where(isNull(importBatches.deletedAt))
    .orderBy(desc(importBatches.createdAt));

  return NextResponse.json(batches);
}
