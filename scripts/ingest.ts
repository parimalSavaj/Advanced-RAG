/**
 * Full Ingestion Script
 *
 * Orchestrates the complete data ingestion pipeline:
 * 1. Walks all module/lesson folders in the subtitle data directory
 * 2. Parses each lesson's VTT/SRT file into cues
 * 3. Chunks cues into time-window segments with overlap
 * 4. Embeds and upserts all chunks to Qdrant
 * 5. Builds and saves a BM25 index for sparse retrieval
 * 6. Saves a chunks-by-id lookup map for metadata resolution
 *
 * Run with: npm run ingest
 */

import { readdirSync, statSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { config } from "../src/config.js";
import { parseLessonFolder } from "../src/ingestion/parser.js";
import { chunkLesson, type Chunk } from "../src/ingestion/chunker.js";
import { loadModel } from "../src/ingestion/embedder.js";
import {
  ensureCollection,
  indexChunks,
  getCollectionPointCount,
} from "../src/ingestion/indexer.js";

// @ts-expect-error — wink-bm25-text-search has no type declarations
import bm25 from "wink-bm25-text-search";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Discovers all lesson folders inside the subtitle data path.
 * Structure: dataPath / module_folder / lesson_folder /
 */
function discoverLessonFolders(dataPath: string): string[] {
  const lessonFolders: string[] = [];

  const moduleDirs = readdirSync(dataPath).filter((entry) => {
    const fullPath = join(dataPath, entry);
    return statSync(fullPath).isDirectory() && !entry.startsWith(".");
  });

  for (const moduleDir of moduleDirs) {
    const modulePath = join(dataPath, moduleDir);

    const lessonDirs = readdirSync(modulePath).filter((entry) => {
      const fullPath = join(modulePath, entry);
      return statSync(fullPath).isDirectory() && !entry.startsWith(".");
    });

    for (const lessonDir of lessonDirs) {
      lessonFolders.push(join(modulePath, lessonDir));
    }
  }

  return lessonFolders;
}

/**
 * Simple tokenizer for BM25: lowercase, split on non-alphanumeric, filter empties.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// ─── Main Ingestion ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Advanced RAG — Full Ingestion Pipeline");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log();

  // Step 1: Load the embedding model
  console.log("[1/5] Loading embedding model...");
  await loadModel();
  console.log();

  // Step 2: Ensure Qdrant collection exists
  console.log("[2/5] Ensuring Qdrant collection...");
  await ensureCollection();
  console.log();

  // Step 3: Discover and process all lessons
  console.log("[3/5] Processing lessons...");
  console.log(`  Data path: ${config.SUBTITLE_DATA_PATH}`);

  const lessonFolders = discoverLessonFolders(config.SUBTITLE_DATA_PATH);
  console.log(`  Found ${lessonFolders.length} lesson folders.`);
  console.log();

  const allChunks: Chunk[] = [];
  let totalIndexed = 0;
  let lessonsProcessed = 0;
  let lessonsFailed = 0;

  for (const folder of lessonFolders) {
    try {
      // Parse
      const parsed = parseLessonFolder(folder);

      if (parsed.cues.length === 0) {
        console.log(
          `  ⚠ Skipped (no cues): ${parsed.moduleName} / ${parsed.lessonName}`
        );
        continue;
      }

      // Chunk
      const chunks = chunkLesson(
        parsed.cues,
        parsed.moduleName,
        parsed.lessonName,
        parsed.lessonFolderPath
      );

      // Embed & Index
      const indexed = await indexChunks(chunks);
      totalIndexed += indexed;

      // Collect for BM25
      allChunks.push(...chunks);

      lessonsProcessed++;
      console.log(
        `  Processing: ${parsed.moduleName} / ${parsed.lessonName}... ${chunks.length} chunks indexed`
      );
    } catch (error) {
      lessonsFailed++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Failed: ${folder} — ${msg}`);
    }
  }

  console.log();
  console.log(
    `  Lessons processed: ${lessonsProcessed} | Failed: ${lessonsFailed}`
  );
  console.log(`  Total chunks indexed: ${totalIndexed}`);
  console.log();

  // Step 4: Build and save BM25 index
  console.log("[4/5] Building BM25 sparse index...");

  const bm25Engine = bm25();

  // Define the fields the BM25 engine will index
  bm25Engine.defineConfig({ fldWeights: { text: 1 } });
  bm25Engine.definePrepTasks([tokenize]);

  for (const chunk of allChunks) {
    bm25Engine.addDoc({ text: chunk.text }, chunk.id);
  }

  bm25Engine.consolidate();

  // Ensure data directory exists
  const dataDir = join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true });

  // Export and save the BM25 index
  const bm25Export = bm25Engine.exportJSON();
  const bm25Path = join(dataDir, "bm25-index.json");
  writeFileSync(bm25Path, JSON.stringify(bm25Export));
  console.log(`  BM25 index saved: ${bm25Path}`);
  console.log();

  // Step 5: Save chunks-by-id lookup map
  console.log("[5/5] Saving chunks-by-id lookup map...");

  const chunksById: Record<string, Omit<Chunk, "id">> = {};
  for (const chunk of allChunks) {
    const { id, ...rest } = chunk;
    chunksById[id] = rest;
  }

  const chunksByIdPath = join(dataDir, "chunks-by-id.json");
  writeFileSync(chunksByIdPath, JSON.stringify(chunksById));
  console.log(`  Chunks-by-id map saved: ${chunksByIdPath}`);
  console.log();

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const pointCount = await getCollectionPointCount();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Ingestion Complete!");
  console.log(`  Time elapsed: ${elapsed}s`);
  console.log(`  Lessons processed: ${lessonsProcessed}`);
  console.log(`  Total chunks in Qdrant: ${pointCount}`);
  console.log(`  BM25 index entries: ${allChunks.length}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((error) => {
  console.error("Ingestion failed with an unhandled error:");
  console.error(error);
  process.exit(1);
});
