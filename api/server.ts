// ─── API Server ──────────────────────────────────────────────────────────────
// Fastify HTTP server exposing the RAG pipeline as a REST API.
// Endpoints:
//   POST /api/query  — run the full pipeline on a user question
//   GET  /health     — check server readiness (Qdrant, model, BM25)
//
// Startup: loads embedding model, BM25 index, and verifies Qdrant connection.
// Graceful shutdown on SIGTERM/SIGINT.

import Fastify from "fastify";
import { config } from "../src/config.js";
import { loadModel } from "../src/ingestion/embedder.js";
import { SparseRetriever } from "../src/retrieval/sparse-retriever.js";
import { runPipeline } from "../src/pipeline.js";

// ─── State ───────────────────────────────────────────────────────────────────

let modelLoaded = false;
let qdrantConnected = false;
let bm25Loaded = false;

// ─── Fastify Instance ────────────────────────────────────────────────────────

const server = Fastify({
  logger: true,
});

// Set request timeout at the HTTP server level (30 seconds)
server.addHook("onReady", () => {
  server.server.requestTimeout = 30_000;
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
server.get("/health", async () => {
  return {
    status: modelLoaded && qdrantConnected && bm25Loaded ? "ok" : "degraded",
    modelLoaded,
    qdrantConnected,
    bm25Loaded,
  };
});

// Query endpoint with schema validation
server.post(
  "/api/query",
  {
    schema: {
      body: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
        },
      },
    },
  },
  async (request) => {
    const { query } = request.body as { query: string };
    const result = await runPipeline(query);
    return result;
  }
);

// ─── Startup ─────────────────────────────────────────────────────────────────

async function startup() {
  console.log("[Server] Starting initialization...");

  // 1. Load embedding model
  try {
    await loadModel();
    modelLoaded = true;
    console.log("[Server] Embedding model loaded.");
  } catch (err) {
    console.error("[Server] Failed to load embedding model:", err);
    process.exit(1);
  }

  // 2. Load BM25 index (by instantiating SparseRetriever)
  try {
    const sparse = new SparseRetriever();
    await sparse.load();
    bm25Loaded = true;
    console.log("[Server] BM25 index loaded.");
  } catch (err) {
    console.error("[Server] Failed to load BM25 index:", err);
    process.exit(1);
  }

  // 3. Verify Qdrant is reachable
  try {
    const response = await fetch(`${config.QDRANT_URL}/healthz`);
    if (response.ok) {
      qdrantConnected = true;
      console.log("[Server] Qdrant connected.");
    } else {
      throw new Error(`Qdrant health check returned ${response.status}`);
    }
  } catch (err) {
    console.error("[Server] Failed to connect to Qdrant:", err);
    process.exit(1);
  }

  // 4. Start listening
  try {
    await server.listen({ port: config.PORT, host: "0.0.0.0" });
    console.log(
      `[Server] Server listening on port ${config.PORT}. All systems ready.`
    );
  } catch (err) {
    console.error("[Server] Failed to start server:", err);
    process.exit(1);
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`[Server] Received ${signal}. Starting graceful shutdown...`);
  try {
    await server.close(); // Stops accepting new requests, waits for in-flight
    console.log("[Server] Server closed gracefully.");
    process.exit(0);
  } catch (err) {
    console.error("[Server] Error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start ───────────────────────────────────────────────────────────────────

startup();
