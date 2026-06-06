import { db } from "@/db";
import { transactions, flags, agentSuggestions, chatSessions } from "@/db/schema";
import { inArray, eq } from "drizzle-orm";
import { pruneOrphanMerchants } from "@/lib/categorizer/rules";

/**
 * Permanently delete transactions and all rows that reference them.
 * Only call with IDs that are already soft-deleted (in the trash).
 * Returns the number of transaction rows removed.
 */
export async function permanentlyDeleteTransactions(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  // Grab descriptions first so we can prune now-orphaned merchant memory afterwards
  const rows = await db
    .select({ description: transactions.description })
    .from(transactions)
    .where(inArray(transactions.id, ids));
  const descriptions = rows.map((r) => r.description);

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

  return deleted.length;
}
