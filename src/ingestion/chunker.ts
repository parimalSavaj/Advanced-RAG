import { createHash } from "crypto";
import type { Cue } from "./parser.js";
import { config } from "../config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Chunk {
  id: string;
  text: string;
  moduleName: string;
  lessonName: string;
  startSeconds: number;
  endSeconds: number;
  startTimestamp: string;
  endTimestamp: string;
  lessonFolderPath: string;
  chunkIndex: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts seconds to a human-readable MM:SS format.
 */
export function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Generates a deterministic chunk ID from module + lesson + chunk index.
 * Produces a valid UUID-formatted string from MD5 hash (required by Qdrant).
 */
function generateChunkId(
  moduleName: string,
  lessonName: string,
  chunkIndex: number
): string {
  const input = `${moduleName}::${lessonName}::${chunkIndex}`;
  const hash = createHash("md5").update(input).digest("hex");
  // Format as UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Counts words in a string.
 */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ─── Chunker ─────────────────────────────────────────────────────────────────

export interface ChunkOptions {
  chunkDurationSeconds?: number;
  overlapSeconds?: number;
  minWords?: number;
}

/**
 * Groups cues into time-window chunks with overlap.
 *
 * Algorithm:
 * 1. Accumulate cues until the time span exceeds chunkDurationSeconds.
 * 2. Finalize the chunk, keeping the last overlapSeconds of cues as seed for next chunk.
 * 3. After all cues processed, finalize any remaining accumulator.
 * 4. Merge any final chunk that has fewer than minWords into the previous chunk.
 */
export function chunkLesson(
  cues: Cue[],
  moduleName: string,
  lessonName: string,
  lessonFolderPath: string,
  options?: ChunkOptions
): Chunk[] {
  if (cues.length === 0) return [];

  const chunkDuration = options?.chunkDurationSeconds ?? config.CHUNK_DURATION_SECONDS;
  const overlapSecs = options?.overlapSeconds ?? config.OVERLAP_SECONDS;
  const minWords = options?.minWords ?? 30;

  const chunks: Chunk[] = [];
  let accumulator: Cue[] = [];
  let chunkIndex = 0;

  function finalizeChunk(): void {
    if (accumulator.length === 0) return;

    const text = accumulator.map((c) => c.text).join(" ");
    const startSeconds = accumulator[0].startSeconds;
    const endSeconds = accumulator[accumulator.length - 1].endSeconds;

    chunks.push({
      id: generateChunkId(moduleName, lessonName, chunkIndex),
      text,
      moduleName,
      lessonName,
      startSeconds,
      endSeconds,
      startTimestamp: formatTimestamp(startSeconds),
      endTimestamp: formatTimestamp(endSeconds),
      lessonFolderPath,
      chunkIndex,
    });

    chunkIndex++;

    // Keep cues from the last overlapSecs as seed for the next chunk
    const overlapThreshold = endSeconds - overlapSecs;
    accumulator = accumulator.filter((c) => c.startSeconds >= overlapThreshold);
  }

  for (const cue of cues) {
    accumulator.push(cue);

    const span = cue.endSeconds - accumulator[0].startSeconds;
    if (span >= chunkDuration) {
      finalizeChunk();
    }
  }

  // Finalize remaining cues
  if (accumulator.length > 0) {
    finalizeChunk();
  }

  // Merge tiny last chunk into previous if it has fewer than minWords
  if (chunks.length >= 2) {
    const lastChunk = chunks[chunks.length - 1];
    if (wordCount(lastChunk.text) < minWords) {
      const prev = chunks[chunks.length - 2];
      prev.text = prev.text + " " + lastChunk.text;
      prev.endSeconds = lastChunk.endSeconds;
      prev.endTimestamp = formatTimestamp(lastChunk.endSeconds);
      chunks.pop();
    }
  }

  return chunks;
}
