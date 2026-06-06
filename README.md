# Finance Tracker

Personal finance app — import bank CSVs and PDFs, auto-categorize with AI, chat with an agent that can edit, split, and reorganize transactions.

---

## Quick start (new machine)

**Prerequisites:** [Docker](https://www.docker.com), [Node 20+](https://nodejs.org)

```bash
git clone <repo> finance-tracker
cd finance-tracker
npm run setup
```

That single command will:

1. Check Docker + Node versions
2. Create `.env.local` and prompt for your LiteLLM API key
3. `npm install`
4. Start Postgres in Docker
5. Apply all schema migrations
6. Seed the starter categories

When it's done:

```bash
npm run dev
```

Open <http://localhost:3000>.

---

## Moving your data between machines

### Export

```bash
npm run export              # writes finance-YYYY-MM-DD.dump
npm run export my-backup.dump   # custom filename
```

This runs `pg_dump` inside the Docker container — no local Postgres client needed.

### Import

Copy the `.dump` file to the new machine (after running `npm run setup` there), then:

```bash
npm run import my-backup.dump
```

You'll be asked to confirm — this **replaces** all data in the current database.

---

## Configuration

`.env.local`:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Auto-set by setup. Points at the Docker Postgres. |
| `LITELLM_API_KEY` | Yes* | Your LiteLLM proxy key |
| `LITELLM_BASE_URL` | Yes* | LiteLLM proxy base URL |
| `OPENAI_API_KEY` | Optional | If set, OpenAI is used directly and LiteLLM is ignored |
| `APP_PASSWORD` | Optional | Local app password |

*Not required if `OPENAI_API_KEY` is set. Default model: `gpt-5.4-mini`.

---

## Scripts

| Command | Description |
|---|---|
| `npm run setup` | One-time fresh-machine setup |
| `npm run dev` | Start dev server |
| `npm run export [file]` | Dump database to file |
| `npm run import <file>` | Restore database from dump |
| `npm run db:studio` | Open Drizzle Studio (visual DB browser) |
| `npm run db:generate` | Generate a new migration after schema changes |

---

## Architecture notes

- **AI layer**: OpenAI-compatible API (LiteLLM proxy or OpenAI direct). All AI calls flow through `src/lib/ai/client.ts`.
- **Soft deletes**: Transactions and import batches use `deleted_at` timestamps. Partial unique index on `fingerprint` means deleted rows release their slot so re-imports work.
- **Agent tools**: `src/lib/ai/agent.ts` defines the tools available to the chat agent (search, edit, split, categorize, create/update categories, link reimbursements).
- **Currency**: MYR throughout. Change defaults in `src/db/schema/index.ts` if needed.
