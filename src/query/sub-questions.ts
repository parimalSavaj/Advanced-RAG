import { chat, cheapModel } from "../llm/openrouter.js";

// ─── Sub-Question Decomposition ─────────────────────────────────────────────

const DECOMPOSE_PROMPT = `You are a question decomposer. Given a question about React Native or Expo mobile development, break it into simpler, independent sub-questions that each address one part of the original.

Rules:
- Return a JSON array of strings and nothing else
- Each sub-question should be self-contained and focus on one concept
- If the question is already simple and cannot be decomposed, return an array with only the original question
- Do NOT add explanation, markdown formatting, or code fences
- Output ONLY the raw JSON array

Question: `;

/**
 * Decomposes a complex query into simpler, independent sub-questions.
 * Each sub-question targets one aspect of the original, improving
 * retrieval coverage for multi-part questions.
 *
 * Example:
 *   Input: "How do I set up Google OAuth and protected routes in Expo?"
 *   Output: ["How to configure Google OAuth in Expo?", "How to set up protected routes in Expo Router?"]
 *
 * @param query - The original user query
 * @returns Array of simpler sub-questions
 */
export async function decomposeQuery(query: string): Promise<string[]> {
  const response = await chat(
    [{ role: "user", content: DECOMPOSE_PROMPT + query }],
    { model: cheapModel, temperature: 0.2, maxTokens: 512 }
  );

  try {
    // Try to extract JSON array from the response
    let jsonStr = response.trim();

    // Handle cases where model wraps in code fences
    const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((q) => typeof q === "string")) {
      return parsed;
    }

    // Parsed but not a valid string array — fall back
    return [query];
  } catch {
    // JSON parsing failed — return the original query as fallback
    return [query];
  }
}
