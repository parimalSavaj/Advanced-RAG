# Advanced RAG — Stage-by-Stage Build Guide

This document is your step-by-step construction manual. Every stage tells you what to build, why it exists, how it works internally, which files to create, and exactly how to verify it is working before you move to the next stage. Do not skip verification. A broken foundation will corrupt every stage built on top of it.

Read the whole document once before starting. Then come back and follow it stage by stage.

---

## Progress Tracker

| Stage | Description | Status |
|-------|-------------|--------|
| 0 | Project Setup & Infrastructure | DONE |
| 1 | Data Ingestion: Parser | DONE |
| 2 | Data Ingestion: Chunker | DONE |
| 3 | Data Ingestion: Embedder & Indexer | DONE |
| 4 | Retrieval: Dense + Sparse + RRF | DONE |
| 5 | LLM Client: OpenRouter Wrapper | TODO |
| 6 | Query Transformation | TODO |
| 7 | Input Guardrails & PII Detection | TODO |
| 8 | Corrective RAG (C-RAG) | TODO |
| 9 | Response Generation & Formatting | TODO |
| 10 | Pipeline Orchestration | TODO |
| 11 | API Server | TODO |
| 12 | End-to-End Verification | TODO |

---

## The Big Picture Before You Start

You are building a question-answering system over 87 Udemy course lessons stored as subtitle files. The system lets a student ask a question in plain English and get back a precise answer with citations pointing to the exact lesson and timestamp in the video.

The raw data is in `class_subtitle_lyst1784566935215/class-subtitle/`. Each lesson folder contains a `.vtt` and `.srt` file with the spoken transcript broken into timestamped cue blocks. Those files are your entire knowledge base.

There are two completely separate runtimes in this project. The first is the ingestion script — a one-time batch job that reads all subtitle files, processes them, and loads them into the database. The second is the API server — a long-running HTTP server that students query. You build and run ingestion first, verify the data is indexed, and only then build the API. They share library code but are never run at the same time.

The pipeline a query goes through at runtime has six stages: guardrails, query transformation, adapter, retrieval with RRF, corrective RAG, and response generation. You will build these in a different order than they run — you build retrieval first (stages 3 and 4) because that is the core, then add the intelligence layers around it.


---

## Stage 0 — Project Setup and Infrastructure

### What You Are Building

The TypeScript project skeleton, environment configuration, and the Docker containers for Qdrant (vector database) and Redis (cache). Nothing intelligent yet — just the foundation that everything else runs on.

### Why This Stage Exists

Every subsequent stage depends on a working Node.js/TypeScript environment and a running Qdrant instance. Getting infrastructure right first means you will never be debugging a RAG problem that is actually a connection config problem.

### What to Create

At the root of the project, create the following files:

`package.json` — defines the project name, scripts, and all dependencies. Key dependencies are: `typescript`, `tsx` (for running TypeScript directly), `@qdrant/js-client-rest` (Qdrant SDK), `@xenova/transformers` (local embedding model), `wink-bm25-text-search` (sparse retrieval), `webvtt-parser` (VTT parsing), `fastify` (HTTP server), `dotenv`, and `zod` (for config validation). Dev dependencies include `vitest` (test runner) and TypeScript types.

`tsconfig.json` — TypeScript config. Use `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`, `"strict": true`, and set `"outDir": "./dist"`. The `NodeNext` resolution mode is important because `@xenova/transformers` uses ES module imports.

`.env.example` — template for all environment variables. Copy this to `.env` and fill in values. Variables needed at this stage: `QDRANT_URL` (default `http://localhost:6333`), `QDRANT_COLLECTION` (default `course_subtitles`), `REDIS_URL` (default `redis://localhost:6379`), `SUBTITLE_DATA_PATH` (path to the class-subtitle folder).

`docker-compose.yml` — defines two services. The `qdrant` service uses the official `qdrant/qdrant:latest` image, maps ports 6333 (REST) and 6334 (gRPC), and mounts a named volume for persistence. The `redis` service uses `redis:7-alpine`, maps port 6379, and also uses a named volume.

`src/config.ts` — reads all environment variables using `dotenv`, validates them with `zod`, and exports a typed config object. Any missing required variable should throw an error at startup with a clear message. This file is imported by everything else — it is the single source of truth for configuration.

### How to Verify

**Manual verification — do these yourself:**

1. Start the Docker containers:
   ```
   docker compose up -d
   ```
   You should see both `qdrant` and `redis` containers start successfully.

2. Check Qdrant is alive:
   ```
   curl http://localhost:6333/healthz
   ```
   Expected output: `healthz check passed`

3. Check Redis is alive:
   ```
   docker exec advanced-rag-redis-1 redis-cli ping
   ```
   Expected output: `PONG`

4. Verify TypeScript + environment config works:
   ```
   npx tsx src/config.ts
   ```
   Expected output: a JSON object printed with all your config values (QDRANT_URL, REDIS_URL, PORT, etc.). If any required variable is missing, you will see a clear error message telling you which one.

5. Open Qdrant dashboard in your browser:
   ```
   http://localhost:6333/dashboard
   ```
   You should see the Qdrant web UI. No collections yet — that is expected at this stage.


---

## Stage 1 — Data Ingestion: Parser

### What You Are Building

`src/ingestion/parser.ts` — a module that reads one VTT or SRT file from disk and returns a structured array of cue objects. Each cue has a `startSeconds` number, `endSeconds` number, and `text` string.

### Why This Stage Exists

Everything downstream — chunking, embedding, indexing — depends on having clean, structured cue data. If your parser produces garbage (wrong timestamps, dirty text, missed cues), every chunk and every search result will be wrong. The parser is the most important correctness boundary in the whole system.

### How It Works Internally

A VTT file starts with the header line `WEBVTT` and then contains blank-line-separated blocks. Each block has a timing line in the format `HH:MM:SS.mmm --> HH:MM:SS.mmm` optionally followed by cue settings, and then one or more lines of text. You split the file content by double newlines to get blocks, skip the header block, then for each remaining block find the line containing `-->` to extract start and end times, and join the remaining lines as the text.

SRT files are almost the same but each block also has a sequential number on the first line (before the timing line), and timestamps use commas instead of periods for milliseconds (`00:00:04,260` vs `00:00:04.260`).

Timestamp parsing converts `HH:MM:SS.mmm` into a total seconds float: `hours * 3600 + minutes * 60 + seconds + milliseconds / 1000`.

Text cleaning must strip: HTML-like tags such as `<c>`, `</c>`, karaoke timestamps like `<00:00:01.234>`, and any leading or trailing whitespace. Some VTT files also contain `NOTE` blocks (used for comments by caption tools) — these must be skipped entirely. After cleaning, if the text of a cue is empty, discard that cue.

The module also needs a `parseLessonFolder` function. Given a lesson folder path, it finds the `.vtt` file inside, calls the VTT parser, and returns the cue array plus the extracted module name and lesson name. Module name comes from the parent folder name (e.g. `module 3`). Lesson name comes from the folder name itself after stripping the `_epm` suffix and any leading prefix pattern like `01_`, `02_`, `chapter-1-`, `chapter-2-` — normalize hyphens and underscores to spaces and apply title case. The result for `chapter-3-implementing-google-oauth_epm` should be `Implementing Google OAuth`.

### Files to Create

`src/ingestion/parser.ts`

### How to Verify


**Manual verification — do these yourself:**

1. Open a terminal in the project root and run:
   ```
   npx tsx -e "import { parseLessonFolder } from './src/ingestion/parser.js'; const r = parseLessonFolder('./class_subtitle_lyst1784566935215/class-subtitle/module 1/01_what-is-mobile-development_epm'); console.log('Module:', r.moduleName); console.log('Lesson:', r.lessonName); console.log('Total cues:', r.cues.length); console.log('First cue:', r.cues[0]); console.log('Last cue:', r.cues[r.cues.length-1]);"
   ```
   You should see:
   - Module: `module 1`
   - Lesson: `What Is Mobile Development`
   - Total cues: a number > 30
   - First cue starts at 0 seconds with "Hello everyone and welcome..."
   - Last cue has an endSeconds value that represents the video length

2. Try another folder with a different naming pattern:
   ```
   npx tsx -e "import { parseLessonFolder } from './src/ingestion/parser.js'; const r = parseLessonFolder('./class_subtitle_lyst1784566935215/class-subtitle/module 13/chapter-3-implementing-google-oauth_epm'); console.log('Module:', r.moduleName); console.log('Lesson:', r.lessonName); console.log('Total cues:', r.cues.length);"
   ```
   Lesson name should be: `Implementing Google Oauth` and cue count should be > 50.

3. Verify text cleaning — pick any cue text from step 1 output and confirm there are no `<c>`, `</c>`, or other HTML tags in the text.


---

## Stage 2 — Data Ingestion: Chunker

### What You Are Building

`src/ingestion/chunker.ts` — a module that takes a flat array of cues from the parser and groups them into chunks. Each chunk represents a contiguous segment of speech and carries all the metadata needed for both retrieval and citation.

### Why This Stage Exists

Individual cues are 2–8 seconds of speech — far too short to carry enough context for a meaningful answer. A chunk of 40–50 seconds gives the LLM enough surrounding speech to understand what is being explained. The chunker is also where you attach the metadata (module name, lesson name, timestamps) that will eventually appear in your citations.

### How It Works Internally

The core algorithm is a sliding time window. You iterate through cues keeping a running accumulator. When the time span from the first cue in the accumulator to the current cue's end time exceeds `CHUNK_DURATION_SECONDS` (set to 45 in your config), you finalize the current accumulator as a chunk and start a new one. The text of the chunk is all the cue texts joined with a single space.

Overlap is implemented as follows: when you finalize a chunk, you do not clear the accumulator completely. Instead, you keep the cues from the last `OVERLAP_SECONDS` (set to 8) worth of time in the accumulator as the seed for the next chunk. This means the next chunk starts with some text from the end of the previous chunk, so concepts at boundaries are not lost.

Minimum chunk size protection: after finalization, if a chunk has fewer than 30 words, merge it into the previous chunk rather than storing it as its own chunk. This prevents tiny orphan chunks from polluting your index.

The unique ID for each chunk must be deterministic and stable across re-runs of ingestion. Derive it by hashing the combination of `moduleName + lessonName + chunkIndex` using a simple hash function. Using a stable ID enables upsert behavior in Qdrant — running ingestion twice will overwrite existing points rather than creating duplicates.

Each chunk object contains: `id` (string), `text` (string), `moduleName` (string), `lessonName` (string), `startSeconds` (number), `endSeconds` (number), `lessonFolderPath` (string), `chunkIndex` (number), and a formatted `startTimestamp` and `endTimestamp` in human-readable `MM:SS` format for display in citations.

### Files to Create

`src/ingestion/chunker.ts`

### How to Verify


**Manual verification — do these yourself:**

1. Run the chunker on a real lesson and inspect the output:
   ```
   npx tsx -e "
   import { parseLessonFolder } from './src/ingestion/parser.js';
   import { chunkLesson } from './src/ingestion/chunker.js';
   const p = parseLessonFolder('./class_subtitle_lyst1784566935215/class-subtitle/module 1/01_what-is-mobile-development_epm');
   const chunks = chunkLesson(p.cues, p.moduleName, p.lessonName, p.lessonFolderPath);
   console.log('Total chunks:', chunks.length);
   console.log('---');
   chunks.forEach((c, i) => console.log('Chunk', i, '|', c.startTimestamp, '-', c.endTimestamp, '|', c.text.slice(0, 60) + '...'));
   "
   ```
   Check:
   - Each chunk's timestamp range makes sense (starts after previous ends, with some overlap)
   - Each chunk text is readable English (not broken mid-word)
   - Total chunks is reasonable for the lesson length (a 5-minute video should have ~6-7 chunks)

2. Verify overlap exists — look at the last few words of chunk 0 and the first few words of chunk 1. They should share some overlapping text.

3. Verify deterministic IDs — run the same command twice and confirm the chunk IDs are identical both times.

4. Try a longer lesson (e.g. from module 13):
   ```
   npx tsx -e "
   import { parseLessonFolder } from './src/ingestion/parser.js';
   import { chunkLesson } from './src/ingestion/chunker.js';
   const p = parseLessonFolder('./class_subtitle_lyst1784566935215/class-subtitle/module 13/chapter-3-implementing-google-oauth_epm');
   const chunks = chunkLesson(p.cues, p.moduleName, p.lessonName, p.lessonFolderPath);
   console.log('Total chunks:', chunks.length);
   console.log('First chunk ID:', chunks[0].id);
   console.log('Last chunk ends at:', chunks[chunks.length-1].endTimestamp);
   "
   ```
   Confirm the chunk count is higher for a longer lesson and the last timestamp represents the full video duration.


---

## Stage 3 — Data Ingestion: Embedder and Indexer

### What You Are Building

`src/ingestion/embedder.ts` — wraps `@xenova/transformers` to produce embedding vectors from text strings.

`src/ingestion/indexer.ts` — takes chunks, embeds them, and writes them to Qdrant as points. Also manages Qdrant collection creation.

`scripts/ingest.ts` — the runnable script that orchestrates the full ingestion: walks the subtitle directory, calls parser → chunker → embedder → indexer for every lesson, and reports progress.

### Why This Stage Exists

Qdrant cannot search text directly — it searches vectors. The embedder converts your chunk text into a 384-dimensional vector that encodes its semantic meaning. The indexer writes both the vector and the metadata payload to Qdrant. After this stage, your entire knowledge base is indexed and searchable.

### How the Embedder Works Internally

`@xenova/transformers` can run the `Xenova/all-MiniLM-L6-v2` model in Node.js without any GPU. You load the pipeline once using `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')`. For a given text, you call the pipeline and get back a tensor. You extract the mean pooled vector from the tensor — this collapses the per-token vectors into one vector that represents the whole text. You normalize this vector to unit length (divide each element by the L2 norm) before storing it, because Qdrant's cosine distance is equivalent to dot product on unit vectors, and normalization makes cosine comparison numerically stable.

The first time the embedder runs it downloads the model from Hugging Face (~90MB). Subsequent runs use the local cache. Expose a `loadModel()` function that initializes the pipeline and must be called once before embedding anything. This ensures the heavy initialization is explicit and done once, not on each call.

For batch embedding during ingestion, embed each chunk sequentially (not in parallel) to avoid memory pressure. The model processes text in under 50ms per chunk on a CPU, so 87 lessons with ~10 chunks each (roughly 870 chunks total) will take about a minute.

### How the Indexer Works Internally

Before inserting points, check whether the Qdrant collection exists. If not, create it with vector size 384 and distance metric `Cosine`. The collection name comes from your config.

Insert chunks in batches of 50 using Qdrant's upsert operation. Upserting means: if a point with that ID already exists, overwrite it; if not, insert it. This makes ingestion idempotent — you can safely re-run it if content changes.

The payload stored with each Qdrant point must include all fields from the chunk object: `text`, `moduleName`, `lessonName`, `startSeconds`, `endSeconds`, `startTimestamp`, `endTimestamp`, `lessonFolderPath`, `chunkIndex`. Never store just the ID and metadata while omitting the text — the text is needed later when assembling LLM context.

### How the Ingest Script Works

The script walks every module folder, then every lesson folder inside each module, calls `parseLessonFolder` to get cues + metadata, passes cues through `chunkLesson` to get chunks, batches the chunks, embeds them, and upserts them to Qdrant. Log progress clearly: `Processing: module 3 / Implementing Google OAuth... 8 chunks indexed`. At the end, print the total number of chunks indexed.

The script also builds and saves a BM25 index. After all chunks are collected, initialize a `wink-bm25-text-search` instance, add every chunk's text to it, call its `consolidate()` method (required by wink before searching), and serialize the index to a JSON file at `data/bm25-index.json`. The sparse retriever will load this file at API startup.

### Files to Create

`src/ingestion/embedder.ts`, `src/ingestion/indexer.ts`, `scripts/ingest.ts`

### How to Verify


**Manual verification — do these yourself:**

1. Run the full ingestion:
   ```
   npm run ingest
   ```
   Watch the logs. You should see lines like:
   ```
   Processing: module 1 / What Is Mobile Development... 6 chunks indexed
   Processing: module 1 / React Native Vs Expo... 8 chunks indexed
   ...
   Total chunks indexed: 870+
   ```

2. Open the Qdrant dashboard in your browser:
   ```
   http://localhost:6333/dashboard
   ```
   - Click on the `course_subtitles` collection
   - Confirm it shows 870–1000 points
   - Click on any random point and inspect its payload — it should contain `text`, `moduleName`, `lessonName`, `startTimestamp`, `endTimestamp`
   - Read the `text` field — it should be readable English course content

3. Verify the BM25 index was saved:
   ```
   ls -la data/bm25-index.json data/chunks-by-id.json
   ```
   Both files should exist and be non-empty (bm25-index will be several MB, chunks-by-id will be larger).

4. Test the embedder directly:
   ```
   npx tsx -e "
   import { loadModel, embed } from './src/ingestion/embedder.js';
   await loadModel();
   const vec = await embed('How do I set up navigation in Expo?');
   console.log('Vector length:', vec.length);
   console.log('First 5 values:', vec.slice(0, 5));
   console.log('Is normalized:', Math.abs(Math.sqrt(vec.reduce((s, v) => s + v*v, 0)) - 1) < 0.001);
   "
   ```
   Expect: Vector length = 384, values are small floats, "Is normalized: true"

5. Run ingestion a second time and confirm it finishes without errors (idempotent upsert — no duplicate errors).


---

## Stage 4 — Retrieval: Dense + Sparse + RRF

### What You Are Building

`src/retrieval/adapter.ts` — the TypeScript interface (type contract) that all retrievers must implement.

`src/retrieval/dense-retriever.ts` — queries Qdrant using vector similarity.

`src/retrieval/sparse-retriever.ts` — queries the BM25 index using keyword matching.

`src/retrieval/rrf.ts` — takes multiple ranked lists and fuses them into one using Reciprocal Rank Fusion.

### Why This Stage Exists

This is the core of the system. Without solid retrieval, every other stage is irrelevant — the guardrails and C-RAG cannot save you if retrieval fundamentally cannot find the right content. Get this stage right and the rest of the pipeline is refinement.

### How the Adapter Works

Define a TypeScript interface called `Retriever` with one method: `retrieve(query: string, topK: number): Promise<RetrievedChunk[]>`. Define the `RetrievedChunk` type with fields: `id`, `text`, `moduleName`, `lessonName`, `startTimestamp`, `endTimestamp`, `startSeconds`, `endSeconds`, `score`. Both retrievers implement this interface. The rest of the pipeline only ever types things as `Retriever`, never as the concrete implementations. This is the adapter pattern in practice.

### How Dense Retrieval Works Internally

The dense retriever embeds the incoming query using the same `embedder.ts` module used during ingestion — the exact same model and normalization. It then calls Qdrant's search endpoint with the query vector and asks for the top K results. Qdrant returns points ordered by cosine similarity score (1.0 = identical, 0.0 = unrelated). You map the results to `RetrievedChunk` objects, setting the `score` field to the Qdrant similarity score.

The dense retriever reads from a single Qdrant collection. It does not filter by module or lesson by default, though you can optionally pass a metadata filter if the query implies a specific module.

### How Sparse Retrieval Works Internally

The sparse retriever loads `data/bm25-index.json` from disk at initialization (once, at startup). `wink-bm25-text-search` requires you to tokenize your query before searching — split on whitespace, lowercase, and strip punctuation. Call the BM25 search method with your tokenized query and ask for top K results. BM25 returns results with a relevance score. Normalize these scores to the 0–1 range (divide each by the maximum score in the result set) before constructing `RetrievedChunk` objects, so scores are comparable with dense scores in the RRF step. The chunk IDs returned by BM25 must match the IDs stored in Qdrant — this is how you look up the full metadata after BM25 identifies the relevant chunk IDs.

Since BM25 only stores text and IDs in its index, you need a way to look up the full metadata for a chunk by ID. The simplest approach: during ingestion, also write a `data/chunks-by-id.json` file that maps each chunk ID to its full metadata object. The sparse retriever loads this file and uses it to reconstruct `RetrievedChunk` from BM25 results.

### How RRF Works Internally

RRF takes an array of ranked lists (each list is a `RetrievedChunk[]` already sorted by score descending). For each unique chunk ID across all lists, it computes a fused score by summing `1 / (60 + rank)` for every list where that chunk appears, where rank is 1-indexed position in that list. Chunks that do not appear in a given list contribute nothing to their RRF score for that list. After computing all fused scores, sort all unique chunks by RRF score descending and return the top K.

The key insight: a chunk that appears in position 3 in both the dense list and the BM25 list scores higher than a chunk that appears at position 1 in only one list. This rewards consistent relevance across strategies.

RRF is a pure function — it takes lists and returns a list. It has no side effects, no database calls. This makes it trivial to test and easy to reason about.

### Files to Create

`src/retrieval/adapter.ts`, `src/retrieval/dense-retriever.ts`, `src/retrieval/sparse-retriever.ts`, `src/retrieval/rrf.ts`

### How to Verify


**Manual verification — do these yourself:**

1. Test dense retrieval (semantic search):
   ```
   npx tsx -e "
   import { loadModel } from './src/ingestion/embedder.js';
   import { DenseRetriever } from './src/retrieval/dense-retriever.js';
   await loadModel();
   const retriever = new DenseRetriever();
   const results = await retriever.retrieve('how to set up navigation in expo', 5);
   results.forEach((r, i) => console.log(i+1, '|', r.moduleName, '>', r.lessonName, '|', r.startTimestamp, '-', r.endTimestamp, '| score:', r.score.toFixed(3)));
   "
   ```
   Check that results are from navigation/routing related lessons and scores are between 0 and 1.

2. Test sparse retrieval (keyword match):
   ```
   npx tsx -e "
   import { SparseRetriever } from './src/retrieval/sparse-retriever.js';
   const retriever = new SparseRetriever();
   await retriever.load();
   const results = await retriever.retrieve('OAuth', 5);
   results.forEach((r, i) => console.log(i+1, '|', r.moduleName, '>', r.lessonName, '|', r.text.slice(0, 80) + '...'));
   "
   ```
   Check that results contain chunks that literally mention "OAuth" in their text.

3. Test RRF fusion:
   ```
   npx tsx -e "
   import { loadModel } from './src/ingestion/embedder.js';
   import { DenseRetriever } from './src/retrieval/dense-retriever.js';
   import { SparseRetriever } from './src/retrieval/sparse-retriever.js';
   import { fuseRRF } from './src/retrieval/rrf.js';
   await loadModel();
   const dense = new DenseRetriever();
   const sparse = new SparseRetriever();
   await sparse.load();
   const denseResults = await dense.retrieve('google authentication setup', 10);
   const sparseResults = await sparse.retrieve('google authentication setup', 10);
   const fused = fuseRRF([denseResults, sparseResults], 10);
   console.log('Fused results:');
   fused.forEach((r, i) => console.log(i+1, '|', r.moduleName, '>', r.lessonName, '| score:', r.score.toFixed(4)));
   "
   ```
   Check that the fused list combines results from both retrievers, has no duplicates, and the top results are about authentication.


---

## Stage 5 — LLM Client: OpenRouter Wrapper

### What You Are Building

`src/llm/openrouter.ts` — a typed wrapper around the OpenRouter API that all LLM-dependent modules use. No other file should call the OpenRouter API directly.

### Why This Stage Exists

Multiple stages call LLMs — query transformation, guardrails, C-RAG grading, and final generation. Each of these uses a different model (cheap vs capable) and different prompt styles. Centralizing all OpenRouter communication in one module means: you handle retries and rate limit errors in one place, you log all LLM calls in one place, and you can swap models or providers by changing one file.

### How It Works Internally

The wrapper exposes a single primary function: `chat(messages, options)`. The `messages` parameter is an array of `{role, content}` objects following the OpenAI chat format. The `options` parameter accepts `model` (defaults to the value in config), `temperature`, and `maxTokens`.

OpenRouter's API is compatible with OpenAI's format — the only differences are the base URL (`https://openrouter.ai/api/v1`) and two optional headers: `HTTP-Referer` (your app's URL, helps OpenRouter identify traffic) and `X-Title` (your app name). Use the `openai` npm package but point it at OpenRouter's base URL using the `baseURL` option. This saves you from writing raw fetch calls.

Retry logic: if OpenRouter returns a 429 (rate limit) or 503 (overloaded), wait and retry up to 3 times with exponential backoff (wait 1s, then 2s, then 4s). If all retries fail, throw a typed error that the caller can handle gracefully.

Expose two pre-configured model shortcuts from this module: `cheapModel` (Gemini Flash 1.5, used for grading and classification) and `smartModel` (Gemini 2.0 Flash, used for final answer generation and query transformation). The caller passes one of these strings. This prevents different modules from having model name strings scattered throughout the codebase.

Also expose a `countApproximateTokens(text)` helper that estimates token count as `Math.ceil(text.length / 4)`. This is a rough estimate (real tokenizers are more precise) but good enough for checking whether a context window is getting too large before making an expensive API call.

### Files to Create

`src/llm/openrouter.ts`

### How to Verify


**Manual verification — do these yourself:**

1. Make sure your `.env` has a valid `OPENROUTER_API_KEY`. Then test a basic call:
   ```
   npx tsx -e "
   import { chat, cheapModel, smartModel } from './src/llm/openrouter.js';
   console.log('Cheap model:', cheapModel);
   console.log('Smart model:', smartModel);
   const response = await chat([{role: 'user', content: 'Reply with only the word: hello'}], { model: cheapModel });
   console.log('Response:', response);
   "
   ```
   Expect: the response should contain "hello" (or "Hello"). If you get an auth error, your API key is wrong. If you get a model error, the model name is not supported on OpenRouter.

2. Test the smart model:
   ```
   npx tsx -e "
   import { chat, smartModel } from './src/llm/openrouter.js';
   const response = await chat([{role: 'user', content: 'What is 2+2? Reply with just the number.'}], { model: smartModel });
   console.log('Response:', response);
   "
   ```
   Expect: "4"

3. If either call fails with a model error, check `https://openrouter.ai/models` for currently available model IDs and update your `.env` file.


---

## Stage 6 — Query Transformation

### What You Are Building

`src/query/rewriter.ts` — rephrases the user's query for better vector search.

`src/query/step-back.ts` — generates a broader conceptual question from the original query.

`src/query/sub-questions.ts` — decomposes a complex query into simpler sub-questions.

### Why This Stage Exists

The way users naturally phrase questions is often a poor match for how information is stored in the index. "That thing about navigation" retrieves nothing. "File-based routing configuration in Expo Router" retrieves the right lessons. These three modules transform one raw query into multiple higher-quality queries before retrieval runs, dramatically improving recall. Building this after retrieval is intentional — you can test each transformation by manually checking whether the rewritten queries produce better retrieval results than the original.

### How Query Rewriting Works Internally

Send the original query to the LLM using the cheap model. The prompt provides the query, states that it will be used to search a vector database of Udemy course transcripts about React Native and Expo, and asks the LLM to rewrite it into a clear, specific, jargon-appropriate search string without answering the question. The output must be only the rewritten query text — no explanation, no prefix like "Rewritten query:", just the query itself.

Edge case: if the rewriter returns more than 200 characters, truncate to 200. Overly long rewrites dilute retrieval focus.

### How Step-Back Prompting Works Internally

Send the query to the LLM and ask: "What is the broader concept or general principle behind this specific question?" Provide context that the answer will be used to retrieve background information from a React Native and Expo course. The LLM returns one broader question. For "Why does my FlatList re-render on every state change?" the step-back might be "What causes unnecessary re-renders in React Native and how are they prevented?"

Return only the broader question as a plain string. If the model wraps it in explanation, strip everything and keep just the question sentence (ends with `?`).

### How Sub-Question Decomposition Works Internally

Send the query to the LLM and ask it to break the question into a list of simpler, independent questions that each address one part of the original. Ask it to return a JSON array of strings and nothing else. If the original query is already simple and cannot be decomposed, the model should return an array containing only the original question unchanged. Parse the JSON response. If JSON parsing fails (the model returned prose instead), fall back to returning the original query as a single-item array — never let a parse failure crash the pipeline.

### How All Three Work Together in the Pipeline

All three transformations run concurrently using `Promise.all` — they are independent and do not depend on each other's output. After all three finish, you collect: the rewritten query (1 string), the step-back query (1 string), and the sub-questions (N strings). Deduplicate this combined list — if the step-back or a sub-question is identical to the rewritten query, keep only one copy. The final list of unique transformed queries is what goes to the retrieval stage.

### Files to Create

`src/query/rewriter.ts`, `src/query/step-back.ts`, `src/query/sub-questions.ts`

### How to Verify


**Manual verification — do these yourself (needs API key):**

1. Test query rewriting with a real LLM call:
   ```
   npx tsx -e "
   import { rewriteQuery } from './src/query/rewriter.js';
   const result = await rewriteQuery('that thing about navigation between screens');
   console.log('Original: that thing about navigation between screens');
   console.log('Rewritten:', result);
   "
   ```
   Expect: a clearer, more specific query like "screen navigation configuration in Expo Router React Native"

2. Test step-back prompting:
   ```
   npx tsx -e "
   import { stepBack } from './src/query/step-back.js';
   const result = await stepBack('Why does my FlatList re-render on every state change?');
   console.log('Original: Why does my FlatList re-render on every state change?');
   console.log('Step-back:', result);
   "
   ```
   Expect: a broader question about React Native rendering or performance patterns.

3. Test sub-question decomposition:
   ```
   npx tsx -e "
   import { decomposeQuery } from './src/query/sub-questions.js';
   const result = await decomposeQuery('How do I set up Google OAuth and protected routes in Expo?');
   console.log('Original: How do I set up Google OAuth and protected routes in Expo?');
   console.log('Sub-questions:', result);
   "
   ```
   Expect: an array with 2-3 simpler questions like ["How to configure Google OAuth in Expo", "How to set up protected routes in Expo Router"]


---

## Stage 7 — Input Guardrails and PII Detection

### What You Are Building

`src/guardrails/pii-detector.ts` — scans a text string for personal identifiable information and masks or flags it.

`src/guardrails/input-validator.ts` — decides whether a query is safe, on-topic, and properly formed before the pipeline does any work.

### Why This Stage Exists

This is the first thing that runs when a query arrives. It is the cheapest stage to run and the most important for protecting the system. Without it, users can accidentally leak personal information into your LLM prompts and logs, ask completely off-topic questions that waste compute, or submit malformed input that causes downstream errors. Building it now, after the core retrieval and transformation stages are proven, means you can wire it in cleanly as a gate at the very front of the pipeline.

### How PII Detection Works Internally

PII detection runs entirely without LLM calls — it uses regular expressions. Define patterns for the most common PII types: email addresses (the pattern `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`), phone numbers (sequences of 10–13 digits optionally separated by spaces, dashes, or parentheses), and Indian Aadhaar or PAN card numbers if relevant to your expected user base.

The function takes a text string and returns two things: a `hasPii` boolean and a `masked` string where detected PII is replaced with a placeholder like `[EMAIL]` or `[PHONE]`. The pipeline uses the `masked` version for all downstream processing if PII was found, and optionally logs a warning without logging the actual PII value.

Do not try to detect names or addresses with regex — those require NLP and are out of scope. Stick to high-confidence structural patterns (email, phone) that are unambiguous.

### How Input Validation Works Internally

The input validator runs three checks in sequence, stopping immediately if any check fails:

**Length check** runs first because it requires no computation. If the query is empty, return a rejection. If it exceeds 500 characters, return a rejection asking the user to be more concise. This prevents absurdly long inputs from being processed.

**PII check** runs second, calling the PII detector. If PII is found, you have two options depending on severity. For emails and phones, you can allow the query to proceed but use the masked version. For anything that looks like a credential or sensitive identifier, reject the query.

**Topic relevance check** runs last and is the only one that needs an LLM call. Send the (possibly masked) query to OpenRouter with the cheap model. The prompt is tightly constrained: it states the system is a QA tool for a React Native and Expo development course, provides the query, and asks for a JSON response with two fields — `relevant` (boolean) and `reason` (one sentence). Parse the JSON. If `relevant` is false, return a rejection that includes the reason so the user understands why their question was refused. If JSON parsing fails, default to allowing the query through — it is better to process an ambiguous query than to incorrectly block a legitimate one.

The validator returns a typed result object. On success: `{ passed: true, processedQuery: string }`. On failure: `{ passed: false, reason: string }`. The pipeline checks `passed` immediately and short-circuits if false.

### Files to Create

`src/guardrails/pii-detector.ts`, `src/guardrails/input-validator.ts`

### How to Verify


**Manual verification — do these yourself:**

1. Test PII detection:
   ```
   npx tsx -e "
   import { detectPii } from './src/guardrails/pii-detector.js';
   console.log(detectPii('my email is user@example.com and phone is 9876543210'));
   console.log(detectPii('how do I set up navigation in expo?'));
   "
   ```
   First call: `hasPii: true`, masked text with `[EMAIL]` and `[PHONE]`
   Second call: `hasPii: false`, text unchanged

2. Test input validator with a real LLM (needs API key):
   ```
   npx tsx -e "
   import { validateInput } from './src/guardrails/input-validator.js';
   const r1 = await validateInput('How do I set up navigation in Expo?');
   console.log('On-topic query:', r1);
   const r2 = await validateInput('What is the best pizza recipe?');
   console.log('Off-topic query:', r2);
   const r3 = await validateInput('');
   console.log('Empty query:', r3);
   "
   ```
   Expect:
   - On-topic: `{ passed: true, processedQuery: "How do I set up navigation in Expo?" }`
   - Off-topic: `{ passed: false, reason: "..." }` with some explanation
   - Empty: `{ passed: false, reason: "..." }` without making an LLM call


---

## Stage 8 — Corrective RAG (C-RAG)

### What You Are Building

`src/crag/grader.ts` — grades each retrieved chunk as RELEVANT, IRRELEVANT, or AMBIGUOUS with respect to the query.

`src/crag/corrective-loop.ts` — orchestrates the retry logic: runs retrieval, grades results, and loops up to 3 times if quality is poor.

### Why This Stage Exists

Without C-RAG, your system generates an answer from whatever retrieval returns — even if the retrieved content has nothing to do with the question. The result is a confident-sounding hallucination. C-RAG adds a quality gate between retrieval and generation: check if what you retrieved is actually useful, and if not, try again with a different query formulation. This is the difference between a trustworthy tool and a misleading one.

### How the Grader Works Internally

The grader takes one retrieved chunk and the original user query. It sends both to the LLM using the cheap model with a prompt that presents the chunk text and asks: "Does this passage help answer the following question? Answer with exactly one word: RELEVANT, IRRELEVANT, or AMBIGUOUS." Extract the first word from the response, normalize to uppercase, and return it as the grade.

You run the grader on all top-K chunks in parallel using `Promise.all` — this is safe here because each grading call is independent and you want to minimize latency. With 10 chunks to grade on the cheap model, parallel calls are faster than sequential and unlikely to hit rate limits.

After all chunks are graded, count the distribution. If 5 or more of the top 10 chunks are RELEVANT, the retrieval is good — return the graded chunks to the caller. If fewer than 5 are RELEVANT, retrieval quality is poor and the corrective loop must retry.

AMBIGUOUS chunks are kept but flagged. In the generation stage, they are included in the context only after all RELEVANT chunks, and the generator is told these are secondary context.

### How the Corrective Loop Works Internally

The corrective loop receives the original user query and the retrieval function. It tracks an attempt counter starting at 1.

On each attempt: call retrieval with the current query formulation, grade the results, check the distribution. If quality is sufficient, return the graded chunks and exit the loop. If quality is poor and the attempt counter is less than 3, increment the counter and generate a new query formulation.

The re-query strategy gets more aggressive on each attempt. On attempt 2, broaden the query — ask the LLM to make it more general, removing specific constraints or jargon. On attempt 3, narrow the query — ask the LLM to focus on the most essential single concept in the question, stripping everything else. These are different strategies: broadening helps when the question was too specific for the index; narrowing helps when the question was too vague or multi-part.

If the loop exhausts all 3 attempts without passing the quality threshold, it returns a `{ exhausted: true }` result. The pipeline interprets this as a definitive "answer not found in course content" and returns a polite fallback message to the user. Never attempt generation on exhausted results — there is no useful content to generate from.

### Files to Create

`src/crag/grader.ts`, `src/crag/corrective-loop.ts`

### How to Verify


**Manual verification — do these yourself (needs API key + ingested data):**

1. Test the grader on a relevant chunk:
   ```
   npx tsx -e "
   import { loadModel } from './src/ingestion/embedder.js';
   import { DenseRetriever } from './src/retrieval/dense-retriever.js';
   import { gradeChunk } from './src/crag/grader.js';
   await loadModel();
   const retriever = new DenseRetriever();
   const results = await retriever.retrieve('What is OAuth 2.0?', 3);
   for (const chunk of results) {
     const grade = await gradeChunk(chunk, 'What is OAuth 2.0?');
     console.log(grade, '|', chunk.lessonName, '|', chunk.text.slice(0, 50) + '...');
   }
   "
   ```
   Expect: most chunks should be graded RELEVANT since they match the query topic.

2. Test the grader on an irrelevant match:
   ```
   npx tsx -e "
   import { loadModel } from './src/ingestion/embedder.js';
   import { DenseRetriever } from './src/retrieval/dense-retriever.js';
   import { gradeChunk } from './src/crag/grader.js';
   await loadModel();
   const retriever = new DenseRetriever();
   const results = await retriever.retrieve('What is OAuth 2.0?', 10);
   const lastChunk = results[results.length - 1];
   const grade = await gradeChunk(lastChunk, 'How to cook pasta?');
   console.log('Grade for unrelated query:', grade);
   "
   ```
   Expect: IRRELEVANT (the chunk is about OAuth, but the question is about cooking)

3. Test the corrective loop end-to-end:
   ```
   npx tsx -e "
   import { loadModel } from './src/ingestion/embedder.js';
   import { runCorrectiveLoop } from './src/crag/corrective-loop.js';
   await loadModel();
   const result = await runCorrectiveLoop('How do I configure Expo Router for navigation?');
   console.log('Exhausted:', result.exhausted ?? false);
   console.log('Chunks returned:', result.chunks?.length ?? 0);
   if (result.chunks) result.chunks.slice(0, 3).forEach(c => console.log('-', c.grade, '|', c.lessonName));
   "
   ```
   Expect: `exhausted: false`, chunks returned > 0, most graded RELEVANT.


---

## Stage 9 — Response Generation and Formatting

### What You Are Building

`src/generation/generator.ts` — assembles context from graded chunks and calls OpenRouter to produce the final answer.

`src/generation/formatter.ts` — takes the raw LLM answer and the source chunks and produces a structured response with clean, human-readable citations.

### Why This Stage Exists

This is the payoff of the whole pipeline. Every previous stage exists to ensure that by the time you reach here, you have high-quality, relevant content to give the LLM. The generator's job is to use that content faithfully and produce a useful answer. The formatter's job is to make the citations actionable — the student should be able to read a reference and immediately know where in the video to seek.

### How the Generator Works Internally

Context assembly happens before the LLM call. Take all RELEVANT chunks first, ordered by their RRF score descending. Then append AMBIGUOUS chunks. For each chunk, format it as a labeled block: the label is `[Source: Module X > Lesson Name | Timestamp: MM:SS - MM:SS]` followed by the chunk text. This labeling is critical — the LLM sees exactly which lesson each piece of content came from, which enables it to generate accurate citations.

Before making the LLM call, check the approximate token count of the assembled context using `countApproximateTokens`. If it exceeds 6000 tokens, remove AMBIGUOUS chunks first. If it still exceeds 6000 tokens after removing all AMBIGUOUS chunks, trim the lowest-scored RELEVANT chunks until it fits. You want to stay well within the model's context limit to leave room for the system prompt and the generated answer.

The system prompt tells the LLM: it is a course assistant for a React Native and Expo development course, it must answer using only the provided source passages, it must cite which specific lesson and timestamp it drew each piece of information from, and it must not invent or assume anything not present in the sources. If the sources do not contain enough information to answer the question, it must say so plainly rather than guessing.

Use the smart model (not the cheap model) for this call — answer quality matters here more than cost.

### How the Formatter Works Internally

The formatter receives two things: the raw text response from the LLM and the array of source chunks that were included in the context. It produces a final response object with three fields: `answer` (the LLM's text), `sources` (a structured array of citation objects), and `totalChunksUsed` (a count for debugging).

Each citation object contains: `moduleName`, `lessonName`, `startTimestamp`, `endTimestamp`, and a combined `reference` string in the format `Module X > Lesson Name — [MM:SS - MM:SS]`.

Group citations by lesson: if multiple chunks from the same lesson were used, produce one citation entry for that lesson with the earliest start timestamp and latest end timestamp of all its chunks. This is cleaner than repeating the same lesson name multiple times.

Sort citations by module number ascending, then by start timestamp ascending within each module.

The final output that reaches the student looks like:

```
Answer: [the LLM's explanation]

Sources:
- Module 3 > Implementing Google OAuth — [02:15 - 06:40]
- Module 13 > Auth Flow and Protected Routes — [00:30 - 03:15]
```

### Files to Create

`src/generation/generator.ts`, `src/generation/formatter.ts`

### How to Verify


**Manual verification — do these yourself (needs API key + ingested data):**

1. Test the full generation flow on a real question:
   ```
   npx tsx -e "
   import { loadModel } from './src/ingestion/embedder.js';
   import { DenseRetriever } from './src/retrieval/dense-retriever.js';
   import { generate } from './src/generation/generator.js';
   import { formatResponse } from './src/generation/formatter.js';
   await loadModel();
   const retriever = new DenseRetriever();
   const chunks = await retriever.retrieve('What is mobile development?', 5);
   const gradedChunks = chunks.map(c => ({ ...c, grade: 'RELEVANT' }));
   const rawAnswer = await generate('What is mobile development?', gradedChunks);
   console.log('--- RAW ANSWER ---');
   console.log(rawAnswer);
   const formatted = formatResponse(rawAnswer, gradedChunks);
   console.log('--- FORMATTED ---');
   console.log(JSON.stringify(formatted, null, 2));
   "
   ```
   Check:
   - The answer is about mobile development and reads naturally
   - The `sources` array has citation entries with module name, lesson name, and timestamps
   - Citations are grouped by lesson (no duplicates for same lesson)
   - Timestamps are in `MM:SS` format


---

## Stage 10 — Pipeline Orchestration

### What You Are Building

`src/pipeline.ts` — the single function that chains all stages together in the correct order. This is the only file that knows the full sequence. Every other module is unaware of what runs before or after it.

### Why This Stage Exists

Without an orchestration layer, your API server would contain the pipeline logic directly — a tangled mess of imports and control flow inside a route handler. Extracting the pipeline into its own module means: you can test the full query flow without running an HTTP server, you can add logging or instrumentation in one place, and the API route becomes a thin wrapper that just calls `runPipeline(query)` and returns the result.

### How It Works Internally

The pipeline function receives one argument: the raw user query string. It runs stages in this exact order:

First, call the input validator. If `passed` is false, immediately return a response object with `type: "rejected"` and the reason. No further stages run.

Second, take the `processedQuery` from the validator result (the PII-masked version) and run the three query transformations concurrently. Collect the full list of unique transformed queries.

Third, for each transformed query, run both the dense retriever and sparse retriever concurrently. Collect all the result lists.

Fourth, pass all result lists to RRF and get the unified top-K ranked list.

Fifth, pass the ranked list and the original query to the corrective loop. If the loop returns `{ exhausted: true }`, return a response object with `type: "not-found"` and a friendly message.

Sixth, pass the graded chunks to the generator to produce the raw answer. Pass the raw answer and source chunks to the formatter to produce the final structured response.

Return a response object with `type: "answer"`, `answer` (the text), and `sources` (the citation array).

The pipeline function must not throw. Wrap the entire body in a try-catch. If any unhandled error occurs, log it with enough detail to debug, and return a response object with `type: "error"` and a generic user-facing message. Users should never see a raw stack trace.

### Files to Create

`src/pipeline.ts`

### How to Verify


**Manual verification — do these yourself (needs API key + ingested data):**

1. Test the full pipeline end-to-end:
   ```
   npx tsx -e "
   import { runPipeline } from './src/pipeline.js';
   const result = await runPipeline('How do I set up navigation in Expo?');
   console.log('Type:', result.type);
   console.log('Answer:', result.answer?.slice(0, 200) + '...');
   console.log('Sources:');
   result.sources?.forEach(s => console.log(' -', s.reference));
   "
   ```
   Expect: `type: "answer"`, a coherent answer about navigation, and sources citing relevant lessons.

2. Test rejection (off-topic):
   ```
   npx tsx -e "
   import { runPipeline } from './src/pipeline.js';
   const result = await runPipeline('What is the best pizza recipe?');
   console.log('Type:', result.type);
   console.log('Reason:', result.reason);
   "
   ```
   Expect: `type: "rejected"` with a reason about it being off-topic.

3. Test error handling:
   ```
   npx tsx -e "
   import { runPipeline } from './src/pipeline.js';
   const result = await runPipeline('');
   console.log('Type:', result.type);
   console.log('Reason:', result.reason);
   "
   ```
   Expect: `type: "rejected"` (empty query caught by guardrails) — no crash or stack trace.


---

## Stage 11 — API Server

### What You Are Building

`api/server.ts` — a Fastify HTTP server that exposes one endpoint for querying the pipeline and manages server startup safely.

### Why This Stage Exists

The pipeline is a library function — it has no way to receive queries from the outside world. The API server is the interface between students and the pipeline. Fastify is chosen over Express because it has built-in TypeScript support, request schema validation, and significantly better performance under load.

### How It Works Internally

On startup, before binding to any port, the server must initialize three things: load the BM25 index from `data/bm25-index.json` into the sparse retriever, load the embedding model using `loadModel()`, and verify Qdrant is reachable by hitting its health endpoint. If any of these fail, the server must exit with a non-zero code and a clear error message rather than starting in a broken state.

Define one route: `POST /api/query`. The request body must be a JSON object with a `query` string field. Use Fastify's schema validation to enforce this — if the body is missing or malformed, Fastify returns a 400 automatically without your code running at all. The route handler calls `runPipeline(body.query)` and returns the result as JSON. The HTTP status code is always 200 for the response — use the `type` field in the response body to signal success vs rejection vs not-found vs error. This keeps the API simple: callers only need to check one place to understand the result.

Also define `GET /health` which returns `{ status: "ok", qdrantConnected: boolean, modelLoaded: boolean }`. This lets you verify the server is fully ready without making a real query.

Configure Fastify with a request timeout of 30 seconds. A full pipeline run including LLM calls can take 5–10 seconds under normal conditions, but you want a hard ceiling to prevent slow requests from blocking server resources indefinitely.

Add a graceful shutdown handler. When the server receives SIGTERM or SIGINT, it stops accepting new requests, waits for in-flight requests to complete (up to 10 seconds), and then exits. This is important when running in Docker — container orchestrators send SIGTERM before force-killing, and you want clean shutdown rather than abrupt termination mid-request.

### Files to Create

`api/server.ts`

### How to Verify

Add an npm script `"start": "npx tsx api/server.ts"` to `package.json`. Run it. The startup logs should show: BM25 index loaded, embedding model loaded, Qdrant connected, and `Server listening on port 3000`.

Then run these manual curl tests in a terminal:

```
curl http://localhost:3000/health
```
Should return `{ "status": "ok", "qdrantConnected": true, "modelLoaded": true }`.

```
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "How do I set up navigation in Expo?"}'
```
Should return a JSON response with `type: "answer"`, a non-empty `answer` string, and at least one entry in the `sources` array with a lesson name and timestamp.

```
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{"query": "What is the best pizza recipe?"}'
```
Should return `type: "rejected"` since this is off-topic.

```
curl -X POST http://localhost:3000/api/query \
  -H "Content-Type: application/json" \
  -d '{}'
```
Should return HTTP 400 from Fastify's schema validation — no route handler code runs at all.


---

## Stage 12 — End-to-End Verification

### What You Are Doing

No new files. This stage is about running the full system from raw data to final answer and confirming every moving part is working together correctly.

### Why This Stage Exists

Unit tests verify individual modules in isolation with mocked dependencies. End-to-end verification tests the real system with real data, real embeddings, real LLM calls, and real Qdrant queries. Bugs that only appear when real components interact — wrong data shapes crossing module boundaries, schema mismatches in Qdrant responses, LLM output that does not match the expected format — only surface here.

### The Verification Sequence

First, confirm the infrastructure is clean. Run `docker compose down -v` to destroy all volumes, then `docker compose up -d` to start fresh. This ensures you are testing ingestion from scratch, not relying on previously indexed data.

Second, run ingestion. After it completes, note the total chunk count printed in the logs. Open `http://localhost:6333/dashboard`, navigate to your collection, and spot-check 5 random points. Verify each one has: a non-empty `text` field that reads like real spoken English, a `moduleName` that matches one of your module folder names, a `lessonName` that looks like a human-readable title, and numeric `startSeconds`/`endSeconds` values that make sense.

Third, start the API server and run these end-to-end query scenarios:

**Scenario 1 — Specific concept:** Ask `"How do I use useLocalSearchParams in Expo Router?"`. This query contains an exact function name. The BM25 retriever should find it reliably. Verify the answer explains the hook and the source citation points to a lesson in a navigation-related module.

**Scenario 2 — Conceptual question:** Ask `"What is the difference between React Native and Expo?"`. This is a vague semantic question with no exact keyword match. The dense retriever must carry this one. Verify the answer covers both technologies and the source points to module 1 where this comparison is introduced.

**Scenario 3 — Multi-part question:** Ask `"How do I add Google authentication and set up protected routes in Expo?"`. This should trigger sub-question decomposition into separate auth and routing questions. Verify the answer covers both topics and cites lessons from both the auth module and the routing/navigation module.

**Scenario 4 — Off-topic rejection:** Ask `"What is the capital of France?"`. Verify the response has `type: "rejected"` and the reason message is intelligible.

**Scenario 5 — Not-found scenario:** Ask something that is genuinely not in the course, such as `"How do I configure Next.js middleware?"`. Verify the response has `type: "not-found"` or falls back gracefully rather than hallucinating an answer about Next.js from Expo content.

### What a Passing End-to-End Result Looks Like

For Scenarios 1–3, the answer should be coherent and accurate relative to the course content. Sources should list recognizable lesson names with timestamps in `MM:SS` format. The module numbers in citations should be plausible for the topic (authentication in module 13, navigation in module 3–4, intro comparisons in module 1).

For Scenarios 4–5, no hallucinated answer, no crash, no stack trace — just a clean response object with the right `type` field.

If any scenario fails, trace back through the stage that owns that failure and fix it before considering the project complete.

---

## Quick Reference: Build Order and Verification

| Stage | Files Created | Manual Verification |
|-------|--------------|---------------------|
| 0 | `package.json`, `tsconfig.json`, `docker-compose.yml`, `.env.example`, `src/config.ts` | `curl http://localhost:6333/healthz` + `npx tsx src/config.ts` |
| 1 | `src/ingestion/parser.ts` | Run `parseLessonFolder` on a real folder, inspect output |
| 2 | `src/ingestion/chunker.ts` | Run chunker on a lesson, check timestamps and overlap |
| 3 | `src/ingestion/embedder.ts`, `indexer.ts`, `scripts/ingest.ts` | `npm run ingest` then open Qdrant dashboard |
| 4 | `src/retrieval/adapter.ts`, `dense-retriever.ts`, `sparse-retriever.ts`, `rrf.ts` | Query dense + sparse manually, check result relevance |
| 5 | `src/llm/openrouter.ts` | Call `chat()` with "hello" prompt, confirm response |
| 6 | `src/query/rewriter.ts`, `step-back.ts`, `sub-questions.ts` | Run each transformer on a real query, read output |
| 7 | `src/guardrails/pii-detector.ts`, `input-validator.ts` | Test PII masking + on/off topic check |
| 8 | `src/crag/grader.ts`, `corrective-loop.ts` | Grade a real chunk, run corrective loop on a real query |
| 9 | `src/generation/generator.ts`, `formatter.ts` | Generate answer for a real query, inspect citations |
| 10 | `src/pipeline.ts` | `runPipeline("question")` from terminal |
| 11 | `api/server.ts` | `curl` the API endpoints |
| 12 | — | Full scenario queries via curl |

---

## One Rule to Follow Throughout

Complete every stage's verification before starting the next stage. It is tempting to skip ahead and wire things together early. Resist it. A parser bug caught in Stage 1 takes 5 minutes to fix. The same bug discovered in Stage 12 takes an hour to trace back through the call chain. The verification steps exist precisely to catch problems at the earliest possible point.
