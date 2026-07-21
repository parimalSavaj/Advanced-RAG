import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  parseVTT,
  parseSRT,
  extractLessonName,
  parseLessonFolder,
} from "../src/ingestion/parser.js";

const SUBTITLE_BASE = "./class_subtitle_lyst1784566935215/class-subtitle";

describe("parseVTT", () => {
  it("should parse a real VTT file with correct cue structure", () => {
    const lessonPath = join(
      SUBTITLE_BASE,
      "module 1",
      "01_what-is-mobile-development_epm",
      "01_what-is-mobile-development_epm.vtt"
    );
    const { readFileSync } = require("fs");
    const content = readFileSync(lessonPath, "utf-8");
    const cues = parseVTT(content);

    expect(cues.length).toBeGreaterThan(0);

    for (const cue of cues) {
      expect(cue.startSeconds).toBeGreaterThanOrEqual(0);
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
      expect(cue.text.length).toBeGreaterThan(0);
    }
  });

  it("should strip HTML tags from VTT text", () => {
    const vttContent = `WEBVTT

00:00:01.000 --> 00:00:05.000
Hello <c>world</c> this is <b>bold</b> text

00:00:06.000 --> 00:00:10.000
Another <i>cue</i> here
`;
    const cues = parseVTT(vttContent);

    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Hello world this is bold text");
    expect(cues[1].text).toBe("Another cue here");
    // No angle brackets in any text
    for (const cue of cues) {
      expect(cue.text).not.toMatch(/[<>]/);
    }
  });

  it("should skip NOTE blocks and empty cues", () => {
    const vttContent = `WEBVTT

NOTE This is a comment block
that spans multiple lines

00:00:01.000 --> 00:00:03.000
Actual content here

00:00:04.000 --> 00:00:06.000
   

00:00:07.000 --> 00:00:09.000
More content
`;
    const cues = parseVTT(vttContent);

    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Actual content here");
    expect(cues[1].text).toBe("More content");
  });
});

describe("parseSRT", () => {
  it("should parse a real SRT file and produce same results as VTT", () => {
    const { readFileSync } = require("fs");

    const vttPath = join(
      SUBTITLE_BASE,
      "module 1",
      "01_what-is-mobile-development_epm",
      "01_what-is-mobile-development_epm.vtt"
    );
    const srtPath = join(
      SUBTITLE_BASE,
      "module 1",
      "01_what-is-mobile-development_epm",
      "01_what-is-mobile-development_epm.srt"
    );

    const vttCues = parseVTT(readFileSync(vttPath, "utf-8"));
    const srtCues = parseSRT(readFileSync(srtPath, "utf-8"));

    // Same number of cues
    expect(srtCues.length).toBe(vttCues.length);

    // Same text and timestamps for each cue
    for (let i = 0; i < vttCues.length; i++) {
      expect(srtCues[i].text).toBe(vttCues[i].text);
      expect(srtCues[i].startSeconds).toBeCloseTo(vttCues[i].startSeconds, 2);
      expect(srtCues[i].endSeconds).toBeCloseTo(vttCues[i].endSeconds, 2);
    }
  });
});

describe("extractLessonName", () => {
  it("should handle numeric underscore prefix", () => {
    expect(extractLessonName("01_what-is-mobile-development_epm")).toBe(
      "What Is Mobile Development"
    );
  });

  it("should handle chapter-N-title pattern", () => {
    expect(extractLessonName("chapter-3-implementing-google-oauth_epm")).toBe(
      "Implementing Google Oauth"
    );
  });

  it("should handle numeric dot prefix with spaces", () => {
    expect(
      extractLessonName(
        "1. What Is EAS Build Why You Need It & Dev Builds vs Expo Go_epm"
      )
    ).toBe("What Is EAS Build Why You Need It & Dev Builds Vs Expo Go");
  });

  it("should handle plain title with no prefix", () => {
    expect(extractLessonName("Expo Version change so quickly_epm")).toBe(
      "Expo Version Change So Quickly"
    );
  });

  it("should handle chapter with no body after the number (chapter-3_epm)", () => {
    const result = extractLessonName("chapter-3_epm");
    expect(result.length).toBeGreaterThan(0);
  });

  it("should handle dot prefix without space (3.Configure...)", () => {
    expect(
      extractLessonName(
        "3.Configure, Create & Test EAS Development Builds - From Setup to Device_epm"
      )
    ).toBe(
      "Configure, Create & Test EAS Development Builds From Setup To Device"
    );
  });
});

describe("parseLessonFolder", () => {
  it("should parse a lesson folder and return correct metadata", () => {
    const folderPath = join(
      SUBTITLE_BASE,
      "module 1",
      "01_what-is-mobile-development_epm"
    );
    const result = parseLessonFolder(folderPath);

    expect(result.moduleName).toBe("module 1");
    expect(result.lessonName).toBe("What Is Mobile Development");
    expect(result.cues.length).toBeGreaterThan(0);
    expect(result.lessonFolderPath).toBe(folderPath);
  });

  it("should work with chapter-style folder names", () => {
    const folderPath = join(
      SUBTITLE_BASE,
      "module 13",
      "chapter-3-implementing-google-oauth_epm"
    );
    const result = parseLessonFolder(folderPath);

    expect(result.moduleName).toBe("module 13");
    expect(result.lessonName).toBe("Implementing Google Oauth");
    expect(result.cues.length).toBeGreaterThan(0);
  });
});
