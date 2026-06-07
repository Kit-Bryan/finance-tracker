import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!_db) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
    _db = drizzle(pool, { schema });
  }
  return _db;
}

// Convenience proxy so existing code using `db.select()` etc. still works
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    const instance = getDb() as unknown as Record<string | symbol, unknown>;
    return instance[prop];
  },
});

export type DB = ReturnType<typeof getDb>;
