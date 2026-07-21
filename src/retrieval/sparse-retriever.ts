import { readFileSync } from "fs";
import { join } from "path";
import type { Retriever, RetrievedChunk } from "./adapter.js";
import type { Chunk } from "../ingestion/chunker.js";

// @ts-expect-error — wink-bm25-text-search has no type declarations
import bm25 from "wink-bm25-text-search";

// ─── Sparse Retriever ────────────────────────────────────────────────────────

/**
 * Simple tokenizer matching the one used during ingestion.
 * Lowercase, split on non-alphanumeric, filter empties.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Queries the BM25 keyword index built during ingestion.
 * Loads the index and chunks-by-id map from disk at initialization.
 */
export class SparseRetriever implements Retriever {
  private engine: ReturnType<typeof bm25> | null = null;
  private chunksById: Record<string, Omit<Chunk, "id">> = {};
  private loaded = false;

  /**
   * Loads the BM25 index and chunks-by-id map from disk.
   * Must be called once before retrieve().
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    const dataDir = join(process.cwd(), "data");

    // Load BM25 index
    const bm25Data = readFileSync(join(dataDir, "bm25-index.json"), "utf-8");
    this.engine = bm25();
    this.engine.definePrepTasks([tokenize]);
    this.engine.importJSON(JSON.parse(bm25Data));

    // Load chunks-by-id lookup map
    const chunksData = readFileSync(
      join(dataDir, "chunks-by-id.json"),
      "utf-8"
    );
    this.chunksById = JSON.parse(chunksData);

    this.loaded = true;
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    if (!this.engine) {
      throw new Error(
        "BM25 index not loaded. Call load() before retrieve()."
      );
    }

    // BM25 search returns an array of [id, score] pairs
    const rawResults = this.engine.search(query, topK) as Array<
      [string, number]
    >;

    if (rawResults.length === 0) return [];

    // Find the maximum score for normalization to 0–1 range
    const maxScore = rawResults[0][1]; // Results are sorted by score desc

    // Map results to RetrievedChunk objects
    const results: RetrievedChunk[] = [];

    for (const [id, score] of rawResults) {
      const chunk = this.chunksById[id];
      if (!chunk) continue;

      results.push({
        id,
        text: chunk.text,
        moduleName: chunk.moduleName,
        lessonName: chunk.lessonName,
        startTimestamp: chunk.startTimestamp,
        endTimestamp: chunk.endTimestamp,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        score: maxScore > 0 ? score / maxScore : 0,
      });
    }

    return results;
  }
}
