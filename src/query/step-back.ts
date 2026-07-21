import { chat, cheapModel } from "../llm/openrouter.js";

// ─── Step-Back Prompting ─────────────────────────────────────────────────────

const STEP_BACK_PROMPT = `You are a question generalizer. Given a specific question about React Native or Expo mobile development, generate a broader conceptual question that captures the general principle or concept behind it.

The broader question will be used to retrieve background information from a React Native and Expo course.

Rules:
- Return ONLY the broader question, nothing else
- The question must end with a question mark
- Do NOT answer the original question
- Do NOT add any explanation or prefix

Specific question: `;

/**
 * Generates a broader, more conceptual question from the user's specific query.
 * Used to retrieve background/foundational context that supports the answer.
 *
 * Example:
 *   Input: "Why does my FlatList re-render on every state change?"
 *   Output: "What causes unnecessary re-renders in React Native and how are they prevented?"
 *
 * @param query - The original user query
 * @returns A broader conceptual question
 */
export async function stepBack(query: string): Promise<string> {
  const response = await chat(
    [{ role: "user", content: STEP_BACK_PROMPT + query }],
    { model: cheapModel, temperature: 0.3, maxTokens: 256 }
  );

  let result = response.trim();

  // If the model wrapped it in explanation, extract just the question
  const lines = result.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const questionLine = lines.find((l) => l.endsWith("?"));
  if (questionLine) {
    result = questionLine;
  }

  return result;
}
