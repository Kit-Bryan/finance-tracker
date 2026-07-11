import {
  pgTable,
  serial,
  varchar,
  text,
  numeric,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ─── Accounts ────────────────────────────────────────────────────────────────

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  bank: varchar("bank", { length: 255 }).notNull(),
  accountType: varchar("account_type", { length: 50 }),   // savings | current | credit_card | ewallet
  accountNumber: varchar("account_number", { length: 20 }), // masked for display e.g. ****1234
  accountNumberHash: varchar("account_number_hash", { length: 64 }), // SHA-256 of full number for matching
  currency: varchar("currency", { length: 3 }).notNull().default("MYR"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Import profiles ─────────────────────────────────────────────────────────

export const importProfiles = pgTable("import_profiles", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  bank: varchar("bank", { length: 255 }).notNull(),
  // column mapping and format rules stored as JSONB
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Import batches ──────────────────────────────────────────────────────────

export const importBatches = pgTable("import_batches", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  profileId: integer("profile_id").references(() => importProfiles.id),
  filename: varchar("filename", { length: 500 }).notNull(),
  // Relative path (under uploads/) of the stored original statement, kept for
  // source trace-back. Null for batches imported before this feature existed.
  storedFile: varchar("stored_file", { length: 500 }),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  totalRows: integer("total_rows").default(0),
  importedRows: integer("imported_rows").default(0),
  errorRows: integer("error_rows").default(0),
  errors: jsonb("errors"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Staging transactions (raw parsed rows before promotion) ─────────────────

export const transactionsStaging = pgTable("transactions_staging", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id")
    .notNull()
    .references(() => importBatches.id),
  rawRow: jsonb("raw_row").notNull(),
  fingerprint: varchar("fingerprint", { length: 64 }),
  parseError: text("parse_error"),
  promoted: boolean("promoted").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Categories ──────────────────────────────────────────────────────────────

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  parentId: integer("parent_id"),
  color: varchar("color", { length: 7 }),
  icon: varchar("icon", { length: 50 }),
  isTransfer: boolean("is_transfer").default(false),
  // System role binds a mandatory category to a function (so code references it by role,
  // not by a deletable/renamable name). 'income' | 'transfer' | 'uncategorized'.
  // A non-null role makes the category undeletable.
  role: varchar("role", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

// ─── Transactions (canonical) ─────────────────────────────────────────────────

export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    batchId: integer("batch_id").references(() => importBatches.id),
    categoryId: integer("category_id").references(() => categories.id),
    postedAt: timestamp("posted_at").notNull(),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("MYR"),
    description: text("description").notNull(),
    merchantNormalized: varchar("merchant_normalized", { length: 255 }),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    categorySource: varchar("category_source", { length: 50 }),
    categoryConfidence: numeric("category_confidence", { precision: 4, scale: 3 }),
    isTransfer: boolean("is_transfer").default(false),
    transferPairId: integer("transfer_pair_id"),
    reimbursementForId: integer("reimbursement_for_id"), // links a repayment transfer back to the original group expense
    hidden: boolean("hidden").default(false), // cosmetic: keep the row but hide it from the list (e.g. GO+ internal legs)
    rawRow: jsonb("raw_row"),
    notes: text("notes"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Partial unique index — soft-deleted rows release their fingerprint so re-import works
    fingerprintIdx: uniqueIndex("transactions_fingerprint_idx").on(t.fingerprint).where(sql`deleted_at IS NULL`),
    postedAtIdx: index("transactions_posted_at_idx").on(t.postedAt),
    accountIdx: index("transactions_account_idx").on(t.accountId),
  })
);

// ─── Reimbursement allocations ───────────────────────────────────────────────
// A many-to-many link: one incoming repayment can be split across several expenses,
// and one expense can be repaid by several people. `amount` is how much of the
// repayment (positive) is applied to that expense. Any part of a repayment left
// unallocated stays as income (e.g. a friend rounding up).
export const reimbursementAllocations = pgTable(
  "reimbursement_allocations",
  {
    id: serial("id").primaryKey(),
    repaymentId: integer("repayment_id")
      .notNull()
      .references(() => transactions.id),
    expenseId: integer("expense_id")
      .notNull()
      .references(() => transactions.id),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    repaymentIdx: index("reimb_alloc_repayment_idx").on(t.repaymentId),
    expenseIdx: index("reimb_alloc_expense_idx").on(t.expenseId),
  })
);

// ─── Flags (proactive "needs attention" items) ───────────────────────────────

export const flags = pgTable(
  "flags",
  {
    id: serial("id").primaryKey(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id),
    type: varchar("type", { length: 40 }).notNull(), // reimbursement | low_confidence
    severity: varchar("severity", { length: 20 }).notNull().default("info"), // info | warning
    reason: text("reason").notNull(),
    data: jsonb("data"), // type-specific payload (e.g. reimbursement candidate ids)
    status: varchar("status", { length: 20 }).notNull().default("open"), // open | dismissed | resolved
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    txTypeIdx: index("flags_tx_type_idx").on(t.transactionId, t.type),
    statusIdx: index("flags_status_idx").on(t.status),
  })
);

// ─── Categorization rules ────────────────────────────────────────────────────

export const categorizationRules = pgTable("categorization_rules", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  priority: integer("priority").notNull().default(0),
  pattern: varchar("pattern", { length: 500 }).notNull(),
  patternType: varchar("pattern_type", { length: 20 }).notNull().default("contains"),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
  enabled: boolean("enabled").default(true),
  matchCount: integer("match_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Merchant memory ─────────────────────────────────────────────────────────

export const merchants = pgTable(
  "merchants",
  {
    id: serial("id").primaryKey(),
    normalizedName: varchar("normalized_name", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }),
    categoryId: integer("category_id").references(() => categories.id),
    source: varchar("source", { length: 20 }).notNull().default("user"),
    useCount: integer("use_count").default(1),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    normalizedIdx: uniqueIndex("merchants_normalized_idx").on(t.normalizedName),
  })
);

// ─── Chat sessions ───────────────────────────────────────────────────────────

export const chatSessions = pgTable("chat_sessions", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }),
  transactionId: integer("transaction_id").references(() => transactions.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => chatSessions.id),
  role: varchar("role", { length: 20 }).notNull(), // user | assistant
  content: text("content").notNull(),
  toolResults: jsonb("tool_results"),
  pendingAction: jsonb("pending_action"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Agent suggestions audit ─────────────────────────────────────────────────

export const agentSuggestions = pgTable("agent_suggestions", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id").references(() => transactions.id),
  suggestedCategoryId: integer("suggested_category_id").references(
    () => categories.id
  ),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  reasoning: text("reasoning"),
  accepted: boolean("accepted"),
  modelId: varchar("model_id", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Relations ───────────────────────────────────────────────────────────────

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
  importBatches: many(importBatches),
}));

export const importBatchesRelations = relations(importBatches, ({ one, many }) => ({
  account: one(accounts, { fields: [importBatches.accountId], references: [accounts.id] }),
  profile: one(importProfiles, { fields: [importBatches.profileId], references: [importProfiles.id] }),
  transactions: many(transactions),
  staging: many(transactionsStaging),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, { fields: [transactions.accountId], references: [accounts.id] }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
  batch: one(importBatches, { fields: [transactions.batchId], references: [importBatches.id] }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, { fields: [categories.parentId], references: [categories.id] }),
  children: many(categories),
  transactions: many(transactions),
  rules: many(categorizationRules),
}));
