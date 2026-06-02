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

// Default model: prefer a fast/cheap model; override via env
export const DEFAULT_MODEL = process.env.AI_MODEL ?? "gpt-5.1";
