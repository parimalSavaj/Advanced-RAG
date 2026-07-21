import type { RetrievedChunk } from "./adapter.js";
import { config } from "../config.js";

// ─── Reciprocal Rank Fusion ──────────────────────────────────────────────────

/**
 * Fuses multiple ranked lists into one using Reciprocal Rank Fusion (RRF).
 *
 * For each unique chunk across all lists, computes:
 *   fusedScore = Σ 1 / (k + rank)
 * where rank is 1-indexed position in each list where the chunk appears.
 *
 * Chunks appearing in multiple lists score higher than those in only one.
 * This rewards consistent relevance across different retrieval strategies.
 *
 * @param rankedLists - Array of ranked result lists (each sorted by score desc)
 * @param topK - Number of results to return
 * @returns Fused and re-ranked results
 */
export function fuseRRF(
  rankedLists: RetrievedChunk[][],
  topK: number
): RetrievedChunk[] {
  const k = config.RRF_K; // Default 60

  // Map: chunkId → { chunk, fusedScore }
  const scoreMap = new Map<
    string,
    { chunk: RetrievedChunk; fusedScore: number }
  >();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const chunk = list[rank];
      const rrfContribution = 1 / (k + rank + 1); // rank is 1-indexed

      const existing = scoreMap.get(chunk.id);
      if (existing) {
        existing.fusedScore += rrfContribution;
      } else {
        scoreMap.set(chunk.id, {
          chunk,
          fusedScore: rrfContribution,
        });
      }
    }
  }

  // Sort by fused score descending and return top K
  const fused = Array.from(scoreMap.values())
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, topK)
    .map((entry) => ({
      ...entry.chunk,
      score: entry.fusedScore,
    }));

  return fused;
}
