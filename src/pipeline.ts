// ─── Pipeline Orchestration ──────────────────────────────────────────────────
// The single function that chains all stages together in the correct order.
// This is the only file that knows the full sequence. Every other module is
// unaware of what runs before or after it.
//
// Order: Guardrails → Query Transformation → Retrieval (Dense+Sparse+RRF)
//        → Corrective RAG → Generation → Formatting
//
// Never throws — all errors are caught and returned as typed response objects.

import { validateInput } from "./guardrails/input-validator.js";
import { rewriteQuery } from "./query/rewriter.js";
import { stepBack } from "./query/step-back.js";
import { decomposeQuery } from "./query/sub-questions.js";
import { loadModel } from "./ingestion/embedder.js";
import { DenseRetriever } from "./retrieval/dense-retriever.js";
import { SparseRetriever } from "./retrieval/sparse-retriever.js";
import { fuseRRF } from "./retrieval/rrf.js";
import { gradeAllChunks, passesQualityThreshold } from "./crag/grader.js";
import { runCorrectiveLoop } from "./crag/corrective-loop.js";
import { generate } from "./generation/generator.js";
import { formatResponse, type Citation } from "./generation/formatter.js";
import { config } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineAnswerResponse {
  type: "answer";
  answer: string;
  sources: Citation[];
}

export interface PipelineRejectedResponse {
  type: "rejected";
  reason: string;
}

export interface PipelineNotFoundResponse {
  type: "not-found";
  answer: string;
}

export interface PipelineErrorResponse {
  type: "error";
  answer: string;
}

export type PipelineResponse =
  | PipelineAnswerResponse
  | PipelineRejectedResponse
  | PipelineNotFoundResponse
  | PipelineErrorResponse;

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Runs the full RAG pipeline from raw user query to structured response.
 *
 * Stages:
 * 1. Input validation (guardrails + PII masking)
 * 2. Query transformation (rewrite + step-back + sub-questions, concurrent)
 * 3. Retrieval per transformed query (dense + sparse + RRF)
 * 4. Corrective RAG (grade + retry loop)
 * 5. Response generation (context assembly + LLM)
 * 6. Formatting (citations grouped and sorted)
 *
 * Never throws — wraps all errors into a typed response object.
 *
 * @param query - The raw user query string
 * @returns A typed response: answer, rejected, not-found, or error
 */
export async function runPipeline(query: string): Promise<PipelineResponse> {
  try {
    // ── Stage 1: Input Validation ───────────────────────────────────────────
    console.log("[Pipeline] Stage 1: Input validation...");
    const validation = await validateInput(query);

    if (!validation.passed) {
      return { type: "rejected", reason: validation.reason };
    }

    const processedQuery = validation.processedQuery;

    // ── Stage 2: Query Transformation ───────────────────────────────────────
    console.log("[Pipeline] Stage 2: Query transformation...");
    const [rewritten, broader, subQuestions] = await Promise.all([
      rewriteQuery(processedQuery),
      stepBack(processedQuery),
      decomposeQuery(processedQuery),
    ]);

    // Collect and deduplicate all transformed queries
    const allQueries = [rewritten, broader, ...subQuestions];
    const uniqueQueries = [...new Set(allQueries)].filter(
      (q) => q.trim().length > 0
    );

    console.log(
      `[Pipeline] Transformed into ${uniqueQueries.length} unique queries`
    );

    // ── Stage 3: Retrieval ──────────────────────────────────────────────────
    console.log("[Pipeline] Stage 3: Retrieval...");
    const topK = config.TOP_K_RESULTS;

    const denseRetriever = new DenseRetriever();
    const sparseRetriever = new SparseRetriever();
    await sparseRetriever.load();

    // Run dense + sparse retrieval for each transformed query concurrently
    const allResultLists = await Promise.all(
      uniqueQueries.flatMap((q) => [
        denseRetriever.retrieve(q, topK),
        sparseRetriever.retrieve(q, topK),
      ])
    );

    // Fuse all result lists with RRF
    const fusedResults = fuseRRF(allResultLists, topK);

    console.log(`[Pipeline] Retrieved ${fusedResults.length} fused chunks`);

    // ── Stage 4: Corrective RAG ─────────────────────────────────────────────
    console.log("[Pipeline] Stage 4: Corrective RAG...");
    const cragResult = await runCorrectiveLoop(processedQuery);

    if (cragResult.exhausted) {
      return {
        type: "not-found",
        answer:
          "I wasn't able to find relevant information in the course content to answer your question. This topic may not be covered in the available lessons, or you could try rephrasing your question.",
      };
    }

    // ── Stage 5: Response Generation ────────────────────────────────────────
    console.log("[Pipeline] Stage 5: Response generation...");
    const { answer, includedChunks } = await generate(
      processedQuery,
      cragResult.chunks
    );

    // ── Stage 6: Formatting ─────────────────────────────────────────────────
    console.log("[Pipeline] Stage 6: Formatting response...");
    const formatted = formatResponse(answer, includedChunks);

    console.log(
      `[Pipeline] Complete. ${formatted.sources.length} sources cited.`
    );

    return {
      type: "answer",
      answer: formatted.answer,
      sources: formatted.sources,
    };
  } catch (error) {
    // Never let unhandled errors escape — return a typed error response
    const message =
      error instanceof Error ? error.message : "Unknown error occurred";
    console.error("[Pipeline] Unhandled error:", message);

    return {
      type: "error",
      answer:
        "An internal error occurred while processing your question. Please try again later.",
    };
  }
}
