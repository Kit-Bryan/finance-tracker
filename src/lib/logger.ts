import pino from "pino";

/**
 * Structured logger for server-side code (API routes, server-run lib modules,
 * scripts). Do NOT import from client components — it pulls in pino (a Node lib).
 *
 * Output is JSON to stdout (captured by `docker compose logs`). For readable dev
 * output, pipe the dev server through pino-pretty:  `next dev | npx pino-pretty`.
 * Do NOT configure pino-pretty as a transport here — its worker thread breaks
 * under Next's bundler.
 *
 * Level via LOG_LEVEL env (default "info"). Sensitive fields are redacted.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "finance-tracker" },
  redact: {
    paths: [
      "accountNumber",
      "*.accountNumber",
      "rawRow",
      "*.rawRow",
      "req.headers.authorization",
    ],
    remove: true,
  },
});
