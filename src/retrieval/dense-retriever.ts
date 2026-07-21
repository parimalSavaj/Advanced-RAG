import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config.js";
import { embed } from "../ingestion/embedder.js";
import type { Retriever, RetrievedChunk } from "./adapter.js";

// ─── Dense Retriever ─────────────────────────────────────────────────────────

/**
 * Queries Qdrant using vector similarity (cosine distance).
 * Embeds the query with the same model used during ingestion,
 * then searches for the nearest vectors in the collection.
 */
export class DenseRetriever implements Retriever {
  private client: QdrantClient;
  private collectionName: string;

  constructor() {
    this.client = new QdrantClient({ url: config.QDRANT_URL });
    this.collectionName = config.QDRANT_COLLECTION;
  }

  async retrieve(query: string, topK: number): Promise<RetrievedChunk[]> {
    // Embed the query using the same model/normalization as ingestion
    const queryVector = await embed(query);

    // Search Qdrant for nearest vectors
    const results = await this.client.search(this.collectionName, {
      vector: queryVector,
      limit: topK,
      with_payload: true,
    });

    // Map Qdrant results to RetrievedChunk objects
    return results.map((result) => {
      const payload = result.payload as Record<string, unknown>;

      return {
        id: String(result.id),
        text: String(payload.text ?? ""),
        moduleName: String(payload.moduleName ?? ""),
        lessonName: String(payload.lessonName ?? ""),
        startTimestamp: String(payload.startTimestamp ?? ""),
        endTimestamp: String(payload.endTimestamp ?? ""),
        startSeconds: Number(payload.startSeconds ?? 0),
        endSeconds: Number(payload.endSeconds ?? 0),
        score: result.score,
      };
    });
  }
}
