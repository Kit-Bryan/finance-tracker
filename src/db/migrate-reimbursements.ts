import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "./index";
import { sql } from "drizzle-orm";

// Idempotent: migrate every existing single-FK repayment link
// (transactions.reimbursement_for_id) into one row in reimbursement_allocations.
// Safe to run repeatedly — skips links that already have an allocation.
async function run() {
  const result = await db.execute(sql`
    insert into reimbursement_allocations (repayment_id, expense_id, amount)
    select t.id, t.reimbursement_for_id, t.amount
    from transactions t
    where t.reimbursement_for_id is not null
      and t.deleted_at is null
      and not exists (
        select 1 from reimbursement_allocations a where a.repayment_id = t.id
      )
  `);
  console.log(`Migrated existing repayment links into allocations (rows affected: ${result.rowCount ?? 0}).`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
