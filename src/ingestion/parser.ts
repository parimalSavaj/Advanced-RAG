import { readFileSync, readdirSync } from "fs";
import { join, basename, dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Cue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface ParsedLesson {
  cues: Cue[];
  moduleName: string;
  lessonName: string;
  lessonFolderPath: string;
}

// ─── Timestamp Parsing ───────────────────────────────────────────────────────

/**
 * Converts a timestamp string like "00:01:04.759" or "00:01:04,759" to total seconds.
 */
function parseTimestamp(ts: string): number {
  // Normalize comma to period (SRT uses commas)
  const normalized = ts.replace(",", ".");
  const parts = normalized.split(":");

  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]);
    const seconds = parseFloat(parts[1]);
    return minutes * 60 + seconds;
  }

  return parseFloat(normalized);
}

// ─── Text Cleaning ───────────────────────────────────────────────────────────

/**
 * Strips HTML tags, karaoke timestamps, and cleans whitespace from cue text.
 */
function cleanText(raw: string): string {
  let text = raw;

  // Remove HTML-like tags: <c>, </c>, <b>, </b>, <i>, </i>, etc.
  text = text.replace(/<[^>]+>/g, "");

  // Remove inline karaoke timestamps like <00:00:01.234>
  text = text.replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, "");

  // Collapse multiple whitespace/newlines into single space
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

// ─── VTT Parser ──────────────────────────────────────────────────────────────

/**
 * Parses a WebVTT file content string into an array of Cue objects.
 */
export function parseVTT(content: string): Cue[] {
  const cues: Cue[] = [];

  // Split by blank lines (one or more empty lines)
  const blocks = content.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");

    // Skip the WEBVTT header block
    if (lines[0]?.trim().startsWith("WEBVTT")) continue;

    // Skip NOTE blocks
    if (lines[0]?.trim().startsWith("NOTE")) continue;

    // Find the timing line (contains "-->")
    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingLineIndex === -1) continue;

    const timingLine = lines[timingLineIndex];
    const timingMatch = timingLine.match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
    );

    if (!timingMatch) continue;

    const startSeconds = parseTimestamp(timingMatch[1]);
    const endSeconds = parseTimestamp(timingMatch[2]);

    // Text is everything after the timing line
    const rawText = lines.slice(timingLineIndex + 1).join(" ");
    const text = cleanText(rawText);

    // Skip empty cues
    if (!text) continue;

    cues.push({ startSeconds, endSeconds, text });
  }

  return cues;
}

// ─── SRT Parser ──────────────────────────────────────────────────────────────

/**
 * Parses an SRT file content string into an array of Cue objects.
 */
export function parseSRT(content: string): Cue[] {
  const cues: Cue[] = [];

  // Split by blank lines
  const blocks = content.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // Find the timing line (contains "-->")
    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingLineIndex === -1) continue;

    const timingLine = lines[timingLineIndex];
    const timingMatch = timingLine.match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
    );

    if (!timingMatch) continue;

    const startSeconds = parseTimestamp(timingMatch[1]);
    const endSeconds = parseTimestamp(timingMatch[2]);

    // Text is everything after the timing line
    const rawText = lines.slice(timingLineIndex + 1).join(" ");
    const text = cleanText(rawText);

    // Skip empty cues
    if (!text) continue;

    cues.push({ startSeconds, endSeconds, text });
  }

  return cues;
}

// ─── Lesson Name Extraction ──────────────────────────────────────────────────

/**
 * Extracts a clean, human-readable lesson name from a folder name.
 *
 * Examples:
 *   "01_what-is-mobile-development_epm"          → "What Is Mobile Development"
 *   "chapter-3-implementing-google-oauth_epm"    → "Implementing Google OAuth"
 *   "1. What Is EAS Build Why You Need It_epm"   → "What Is EAS Build Why You Need It"
 *   "chapter-3_epm"                              → "Chapter 3"
 *   "Expo Version change so quickly_epm"         → "Expo Version Change So Quickly"
 */
export function extractLessonName(folderName: string): string {
  let name = folderName;

  // Remove _epm suffix
  name = name.replace(/_epm$/i, "");

  // Remove leading numeric prefix patterns:
  //   "01_", "02_", "1.", "2. ", "3."
  name = name.replace(/^\d+[._]\s*/, "");

  // Remove leading "chapter-N-", "chapter-N ", "chapter_N_" patterns
  // but keep it if that's ALL there is (like "chapter-3")
  const chapterBodyMatch = name.match(
    /^chapter[-_]?\d+[-_ ]\s*(.+)/i
  );
  if (chapterBodyMatch && chapterBodyMatch[1]) {
    name = chapterBodyMatch[1];
  }

  // Replace hyphens and underscores with spaces
  name = name.replace(/[-_]+/g, " ");

  // Collapse multiple spaces
  name = name.replace(/\s+/g, " ").trim();

  // Title case: capitalize first letter of each word
  name = name
    .split(" ")
    .map((word) => {
      if (!word) return "";
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");

  // If after all stripping the name is empty, fall back to the original folder name cleaned up
  if (!name) {
    name = folderName.replace(/_epm$/i, "").replace(/[-_]+/g, " ").trim();
    name = name.charAt(0).toUpperCase() + name.slice(1);
  }

  return name;
}

// ─── Parse Lesson Folder ─────────────────────────────────────────────────────

/**
 * Given a lesson folder path, finds the VTT (or SRT) file, parses it,
 * and returns the cues along with extracted metadata.
 */
export function parseLessonFolder(lessonFolderPath: string): ParsedLesson {
  const folderName = basename(lessonFolderPath);
  const parentFolderName = basename(dirname(lessonFolderPath));

  // Find VTT or SRT file inside the folder
  const files = readdirSync(lessonFolderPath);
  const vttFile = files.find((f) => f.endsWith(".vtt"));
  const srtFile = files.find((f) => f.endsWith(".srt"));

  const subtitleFile = vttFile || srtFile;
  if (!subtitleFile) {
    throw new Error(`No VTT or SRT file found in: ${lessonFolderPath}`);
  }

  const filePath = join(lessonFolderPath, subtitleFile);
  const content = readFileSync(filePath, "utf-8");

  const cues = subtitleFile.endsWith(".vtt")
    ? parseVTT(content)
    : parseSRT(content);

  const moduleName = parentFolderName;
  const lessonName = extractLessonName(folderName);

  return {
    cues,
    moduleName,
    lessonName,
    lessonFolderPath,
  };
}
