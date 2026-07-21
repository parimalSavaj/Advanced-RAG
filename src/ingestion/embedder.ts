import { config } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type Pipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

// ─── Module State ────────────────────────────────────────────────────────────

let pipeline: Pipeline | null = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initializes the embedding pipeline. Must be called once before using embed().
 * Downloads the model on first run (~90MB), uses local cache subsequently.
 */
export async function loadModel(): Promise<void> {
  if (pipeline) return; // Already loaded

  // Dynamic import because @xenova/transformers is ESM-only
  const { pipeline: createPipeline } = await import("@xenova/transformers");

  console.log(`Loading embedding model: ${config.EMBEDDING_MODEL}...`);
  pipeline = (await createPipeline(
    "feature-extraction",
    config.EMBEDDING_MODEL
  )) as unknown as Pipeline;
  console.log("Embedding model loaded successfully.");
}

/**
 * Embeds a single text string into a 384-dimensional unit vector.
 * Uses mean pooling across tokens and L2 normalization.
 *
 * @param text - The text to embed
 * @returns A normalized 384-dimensional vector
 */
export async function embed(text: string): Promise<number[]> {
  if (!pipeline) {
    throw new Error(
      "Embedding model not loaded. Call loadModel() before embed()."
    );
  }

  const output = await pipeline(text, {
    pooling: "mean",
    normalize: true,
  });

  // The pipeline with pooling:"mean" and normalize:true returns a tensor.
  // Extract the raw float array and convert to a regular number[].
  const vector = Array.from(output.data as Float32Array);

  // Safety check: ensure normalization (should already be done by the pipeline,
  // but we verify and re-normalize if needed for numerical stability)
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (Math.abs(norm - 1.0) > 0.01) {
    // Re-normalize manually if the pipeline didn't do it
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i] / norm;
    }
  }

  return vector;
}

/**
 * Returns the expected embedding dimension (384 for all-MiniLM-L6-v2).
 */
export function getEmbeddingDimension(): number {
  return 384;
}
