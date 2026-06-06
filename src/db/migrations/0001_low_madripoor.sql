CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"tool_results" jsonb,
	"pending_action" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(255),
	"transaction_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"type" varchar(40) NOT NULL,
	"severity" varchar(20) DEFAULT 'info' NOT NULL,
	"reason" text NOT NULL,
	"data" jsonb,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "transactions_fingerprint_idx";--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "currency" SET DEFAULT 'MYR';--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "currency" SET DEFAULT 'MYR';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "account_type" varchar(50);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "account_number" varchar(20);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "account_number_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reimbursement_for_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flags_tx_type_idx" ON "flags" USING btree ("transaction_id","type");--> statement-breakpoint
CREATE INDEX "flags_status_idx" ON "flags" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_fingerprint_idx" ON "transactions" USING btree ("fingerprint") WHERE deleted_at IS NULL;