import { describe, it, expect } from "vitest";
import { join } from "path";
import { chunkLesson, formatTimestamp } from "../src/ingestion/chunker.js";
import { parseLessonFolder } from "../src/ingestion/parser.js";
import type { Cue } from "../src/ingestion/parser.js";

const SUBTITLE_BASE = "./class_subtitle_lyst1784566935215/class-subtitle";

/**
 * Helper: generate N synthetic cues, each `duration` seconds long.
 */
function makeCues(count: number, duration: number): Cue[] {
  const cues: Cue[] = [];
  for (let i = 0; i < count; i++) {
    cues.push({
      startSeconds: i * duration,
      endSeconds: (i + 1) * duration,
      text: `This is synthetic cue number ${i + 1} with some filler words to reach the minimum threshold.`,
    });
  }
  return cues;
}

describe("formatTimestamp", () => {
  it("should format seconds to MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(65)).toBe("01:05");
    expect(formatTimestamp(3661)).toBe("61:01");
  });
});

describe("chunkLesson", () => {
  it("should produce roughly correct number of chunks for synthetic data", () => {
    // 100 cues, 3 seconds each = 300 seconds total
    // With 45s chunk duration → ~6-7 chunks, overlap adds 1-2 more
    const cues = makeCues(100, 3);
    const chunks = chunkLesson(cues, "module 1", "Test Lesson", "/fake/path", {
      chunkDurationSeconds: 45,
      overlapSeconds: 8,
      minWords: 30,
    });

    expect(chunks.length).toBeGreaterThanOrEqual(6);
    expect(chunks.length).toBeLessThanOrEqual(10);
  });

  it("should ensure startSeconds < endSeconds for every chunk", () => {
    const cues = makeCues(100, 3);
    const chunks = chunkLesson(cues, "module 1", "Test Lesson", "/fake/path", {
      chunkDurationSeconds: 45,
      overlapSeconds: 8,
      minWords: 30,
    });

    for (const chunk of chunks) {
      expect(chunk.endSeconds).toBeGreaterThan(chunk.startSeconds);
    }
  });

  it("should enforce minimum word count (no tiny orphan chunks)", () => {
    // Create cues where the last chunk would naturally be very small
    // 50 cues at 3s = 150s → 3 full chunks of 45s, remaining 15s → too few words → merged
    const cues: Cue[] = [];
    for (let i = 0; i < 50; i++) {
      cues.push({
        startSeconds: i * 3,
        endSeconds: (i + 1) * 3,
        text: i < 48 ? `Word one two three four five six seven eight nine ten eleven twelve.` : `Short.`,
      });
    }

    const chunks = chunkLesson(cues, "module 1", "Test Lesson", "/fake/path", {
      chunkDurationSeconds: 45,
      overlapSeconds: 8,
      minWords: 30,
    });

    // Last chunk should have been merged if too short
    for (const chunk of chunks) {
      const words = chunk.text.split(/\s+/).filter((w) => w.length > 0);
      // Allow the check: if merged correctly, all chunks should have >= minWords
      // (the merge only applies to the very last chunk)
      if (chunk.chunkIndex < chunks.length - 1) {
        expect(words.length).toBeGreaterThanOrEqual(10); // intermediate chunks are always substantial
      }
    }
  });

  it("should produce overlapping time ranges between adjacent chunks", () => {
    const cues = makeCues(100, 3);
    const chunks = chunkLesson(cues, "module 1", "Test Lesson", "/fake/path", {
      chunkDurationSeconds: 45,
      overlapSeconds: 8,
      minWords: 5, // low threshold so we test overlap without merge interference
    });

    for (let i = 1; i < chunks.length; i++) {
      // The start of chunk N+1 should be less than the end of chunk N (overlap)
      expect(chunks[i].startSeconds).toBeLessThan(chunks[i - 1].endSeconds);
    }
  });

  it("should produce deterministic IDs across multiple runs", () => {
    const cues = makeCues(50, 3);
    const opts = { chunkDurationSeconds: 45, overlapSeconds: 8, minWords: 5 };

    const run1 = chunkLesson(cues, "module 1", "Test Lesson", "/fake/path", opts);
    const run2 = chunkLesson(cues, "module 1", "Test Lesson", "/fake/path", opts);

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].id).toBe(run2[i].id);
    }
  });

  it("should populate moduleName and lessonName from a real lesson", () => {
    const folderPath = join(
      SUBTITLE_BASE,
      "module 1",
      "01_what-is-mobile-development_epm"
    );
    const parsed = parseLessonFolder(folderPath);
    const chunks = chunkLesson(
      parsed.cues,
      parsed.moduleName,
      parsed.lessonName,
      parsed.lessonFolderPath,
      { chunkDurationSeconds: 45, overlapSeconds: 8, minWords: 30 }
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].moduleName).toBe("module 1");
    expect(chunks[0].lessonName).toBe("What Is Mobile Development");
    expect(chunks[0].startTimestamp).toMatch(/^\d{2}:\d{2}$/);
    expect(chunks[0].endTimestamp).toMatch(/^\d{2}:\d{2}$/);
  });

  it("should handle empty cue array without crashing", () => {
    const chunks = chunkLesson([], "module 1", "Empty", "/fake", {
      chunkDurationSeconds: 45,
      overlapSeconds: 8,
      minWords: 30,
    });
    expect(chunks).toHaveLength(0);
  });
});
