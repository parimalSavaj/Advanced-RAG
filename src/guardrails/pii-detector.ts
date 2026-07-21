// ─── PII Detector ────────────────────────────────────────────────────────────
// Scans text for personal identifiable information using regex patterns.
// Returns whether PII was found and a masked version of the text.
// No LLM calls — this is purely pattern-based for speed and reliability.

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PiiDetectionResult {
  /** Whether any PII pattern was detected */
  hasPii: boolean;
  /** The text with detected PII replaced by placeholders */
  masked: string;
  /** Which PII types were found */
  detectedTypes: string[];
}

// ─── PII Patterns ────────────────────────────────────────────────────────────

const PII_PATTERNS: { type: string; pattern: RegExp; placeholder: string }[] = [
  {
    type: "EMAIL",
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    placeholder: "[EMAIL]",
  },
  {
    type: "PHONE",
    // Matches 10-13 digit sequences with optional separators (spaces, dashes, dots, parens)
    pattern: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g,
    placeholder: "[PHONE]",
  },
  {
    type: "AADHAAR",
    // Indian Aadhaar: 12 digits in groups of 4 separated by spaces or dashes
    pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    placeholder: "[AADHAAR]",
  },
  {
    type: "PAN",
    // Indian PAN card: 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)
    pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    placeholder: "[PAN]",
  },
];

// ─── Detector Function ───────────────────────────────────────────────────────

/**
 * Scans the input text for common PII patterns (email, phone, Aadhaar, PAN)
 * and returns a result indicating what was found and the masked text.
 *
 * This function uses regex only — no LLM calls. It focuses on high-confidence
 * structural patterns that are unambiguous. Does not attempt to detect names
 * or addresses (those require NLP and are out of scope).
 *
 * @param text - The raw input text to scan
 * @returns Detection result with hasPii flag, masked text, and detected types
 */
export function detectPii(text: string): PiiDetectionResult {
  let masked = text;
  const detectedTypes: string[] = [];

  for (const { type, pattern, placeholder } of PII_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;

    if (pattern.test(text)) {
      detectedTypes.push(type);
      // Reset again before replace (test() advances lastIndex)
      pattern.lastIndex = 0;
      masked = masked.replace(pattern, placeholder);
    }
  }

  return {
    hasPii: detectedTypes.length > 0,
    masked,
    detectedTypes,
  };
}
