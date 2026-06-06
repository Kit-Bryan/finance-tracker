import { db } from "@/db";
import {
  transactions, flags, agentSuggestions, chatSessions,
  importBatches, transactionsStaging,
} from "@/db/schema";
import { inArray, eq, isNull, and, count } from "drizzle-orm";
import { pruneOrphanMerchants } from "@/lib/categorizer/rules";

/**
 * Permanently delete transactions and all rows that reference them.
 * Only call with IDs that are already soft-deleted (in the trash).
 * Returns the number of transaction rows removed.
 *
 * Also cleans up import batches: if every transaction from a batch is
 * purged, the batch's staging rows are deleted and the batch itself is
 * soft-deleted so it no longer appears in Import History.
 */
export async function permanentlyDeleteTransactions(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  // Grab descriptions + batchIds before deletion so we can clean up afterwards
  const rows = await db
    .select({ description: transactions.description, batchId: transactions.batchId })
    .from(transactions)
    .where(inArray(transactions.id, ids));
  const descriptions = rows.map((r) => r.description);
  const affectedBatchIds = [...new Set(
    rows.map((r) => r.batchId).filter((id): id is number => id != null)
  )];

  // 1. Remove flags (transaction_id is NOT NULL — can't be nulled)
  await db.delete(flags).where(inArray(flags.transactionId, ids));

  // 2. Remove agent-suggestion audit rows tied to these transactions
  await db.delete(agentSuggestions).where(inArray(agentSuggestions.transactionId, ids));

  // 3. Unlink chat sessions (keep the conversation, drop the dead reference)
  await db
    .update(chatSessions)
    .set({ transactionId: null })
    .where(inArray(chatSessions.transactionId, ids));

  // 4. Unlink any transactions that pointed back at these (reimbursements / transfer pairs)
  for (const id of ids) {
    await db.update(transactions).set({ reimbursementForId: null }).where(eq(transactions.reimbursementForId, id));
    await db.update(transactions).set({ transferPairId: null }).where(eq(transactions.transferPairId, id));
  }

  // 5. Delete the transactions themselves
  const deleted = await db.delete(transactions).where(inArray(transactions.id, ids)).returning({ id: transactions.id });

  // 6. Forget merchant memory no longer backed by any live transaction
  await pruneOrphanMerchants(descriptions);

  // 7. Clean up any import batches that are now completely empty
  for (const batchId of affectedBatchIds) {
    const [{ remaining }] = await db
      .select({ remaining: count() })
      .from(transactions)
      .where(and(
        eq(transactions.batchId, batchId),
        isNull(transactions.deletedAt),
      ));

    if (Number(remaining) === 0) {
      // All live transactions for this batch are gone — remove the raw staging
      // rows and soft-delete the batch so it drops out of Import History
      await db.delete(transactionsStaging).where(eq(transactionsStaging.batchId, batchId));
      await db
        .update(importBatches)
        .set({ deletedAt: new Date() })
        .where(eq(importBatches.id, batchId));
    }
  }

  return deleted.length;
}
