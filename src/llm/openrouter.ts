import OpenAI from "openai";
import { config } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// ─── Model Shortcuts ─────────────────────────────────────────────────────────

/**
 * Cheap model — used for grading, classification, query rewriting.
 * Fast and low cost. (Gemini Flash 1.5)
 */
export const cheapModel: string = config.OPENROUTER_MODEL;

/**
 * Smart model — used for final answer generation and complex reasoning.
 * Higher quality output. (Gemini 2.0 Flash)
 */
export const smartModel: string = config.OPENROUTER_SMART_MODEL;

// ─── OpenAI Client (pointed at OpenRouter) ───────────────────────────────────

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://advanced-rag-course-qa.local",
    "X-Title": "Advanced RAG Course QA",
  },
});

// ─── Retry Logic ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff in ms

function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || error.status === 503;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chat Function ───────────────────────────────────────────────────────────

/**
 * Sends a chat completion request to OpenRouter.
 * Retries up to 3 times on rate limit (429) or overloaded (503) errors
 * with exponential backoff.
 *
 * @param messages - Array of chat messages (system/user/assistant)
 * @param options - Model, temperature, maxTokens
 * @returns The assistant's response text
 */
export async function chat(
  messages: ChatMessage[],
  options?: ChatOptions
): Promise<string> {
  const model = options?.model ?? cheapModel;
  const temperature = options?.temperature ?? 0.3;
  const maxTokens = options?.maxTokens ?? 2048;

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("OpenRouter returned an empty response.");
      }

      return content.trim();
    } catch (error) {
      lastError = error;

      if (attempt < MAX_RETRIES && isRetryableError(error)) {
        const delay = RETRY_DELAYS[attempt] ?? 4000;
        const apiErr = error as InstanceType<typeof OpenAI.APIError>;
        console.warn(
          `OpenRouter ${apiErr.status} error. Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`
        );
        await sleep(delay);
        continue;
      }

      // Non-retryable error or retries exhausted
      break;
    }
  }

  // All retries failed or non-retryable error
  if (lastError instanceof OpenAI.APIError) {
    throw new Error(
      `OpenRouter API error (${lastError.status}): ${lastError.message}`
    );
  }
  throw lastError;
}

// ─── Token Estimator ─────────────────────────────────────────────────────────

/**
 * Estimates token count using the ~4 characters per token heuristic.
 * Good enough for context window budget checks — not a precise tokenizer.
 */
export function countApproximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
