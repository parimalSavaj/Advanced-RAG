// ─── Response Formatter ──────────────────────────────────────────────────────
// Takes the raw LLM answer and the source chunks used in context,
// and produces a structured response with clean, human-readable citations.
// Citations are grouped by lesson and sorted by module number then timestamp.

import type { GradedChunk } from "../crag/grader.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Citation {
  moduleName: string;
  lessonName: string;
  startTimestamp: string;
  endTimestamp: string;
  /** Human-readable combined reference string */
  reference: string;
}

export interface FormattedResponse {
  answer: string;
  sources: Citation[];
  totalChunksUsed: number;
}

// ─── Formatter ───────────────────────────────────────────────────────────────

/**
 * Formats the raw LLM answer and source chunks into a structured response
 * with grouped, sorted citations.
 *
 * Citations are grouped by lesson — if multiple chunks from the same lesson
 * were used, one citation entry is produced with the earliest start timestamp
 * and latest end timestamp. Citations are sorted by module number ascending,
 * then by start timestamp ascending within each module.
 *
 * @param rawAnswer - The raw text response from the LLM
 * @param includedChunks - The graded chunks that were included in the LLM context
 * @returns A structured response with answer, sources, and metadata
 */
export function formatResponse(
  rawAnswer: string,
  includedChunks: GradedChunk[]
): FormattedResponse {
  // Group chunks by lesson (moduleName + lessonName)
  const lessonMap = new Map<
    string,
    {
      moduleName: string;
      lessonName: string;
      startSeconds: number;
      endSeconds: number;
      startTimestamp: string;
      endTimestamp: string;
    }
  >();

  for (const chunk of includedChunks) {
    const key = `${chunk.moduleName}::${chunk.lessonName}`;
    const existing = lessonMap.get(key);

    if (existing) {
      // Extend the time range: earliest start, latest end
      if (chunk.startSeconds < existing.startSeconds) {
        existing.startSeconds = chunk.startSeconds;
        existing.startTimestamp = chunk.startTimestamp;
      }
      if (chunk.endSeconds > existing.endSeconds) {
        existing.endSeconds = chunk.endSeconds;
        existing.endTimestamp = chunk.endTimestamp;
      }
    } else {
      lessonMap.set(key, {
        moduleName: chunk.moduleName,
        lessonName: chunk.lessonName,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        startTimestamp: chunk.startTimestamp,
        endTimestamp: chunk.endTimestamp,
      });
    }
  }

  // Convert to citation objects and sort
  const citations: Citation[] = Array.from(lessonMap.values())
    .sort((a, b) => {
      const moduleA = extractModuleNumber(a.moduleName);
      const moduleB = extractModuleNumber(b.moduleName);
      if (moduleA !== moduleB) return moduleA - moduleB;
      return a.startSeconds - b.startSeconds;
    })
    .map((entry) => ({
      moduleName: entry.moduleName,
      lessonName: entry.lessonName,
      startTimestamp: entry.startTimestamp,
      endTimestamp: entry.endTimestamp,
      reference: `${capitalizeModule(entry.moduleName)} > ${entry.lessonName} — [${entry.startTimestamp} - ${entry.endTimestamp}]`,
    }));

  return {
    answer: rawAnswer.trim(),
    sources: citations,
    totalChunksUsed: includedChunks.length,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extracts the numeric module number from a module name string.
 * e.g. "module 3" → 3, "module 13" → 13, "module 1 hc" → 1
 */
function extractModuleNumber(moduleName: string): number {
  const match = moduleName.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Capitalizes the module name for display.
 * e.g. "module 3" → "Module 3"
 */
function capitalizeModule(moduleName: string): string {
  return moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
}
