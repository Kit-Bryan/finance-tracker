import { config } from "dotenv";
config({ path: ".env.local" });
import { ensureSystemCategories } from "../lib/categories";

// Idempotent backfill: tag/create the mandatory system categories (income, transfer,
// uncategorized) with their role. Safe to run after db:push or on existing databases.
ensureSystemCategories()
  .then(() => {
    console.log("System categories ensured (income, transfer, uncategorized, other_income).");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
