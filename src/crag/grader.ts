// ─── Chunk Grader ────────────────────────────────────────────────────────────
// Grades each retrieved chunk as RELEVANT, IRRELEVANT, or AMBIGUOUS
// with respect to the user's query. Uses the cheap LLM model.
// Grading calls are independent and run in parallel via Promise.all.

import { chat, cheapModel } from "../llm/openrouter.js";
import type { RetrievedChunk } from "../retrieval/adapter.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ChunkGrade = "RELEVANT" | "IRRELEVANT" | "AMBIGUOUS";

export interface GradedChunk extends RetrievedChunk {
  grade: ChunkGrade;
}

// ─── Grading Prompt ──────────────────────────────────────────────────────────

function buildGradingPrompt(chunkText: string, query: string): string {
  return `You are a relevance grader for a retrieval-augmented generation system.

Given the following passage from a React Native and Expo development course transcript, determine if it helps answer the user's question.

Passage:
"""
${chunkText}
"""

Question: ${query}

Does this passage help answer the question? Answer with exactly one word: RELEVANT, IRRELEVANT, or AMBIGUOUS.`;
}

// ─── Grade Single Chunk ──────────────────────────────────────────────────────

/**
 * Grades a single retrieved chunk against the user's query.
 * Sends the chunk text and query to the cheap LLM model and expects
 * one of: RELEVANT, IRRELEVANT, or AMBIGUOUS.
 *
 * Falls back to AMBIGUOUS if the model returns an unexpected response.
 *
 * @param chunk - The retrieved chunk to grade
 * @param query - The original user query
 * @returns The grade for this chunk
 */
export async function gradeChunk(
  chunk: RetrievedChunk,
  query: string
): Promise<ChunkGrade> {
  try {
    const response = await chat(
      [{ role: "user", content: buildGradingPrompt(chunk.text, query) }],
      { model: cheapModel, temperature: 0, maxTokens: 16 }
    );

    // Extract the first word and normalize to uppercase
    const firstWord = response.trim().split(/\s+/)[0]?.toUpperCase();

    if (
      firstWord === "RELEVANT" ||
      firstWord === "IRRELEVANT" ||
      firstWord === "AMBIGUOUS"
    ) {
      return firstWord;
    }

    // Model returned something unexpected — default to AMBIGUOUS
    return "AMBIGUOUS";
  } catch (error) {
    // If grading fails (e.g. rate limit), default to AMBIGUOUS rather than crashing
    console.warn(
      "[C-RAG] Grading failed for chunk, defaulting to AMBIGUOUS:",
      error instanceof Error ? error.message : error
    );
    return "AMBIGUOUS";
  }
}

// ─── Grade All Chunks ────────────────────────────────────────────────────────

/**
 * Grades all retrieved chunks in parallel against the user's query.
 * Returns the chunks augmented with their grade.
 *
 * @param chunks - Array of retrieved chunks to grade
 * @param query - The original user query
 * @returns Array of graded chunks in the same order
 */
export async function gradeAllChunks(
  chunks: RetrievedChunk[],
  query: string
): Promise<GradedChunk[]> {
  const grades = await Promise.all(
    chunks.map((chunk) => gradeChunk(chunk, query))
  );

  return chunks.map((chunk, i) => ({
    ...chunk,
    grade: grades[i],
  }));
}

// ─── Quality Check ───────────────────────────────────────────────────────────

/** Minimum number of RELEVANT chunks needed to pass quality threshold */
const RELEVANCE_THRESHOLD = 5;

/**
 * Checks whether the graded results meet the quality threshold.
 * Returns true if at least RELEVANCE_THRESHOLD chunks are graded RELEVANT.
 */
export function passesQualityThreshold(gradedChunks: GradedChunk[]): boolean {
  const relevantCount = gradedChunks.filter(
    (c) => c.grade === "RELEVANT"
  ).length;
  return relevantCount >= RELEVANCE_THRESHOLD;
}
