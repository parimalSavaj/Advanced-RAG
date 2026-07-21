// ─── Corrective RAG Loop ─────────────────────────────────────────────────────
// Orchestrates the retrieval → grade → retry cycle.
// If retrieval quality is poor (fewer than 5 RELEVANT chunks out of top-K),
// retries up to 3 times with different query reformulation strategies:
//   Attempt 1: original query
//   Attempt 2: broadened query (more general)
//   Attempt 3: narrowed query (single core concept)
// Returns graded chunks on success, or { exhausted: true } if all attempts fail.

import { chat, cheapModel } from "../llm/openrouter.js";
import { config } from "../config.js";
import { loadModel, embed } from "../ingestion/embedder.js";
import { DenseRetriever } from "../retrieval/dense-retriever.js";
import { SparseRetriever } from "../retrieval/sparse-retriever.js";
import { fuseRRF } from "../retrieval/rrf.js";
import {
  gradeAllChunks,
  passesQualityThreshold,
  type GradedChunk,
} from "./grader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CorrectiveLoopSuccess {
  exhausted: false;
  chunks: GradedChunk[];
  attempts: number;
}

export interface CorrectiveLoopExhausted {
  exhausted: true;
  attempts: number;
}

export type CorrectiveLoopResult =
  | CorrectiveLoopSuccess
  | CorrectiveLoopExhausted;

// ─── Query Reformulation Prompts ─────────────────────────────────────────────

const BROADEN_PROMPT = `You are a search query optimizer. The following query did not find good results in a React Native and Expo course transcript database. Make it MORE GENERAL by removing specific constraints or jargon so it matches broader content.

Original query: `;

const NARROW_PROMPT = `You are a search query optimizer. The following query did not find good results in a React Native and Expo course transcript database. Focus it on the SINGLE MOST ESSENTIAL concept, stripping everything else.

Original query: `;

const REFORMULATION_SUFFIX = `

Output ONLY the reformulated query text, nothing else. Keep it under 200 characters.`;

// ─── Reformulation Helpers ───────────────────────────────────────────────────

/**
 * Broadens the query — makes it more general to match wider content.
 * Used on attempt 2 when the original was too specific.
 */
async function broadenQuery(query: string): Promise<string> {
  try {
    const response = await chat(
      [{ role: "user", content: BROADEN_PROMPT + query + REFORMULATION_SUFFIX }],
      { model: cheapModel, temperature: 0.3, maxTokens: 128 }
    );
    const result = response.trim();
    return result.length > 200 ? result.slice(0, 200) : result;
  } catch {
    // If reformulation fails, fall back to original
    return query;
  }
}

/**
 * Narrows the query — focuses on the single core concept.
 * Used on attempt 3 when broadening also failed.
 */
async function narrowQuery(query: string): Promise<string> {
  try {
    const response = await chat(
      [{ role: "user", content: NARROW_PROMPT + query + REFORMULATION_SUFFIX }],
      { model: cheapModel, temperature: 0.3, maxTokens: 128 }
    );
    const result = response.trim();
    return result.length > 200 ? result.slice(0, 200) : result;
  } catch {
    // If reformulation fails, fall back to original
    return query;
  }
}

// ─── Retrieval Helper ────────────────────────────────────────────────────────

/** Shared retriever instances (initialized once on first call) */
let denseRetriever: DenseRetriever | null = null;
let sparseRetriever: SparseRetriever | null = null;

/**
 * Runs both dense + sparse retrieval and fuses results with RRF.
 * Initializes retrievers on first call.
 */
async function retrieveAndFuse(query: string): Promise<import("../retrieval/adapter.js").RetrievedChunk[]> {
  const topK = config.TOP_K_RESULTS;

  if (!denseRetriever) {
    denseRetriever = new DenseRetriever();
  }
  if (!sparseRetriever) {
    sparseRetriever = new SparseRetriever();
    await sparseRetriever.load();
  }

  // Run both retrievers concurrently
  const [denseResults, sparseResults] = await Promise.all([
    denseRetriever.retrieve(query, topK),
    sparseRetriever.retrieve(query, topK),
  ]);

  // Fuse with Reciprocal Rank Fusion
  return fuseRRF([denseResults, sparseResults], topK);
}

// ─── Corrective Loop ─────────────────────────────────────────────────────────

/**
 * Runs the corrective RAG loop:
 * 1. Retrieve chunks using the current query formulation
 * 2. Grade all chunks for relevance
 * 3. If quality passes (>=5 RELEVANT), return graded chunks
 * 4. If quality fails and attempts remain, reformulate and retry
 * 5. If all attempts exhausted, return { exhausted: true }
 *
 * Retry strategy:
 * - Attempt 1: original query
 * - Attempt 2: broadened (more general) query
 * - Attempt 3: narrowed (single core concept) query
 *
 * @param query - The user's (possibly transformed) query
 * @returns Graded chunks on success, or exhausted indicator on failure
 */
export async function runCorrectiveLoop(
  query: string
): Promise<CorrectiveLoopResult> {
  const maxAttempts = config.MAX_CRAG_RETRIES;
  let currentQuery = query;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[C-RAG] Attempt ${attempt}/${maxAttempts} | Query: "${currentQuery.slice(0, 80)}${currentQuery.length > 80 ? "..." : ""}"`
    );

    // Retrieve and fuse
    const chunks = await retrieveAndFuse(currentQuery);

    if (chunks.length === 0) {
      console.log(`[C-RAG] No chunks retrieved on attempt ${attempt}`);
      // No results at all — try reformulation if attempts remain
      if (attempt < maxAttempts) {
        currentQuery =
          attempt === 1
            ? await broadenQuery(query)
            : await narrowQuery(query);
        continue;
      }
      return { exhausted: true, attempts: attempt };
    }

    // Grade all chunks in parallel
    const gradedChunks = await gradeAllChunks(chunks, query);

    const relevantCount = gradedChunks.filter(
      (c) => c.grade === "RELEVANT"
    ).length;
    console.log(
      `[C-RAG] Grading complete: ${relevantCount} RELEVANT, ${gradedChunks.filter((c) => c.grade === "AMBIGUOUS").length} AMBIGUOUS, ${gradedChunks.filter((c) => c.grade === "IRRELEVANT").length} IRRELEVANT`
    );

    // Check quality threshold
    if (passesQualityThreshold(gradedChunks)) {
      return { exhausted: false, chunks: gradedChunks, attempts: attempt };
    }

    // Quality insufficient — reformulate for next attempt
    if (attempt < maxAttempts) {
      currentQuery =
        attempt === 1
          ? await broadenQuery(query)
          : await narrowQuery(query);
    }
  }

  // All attempts exhausted without passing quality threshold
  console.log("[C-RAG] All attempts exhausted. Retrieval quality insufficient.");
  return { exhausted: true, attempts: maxAttempts };
}
