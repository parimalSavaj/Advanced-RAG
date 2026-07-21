// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Represents a single retrieved chunk with its relevance score.
 * This is the common output format for all retrievers.
 */
export interface RetrievedChunk {
  id: string;
  text: string;
  moduleName: string;
  lessonName: string;
  startTimestamp: string;
  endTimestamp: string;
  startSeconds: number;
  endSeconds: number;
  score: number;
}

// ─── Retriever Interface ─────────────────────────────────────────────────────

/**
 * The adapter interface that all retrievers must implement.
 * The rest of the pipeline only types things as Retriever,
 * never as the concrete implementations.
 */
export interface Retriever {
  retrieve(query: string, topK: number): Promise<RetrievedChunk[]>;
}
