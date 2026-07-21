# Advanced RAG — Course Subtitle Q&A System

An Advanced Retrieval-Augmented Generation system that lets students ask natural language questions about a Udemy course and get precise answers with lesson name + timestamp citations.

## What It Does

- Ingests SRT/VTT subtitle files from a course (87 lessons across 17 modules)
- Chunks transcripts into searchable segments with timestamps
- Answers student questions by finding relevant lecture segments
- Returns the answer + exact lesson and timestamp to revisit

## Architecture

```
User Query → Guardrails → Query Transformation → Hybrid Retrieval (Dense + BM25 + RRF) → C-RAG → Answer Generation
```

Key pipeline stages:
- **Input Guardrails** — PII detection, topic relevance, content safety
- **Query Transformation** — step-back prompting, sub-questions, rewriting
- **Hybrid Retrieval** — semantic (Qdrant) + keyword (BM25) search, fused with Reciprocal Rank Fusion
- **Corrective RAG** — grades relevance of retrieved chunks, retries up to 3x if quality is poor
- **Response Generation** — LLM answer with lesson + timestamp citations

## Prerequisites

- **Node.js** 20+
- **Docker** (for Qdrant and Redis)
- **OpenRouter API key** — get one at [openrouter.ai](https://openrouter.ai)

## Quick Start

### 1. Clone the repo

```bash
git clone git@github.com:parimalSavaj/Advanced-RAG.git
cd Advanced-RAG
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` and add your OpenRouter API key:

```
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

### 4. Start infrastructure (Qdrant + Redis)

```bash
docker compose up -d
```

Verify:
```bash
curl http://localhost:6333/healthz
# Expected: healthz check passed
```

### 5. Add your subtitle data

Place your course subtitle files in:
```
class_subtitle_lyst1784566935215/class-subtitle/
```

Expected structure:
```
class-subtitle/
├── module 1/
│   ├── 01_lesson-name_epm/
│   │   ├── 01_lesson-name_epm.vtt
│   │   └── 01_lesson-name_epm.srt
│   ...
├── module 2/
...
```

### 6. Run ingestion

```bash
npm run ingest
```

This parses all subtitle files, chunks them, generates embeddings (locally via `all-MiniLM-L6-v2`), and indexes everything into Qdrant. Also builds the BM25 keyword index.

First run downloads the embedding model (~90MB) from Hugging Face. Subsequent runs use the local cache.

### 7. Start the API server

```bash
npm run start
```

Server starts at `http://localhost:3000`.

### 8. Query the system

```bash
curl -X POST http://localhost:3000/api/query \
  -H 'Content-Type: application/json' \
  --data-raw '{"query":"What is the difference between React Native and Expo?"}'
```

Response:
```json
{
  "type": "answer",
  "answer": "React Native is the core framework...",
  "sources": [
    {
      "moduleName": "module 1",
      "lessonName": "React Native Vs Expo",
      "startTimestamp": "00:00",
      "endTimestamp": "11:03",
      "reference": "Module 1 > React Native Vs Expo — [00:00 - 11:03]"
    }
  ]
}
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server readiness check |
| POST | `/api/query` | Ask a question (body: `{ "query": "..." }`) |

### Response Types

| `type` | Meaning |
|--------|---------|
| `answer` | Successful answer with sources |
| `rejected` | Query was off-topic or contained PII |
| `not-found` | Relevant content not found in course material |
| `error` | Internal server error |

## Project Structure

```
├── api/server.ts              # Fastify HTTP server
├── scripts/ingest.ts          # Data ingestion script
├── src/
│   ├── config.ts              # Environment config (zod validated)
│   ├── pipeline.ts            # Main orchestration
│   ├── ingestion/
│   │   ├── parser.ts          # VTT/SRT file parser
│   │   ├── chunker.ts         # Time-window chunker
│   │   ├── embedder.ts        # Local embedding (Xenova/transformers)
│   │   └── indexer.ts         # Qdrant indexer
│   ├── retrieval/
│   │   ├── adapter.ts         # Retriever interface
│   │   ├── dense-retriever.ts # Qdrant vector search
│   │   ├── sparse-retriever.ts# BM25 keyword search
│   │   └── rrf.ts             # Reciprocal Rank Fusion
│   ├── llm/
│   │   └── openrouter.ts      # OpenRouter API wrapper
│   ├── query/
│   │   ├── rewriter.ts        # Query rewriting
│   │   ├── step-back.ts       # Step-back prompting
│   │   └── sub-questions.ts   # Sub-question decomposition
│   ├── guardrails/
│   │   ├── pii-detector.ts    # PII detection & masking
│   │   └── input-validator.ts # Topic relevance + safety
│   ├── crag/
│   │   ├── grader.ts          # Chunk relevance grading
│   │   └── corrective-loop.ts # Retry loop (max 3)
│   └── generation/
│       ├── generator.ts       # LLM answer generation
│       └── formatter.ts       # Citation formatting
├── data/                      # Generated indices (after ingestion)
│   ├── bm25-index.json
│   └── chunks-by-id.json
├── docker-compose.yml         # Qdrant + Redis
├── .env.example               # Environment template
└── doc/
    ├── GUIDE.md               # High-level project guide
    └── DEEP_DIVE.md           # Stage-by-stage build documentation
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key | (required) |
| `OPENROUTER_MODEL` | Cheap model for grading/classification | `google/gemini-2.5-flash` |
| `OPENROUTER_SMART_MODEL` | Better model for answer generation | `openai/gpt-4o-mini` |
| `EMBEDDING_MODEL` | Local embedding model | `Xenova/all-MiniLM-L6-v2` |
| `QDRANT_URL` | Qdrant server URL | `http://localhost:6333` |
| `QDRANT_COLLECTION` | Qdrant collection name | `course_subtitles` |
| `REDIS_URL` | Redis URL (for caching) | `redis://localhost:6379` |
| `SUBTITLE_DATA_PATH` | Path to subtitle files | `./class_subtitle_lyst1784566935215/class-subtitle` |
| `CHUNK_DURATION_SECONDS` | Chunk time window | `45` |
| `OVERLAP_SECONDS` | Overlap between chunks | `8` |
| `MAX_CRAG_RETRIES` | Max C-RAG correction attempts | `3` |
| `TOP_K_RESULTS` | Number of results per retrieval | `10` |
| `PORT` | API server port | `3000` |

## Scripts

```bash
npm run ingest   # Parse, chunk, embed, and index all subtitle files
npm run start    # Start the API server
npm run dev      # Start with auto-reload (development)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js |
| LLM | OpenRouter (Gemini Flash + GPT-4o-mini) |
| Embeddings | `@xenova/transformers` (local, free) |
| Vector DB | Qdrant (Docker) |
| Keyword Search | wink-bm25-text-search |
| API | Fastify |
| Cache | Redis (Docker) |

## Troubleshooting

**"OPENROUTER_API_KEY is required"**
→ Copy `.env.example` to `.env` and add your key.

**Qdrant not reachable**
→ Run `docker compose up -d` and verify with `curl http://localhost:6333/healthz`.

**Embedding model download slow**
→ First run downloads ~90MB. Wait for it to finish. Cached after that.

**All queries return "not-found"**
→ Run `npm run ingest` first. Check Qdrant dashboard at `http://localhost:6333/dashboard` — collection should have 1000+ points.

**Model errors from OpenRouter**
→ Check that your model IDs in `.env` are valid at [openrouter.ai/models](https://openrouter.ai/models). Update if models have been deprecated.
