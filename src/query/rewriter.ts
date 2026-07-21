import { chat, cheapModel } from "../llm/openrouter.js";

// ─── Query Rewriter ──────────────────────────────────────────────────────────

const REWRITE_PROMPT = `You are a search query optimizer. Your job is to rewrite a user's question into a clear, specific search string that will be used to search a vector database of Udemy course transcripts about React Native and Expo mobile development.

Rules:
- Rewrite the query to be clear, specific, and jargon-appropriate
- Do NOT answer the question
- Do NOT add any explanation or prefix like "Rewritten query:"
- Output ONLY the rewritten query text, nothing else
- Keep it under 200 characters

User's question: `;

/**
 * Rephrases the user's query for better vector search results.
 * Uses the cheap model to rewrite vague or informal queries
 * into clear, specific search strings.
 *
 * @param query - The original user query
 * @returns A rewritten, search-optimized query string
 */
export async function rewriteQuery(query: string): Promise<string> {
  const response = await chat(
    [{ role: "user", content: REWRITE_PROMPT + query }],
    { model: cheapModel, temperature: 0.2, maxTokens: 256 }
  );

  // Truncate to 200 chars if the model returned something too long
  let rewritten = response.trim();
  if (rewritten.length > 200) {
    rewritten = rewritten.slice(0, 200);
  }

  return rewritten;
}
