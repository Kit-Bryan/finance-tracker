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
import { relations } from "drizzle-orm";

// ─── Accounts ────────────────────────────────────────────────────────────────

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  bank: varchar("bank", { length: 255 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
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
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  totalRows: integer("total_rows").default(0),
  importedRows: integer("imported_rows").default(0),
  errorRows: integer("error_rows").default(0),
  errors: jsonb("errors"),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
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
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    description: text("description").notNull(),
    merchantNormalized: varchar("merchant_normalized", { length: 255 }),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    categorySource: varchar("category_source", { length: 50 }),
    categoryConfidence: numeric("category_confidence", { precision: 4, scale: 3 }),
    isTransfer: boolean("is_transfer").default(false),
    transferPairId: integer("transfer_pair_id"),
    rawRow: jsonb("raw_row"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    fingerprintIdx: uniqueIndex("transactions_fingerprint_idx").on(t.fingerprint),
    postedAtIdx: index("transactions_posted_at_idx").on(t.postedAt),
    accountIdx: index("transactions_account_idx").on(t.accountId),
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
