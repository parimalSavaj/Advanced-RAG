// ─── Input Validator ─────────────────────────────────────────────────────────
// Runs three sequential checks on incoming queries before the pipeline does work:
// 1. Length check (no computation)
// 2. PII check (regex-based, uses pii-detector)
// 3. Topic relevance check (LLM call, cheap model)
// Stops immediately if any check fails.

import { detectPii } from "./pii-detector.js";
import { chat, cheapModel } from "../llm/openrouter.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ValidationSuccess {
  passed: true;
  /** The query to use downstream (may be PII-masked version) */
  processedQuery: string;
}

export interface ValidationFailure {
  passed: false;
  /** Human-readable reason for rejection */
  reason: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_QUERY_LENGTH = 500;

// ─── Topic Relevance Prompt ──────────────────────────────────────────────────

const TOPIC_RELEVANCE_PROMPT = `You are a query classifier for a question-answering system built specifically for a React Native and Expo mobile development course (Udemy).

Your job is to determine whether a user's question is relevant to this course's content. The course covers:
- React Native fundamentals (components, styling, navigation)
- Expo framework (setup, configuration, EAS builds)
- Mobile development concepts
- State management, authentication (OAuth, etc.)
- APIs, data fetching, storage
- Deployment, app publishing

Respond with ONLY a JSON object (no markdown, no code fences):
{"relevant": true/false, "reason": "one sentence explanation"}

User's question: `;

// ─── Validator Function ──────────────────────────────────────────────────────

/**
 * Validates an incoming user query through three sequential checks:
 * 1. Length — rejects empty or overly long queries (no computation)
 * 2. PII — detects and masks personal information (regex-based)
 * 3. Topic relevance — uses LLM to check if the query is on-topic
 *
 * Stops at the first failing check to minimize unnecessary work.
 *
 * @param query - The raw user query string
 * @returns A typed result: success with processedQuery, or failure with reason
 */
export async function validateInput(query: string): Promise<ValidationResult> {
  // ── Check 1: Length ──────────────────────────────────────────────────────
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return { passed: false, reason: "Query is empty. Please ask a question." };
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    return {
      passed: false,
      reason: `Query is too long (${trimmed.length} characters). Please keep it under ${MAX_QUERY_LENGTH} characters.`,
    };
  }

  // ── Check 2: PII Detection ──────────────────────────────────────────────
  const piiResult = detectPii(trimmed);
  const processedQuery = piiResult.hasPii ? piiResult.masked : trimmed;

  if (piiResult.hasPii) {
    console.warn(
      `[Guardrails] PII detected (${piiResult.detectedTypes.join(", ")}). Using masked query.`
    );
  }

  // ── Check 3: Topic Relevance (LLM call) ─────────────────────────────────
  try {
    const response = await chat(
      [{ role: "user", content: TOPIC_RELEVANCE_PROMPT + processedQuery }],
      { model: cheapModel, temperature: 0, maxTokens: 128 }
    );

    const parsed = parseRelevanceResponse(response);

    if (!parsed.relevant) {
      return {
        passed: false,
        reason:
          parsed.reason ||
          "Your question does not appear to be related to the React Native and Expo course content.",
      };
    }
  } catch (error) {
    // If the LLM call or parsing fails, default to allowing the query through.
    // It is better to process an ambiguous query than to incorrectly block a legitimate one.
    console.warn(
      "[Guardrails] Topic relevance check failed, allowing query through:",
      error instanceof Error ? error.message : error
    );
  }

  return { passed: true, processedQuery };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Attempts to parse the LLM's relevance JSON response.
 * Falls back to { relevant: true } if parsing fails — never block on bad JSON.
 */
function parseRelevanceResponse(response: string): {
  relevant: boolean;
  reason: string;
} {
  try {
    // Strip markdown code fences if the model wrapped the JSON
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(cleaned);

    return {
      relevant: Boolean(parsed.relevant),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    // JSON parse failed — default to allowing the query
    console.warn("[Guardrails] Could not parse relevance response:", response);
    return { relevant: true, reason: "" };
  }
}
