import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../config.js";
import { embed, getEmbeddingDimension } from "./embedder.js";
import type { Chunk } from "./chunker.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;

// ─── Qdrant Client ───────────────────────────────────────────────────────────

const client = new QdrantClient({ url: config.QDRANT_URL });

// ─── Collection Management ───────────────────────────────────────────────────

/**
 * Ensures the Qdrant collection exists with the correct vector configuration.
 * Creates it if it doesn't exist. If it already exists, does nothing.
 */
export async function ensureCollection(): Promise<void> {
  const collectionName = config.QDRANT_COLLECTION;

  try {
    const { collections } = await client.getCollections();
    const exists = collections.some((c) => c.name === collectionName);

    if (exists) {
      console.log(`Collection "${collectionName}" already exists.`);
      return;
    }
  } catch (error) {
    // If getCollections fails, we try to create anyway
  }

  console.log(
    `Creating collection "${collectionName}" (dim=${getEmbeddingDimension()}, distance=Cosine)...`
  );

  await client.createCollection(collectionName, {
    vectors: {
      size: getEmbeddingDimension(),
      distance: "Cosine",
    },
  });

  console.log(`Collection "${collectionName}" created successfully.`);
}

// ─── Indexing ────────────────────────────────────────────────────────────────

/**
 * Embeds and upserts an array of chunks into Qdrant.
 * Processes embeddings sequentially to avoid memory pressure,
 * then upserts in batches of 50.
 *
 * @param chunks - Array of chunks to embed and index
 * @returns The number of points upserted
 */
export async function indexChunks(chunks: Chunk[]): Promise<number> {
  if (chunks.length === 0) return 0;

  const collectionName = config.QDRANT_COLLECTION;

  // Step 1: Embed all chunks sequentially
  const points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  for (const chunk of chunks) {
    const vector = await embed(chunk.text);

    points.push({
      id: chunk.id,
      vector,
      payload: {
        text: chunk.text,
        moduleName: chunk.moduleName,
        lessonName: chunk.lessonName,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        startTimestamp: chunk.startTimestamp,
        endTimestamp: chunk.endTimestamp,
        lessonFolderPath: chunk.lessonFolderPath,
        chunkIndex: chunk.chunkIndex,
      },
    });
  }

  // Step 2: Upsert in batches of BATCH_SIZE
  let upserted = 0;

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);

    await client.upsert(collectionName, {
      wait: true,
      points: batch.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });

    upserted += batch.length;
  }

  return upserted;
}

/**
 * Returns the current point count in the collection.
 */
export async function getCollectionPointCount(): Promise<number> {
  const info = await client.getCollection(config.QDRANT_COLLECTION);
  return info.points_count ?? 0;
}
