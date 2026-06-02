# Finance Tracker

Personal finance app — import bank CSVs, auto-categorize transactions, and generate spending insights.

---

## Requirements

- [Node.js 20+](https://nodejs.org)
- [Docker](https://www.docker.com) (for Postgres)
- `pg_dump` / `pg_restore` on your PATH (for export/import)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local`:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Postgres connection string |
| `LITELLM_API_KEY` | Yes* | LiteLLM proxy API key |
| `LITELLM_BASE_URL` | Yes* | LiteLLM proxy base URL |
| `OPENAI_API_KEY` | Optional | If set, uses OpenAI directly — LiteLLM is ignored |
| `APP_PASSWORD` | Optional | Simple password to protect the app |

*Not required if `OPENAI_API_KEY` is set.

**LLM priority:** `OPENAI_API_KEY` wins over LiteLLM. Default model: `gpt-5.1`.

### 3. Start Postgres

```bash
docker compose up -d db
```

### 4. Push schema + seed categories

```bash
npm run db:push
npm run db:seed
```

### 5. Run the app

```bash
npm run dev
```

App is at [http://localhost:3000](http://localhost:3000).

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run db:push` | Sync schema to database |
| `npm run db:seed` | Load starter categories |
| `npm run db:studio` | Open Drizzle Studio (visual DB browser) |
| `npm run db:generate` | Generate a new migration file |

---

## Moving to another machine

**Export** — download a full DB dump from the running app:

```bash
curl http://localhost:3000/api/export -o backup.dump
```

**Import** — restore into a fresh Postgres:

```bash
./scripts/import.sh backup.dump
```
