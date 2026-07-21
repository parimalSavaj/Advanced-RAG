// ─── Response Generator ──────────────────────────────────────────────────────
// Assembles context from graded chunks and calls the smart LLM model
// to produce a final answer with citations. RELEVANT chunks come first,
// AMBIGUOUS chunks are appended as secondary context. Token budget is enforced.

import { chat, smartModel, countApproximateTokens } from "../llm/openrouter.js";
import type { GradedChunk } from "../crag/grader.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_CONTEXT_TOKENS = 6000;

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful course assistant for a React Native and Expo mobile development course (Udemy). Your job is to answer the student's question using ONLY the provided source passages.

Rules:
- Answer using ONLY information from the provided source passages
- Cite which specific lesson and timestamp you drew each piece of information from
- Use the format [Module X > Lesson Name | MM:SS - MM:SS] for citations inline or at the end of relevant statements
- If the sources do not contain enough information to fully answer the question, say so plainly rather than guessing
- Do NOT invent or assume anything not present in the sources
- Be concise but thorough — explain concepts clearly for a student
- If multiple sources cover different aspects, synthesize them into a coherent answer`;

// ─── Context Assembly ────────────────────────────────────────────────────────

/**
 * Assembles the context string from graded chunks, respecting token budget.
 * RELEVANT chunks are included first (by score descending), then AMBIGUOUS.
 * Trims lowest-scored chunks if the budget is exceeded.
 *
 * @param gradedChunks - Chunks with their relevance grades
 * @returns The assembled context string and the chunks actually included
 */
function assembleContext(gradedChunks: GradedChunk[]): {
  context: string;
  includedChunks: GradedChunk[];
} {
  // Separate by grade, keeping original score order
  const relevant = gradedChunks.filter((c) => c.grade === "RELEVANT");
  const ambiguous = gradedChunks.filter((c) => c.grade === "AMBIGUOUS");

  // Start with all RELEVANT, then AMBIGUOUS
  let candidates = [...relevant, ...ambiguous];
  let context = formatChunksAsContext(candidates);

  // If over budget, remove AMBIGUOUS first
  if (countApproximateTokens(context) > MAX_CONTEXT_TOKENS) {
    candidates = [...relevant];
    context = formatChunksAsContext(candidates);
  }

  // If still over budget, trim lowest-scored RELEVANT chunks from the end
  while (
    countApproximateTokens(context) > MAX_CONTEXT_TOKENS &&
    candidates.length > 1
  ) {
    candidates.pop();
    context = formatChunksAsContext(candidates);
  }

  return { context, includedChunks: candidates };
}

/**
 * Formats an array of chunks into labeled context blocks for the LLM.
 */
function formatChunksAsContext(chunks: GradedChunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `[Source: ${chunk.moduleName} > ${chunk.lessonName} | Timestamp: ${chunk.startTimestamp} - ${chunk.endTimestamp}]\n${chunk.text}`
    )
    .join("\n\n---\n\n");
}

// ─── Generate Answer ─────────────────────────────────────────────────────────

/**
 * Generates the final answer by assembling context from graded chunks
 * and calling the smart LLM model.
 *
 * @param query - The original user question
 * @param gradedChunks - Chunks that passed C-RAG grading
 * @returns The raw LLM answer text and the chunks that were included in context
 */
export async function generate(
  query: string,
  gradedChunks: GradedChunk[]
): Promise<{ answer: string; includedChunks: GradedChunk[] }> {
  const { context, includedChunks } = assembleContext(gradedChunks);

  const userMessage = `Source passages:
${context}

---

Student's question: ${query}`;

  const answer = await chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { model: smartModel, temperature: 0.3, maxTokens: 2048 }
  );

  return { answer, includedChunks };
}
