import OpenAI from "openai";

function createClient(): OpenAI {
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  const litellmKey = process.env.LITELLM_API_KEY;
  const litellmBase = process.env.LITELLM_BASE_URL;

  if (!litellmKey || !litellmBase) {
    throw new Error(
      "No LLM credentials configured. Set OPENAI_API_KEY or both LITELLM_API_KEY and LITELLM_BASE_URL."
    );
  }

  return new OpenAI({
    apiKey: litellmKey,
    baseURL: litellmBase,
  });
}

// Singleton — reuse across requests in the same process
let _client: OpenAI | null = null;
export function getAIClient(): OpenAI {
  if (!_client) _client = createClient();
  return _client;
}

// Default model: gpt-5.4-mini — accurate on statement parsing (text + vision) and cheap.
// (gpt-5.4-nano was tested and got transaction signs/amounts wrong, so it's avoided.)
// Override via the AI_MODEL env var (a blank value falls back to the default).
export const DEFAULT_MODEL = process.env.AI_MODEL?.trim() || "gpt-5.4-mini";
