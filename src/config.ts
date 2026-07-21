import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  // LLM
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY is required"),
  OPENROUTER_MODEL: z.string().default("google/gemini-flash-1.5"),
  OPENROUTER_SMART_MODEL: z.string().default("google/gemini-2.0-flash-001"),

  // Embeddings
  EMBEDDING_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),

  // Qdrant
  QDRANT_URL: z.string().default("http://localhost:6333"),
  QDRANT_COLLECTION: z.string().default("course_subtitles"),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Data
  SUBTITLE_DATA_PATH: z.string().default("./class_subtitle_lyst1784566935215/class-subtitle"),

  // Chunking
  CHUNK_DURATION_SECONDS: z.coerce.number().default(45),
  OVERLAP_SECONDS: z.coerce.number().default(8),

  // RAG
  MAX_CRAG_RETRIES: z.coerce.number().default(3),
  RRF_K: z.coerce.number().default(60),
  TOP_K_RESULTS: z.coerce.number().default(10),

  // Server
  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

// Quick verify when run directly
const isMain = process.argv[1]?.endsWith("config.ts");
if (isMain) {
  console.log("Config loaded successfully:");
  console.log(JSON.stringify(config, null, 2));
}
