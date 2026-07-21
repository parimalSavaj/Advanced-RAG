# Advanced RAG Pipeline — Project Guide

## 1. Project Overview

A Retrieval-Augmented Generation (RAG) system that ingests **SRT/VTT subtitle files** from a Udemy course and allows students to ask questions about course content. The system returns answers that include the **lesson name** and **timestamp** so students can jump directly to the relevant portion of the video.

**Data Source:** `./class_subtitle_lyst1784566935215/class-subtitle/`
- 17 modules, each with multiple lessons
- Each lesson has `.srt` and `.vtt` subtitle files with timestamped transcript text

**LLM Provider:** OpenRouter (access to multiple models via single API)

---

## 2. Architecture (Pipeline Flow)

```
User Query
    │
    ▼
┌───────────────────────────┐
│  INPUT GUARDRAILS & PII   │  ← Step 1: Safety + PII detection/masking
└───────────────────────────┘
    │
    ▼
┌───────────────────────────┐
│  QUERY TRANSFORMATION     │  ← Step 2: Step-back prompting, sub-questions, rewriting
└───────────────────────────┘
    │
    ▼
┌───────────────────────────┐
│  DATA SOURCE ADAPTER      │  ← Step 3: Unified interface over subtitle data
└───────────────────────────┘
    │
    ▼
┌───────────────────────────┐
│  RETRIEVAL + RRF          │  ← Step 4: Multi-strategy retrieval + Reciprocal Rank Fusion
└───────────────────────────┘
    │
    ▼
┌───────────────────────────┐
│  CORRECTIVE RAG (C-RAG)   │  ← Step 5: Evaluate relevance, retry up to 3x
└───────────────────────────┘
    │
    ▼
┌───────────────────────────┐
│  RESPONSE GENERATION      │  ← Step 6: Final LLM answer with lesson + timestamp
└───────────────────────────┘
    │
    ▼
Final Answer (lesson name + timestamp + explanation)
```

---

## 3. Component Breakdown

### 3.1 Data Ingestion & Indexing

**Goal:** Parse all VTT/SRT files, chunk them with metadata, embed, and store in a vector DB.

| Task | Details |
|------|---------|
| Parse VTT/SRT files | Extract text + timestamps from each subtitle cue |
| Chunking strategy | Group consecutive subtitle cues into semantic chunks (~30-60 seconds of speech per chunk) |
| Metadata per chunk | `module_name`, `lesson_name`, `start_timestamp`, `end_timestamp`, `file_path` |
| Embedding | Generate embeddings using free model (Xenova/transformers.js locally or OpenRouter embedding endpoint) |
| Storage | Store in Qdrant (Docker container) |

**Folder structure of source data:**
```
class_subtitle_lyst1784566935215/
└── class-subtitle/
    ├── module 1/
    │   ├── 01_what-is-mobile-development_epm/
    │   │   ├── 01_what-is-mobile-development_epm.srt
    │   │   └── 01_what-is-mobile-development_epm.vtt
    │   ├── 02_react-native-vs-expo_epm/
    │   ...
    ├── module 2/
    ...
    └── module 17/
```

---

### 3.2 Input Guardrails & PII Detection (Step 1)

**Goal:** Validate and sanitize user input before processing.

| Sub-task | Details |
|----------|---------|
| Content safety check | Reject harmful, off-topic, or adversarial prompts |
| PII detection | Detect and mask personal identifiable information (names, emails, phone numbers) |
| Topic relevance | Ensure the query is related to the course content |
| Input length validation | Enforce max token limits on user input |

**Implementation approach:**
- Custom regex patterns for PII detection (email, phone, etc.)
- LLM-based classifier (via OpenRouter) for content safety and topic relevance
- Return early with a user-friendly message if guardrails trigger

---

### 3.3 Query Transformation (Step 2)

**Goal:** Improve retrieval quality by transforming the raw user query.

| Technique | Details |
|-----------|---------|
| Step-back prompting | Generate a broader, higher-level question to retrieve contextual background |
| Sub-question decomposition | Break complex queries into simpler retrievable sub-questions |
| Query rewriting | Rephrase the query for better vector search match (remove ambiguity, expand abbreviations) |

**Example:**
```
Original:  "How do I set up navigation in expo?"
Step-back: "What is the navigation architecture in React Native / Expo?"
Sub-Qs:    ["What is Expo Router?", "How do you configure navigation in Expo?"]
Rewritten: "Setting up screen navigation using Expo Router in a React Native Expo project"
```

All transformed queries go to the retrieval layer.

---

### 3.4 Data Source Adapter Layer (Step 3)

**Goal:** Provide a unified interface for data retrieval, even though we have a single source type (subtitles).

| Sub-task | Details |
|----------|---------|
| Adapter interface | Define a common contract (`retrieve(query) → Document[]`) |
| VTT/SRT adapter | Concrete adapter for subtitle-based retrieval |
| Extensibility | Design so future sources (PDFs, slides, code files) can plug in |

This layer abstracts away the data source specifics so the retrieval logic doesn't care where documents come from.

---

### 3.5 Retrieval + Reciprocal Rank Fusion (Step 4)

**Goal:** Retrieve relevant chunks using multiple strategies and fuse results.

| Strategy | Details |
|----------|---------|
| Dense retrieval | Semantic similarity search using embeddings (cosine similarity via Qdrant) |
| Sparse retrieval | Keyword-based search (BM25 implementation in JS) |
| Metadata filtering | Filter by module/lesson if the query implies a specific topic |

**RRF (Reciprocal Rank Fusion):**
- Combine ranked results from multiple retrieval strategies
- Formula: `RRF_score(d) = Σ 1 / (k + rank_i(d))` where `k = 60` (standard constant)
- Produces a single fused ranking of top-k documents

---

### 3.6 Corrective RAG — C-RAG (Step 5)

**Goal:** Evaluate whether retrieved documents are relevant enough before generating a response. Retry retrieval if not.

| Sub-task | Details |
|----------|---------|
| Relevance grading | LLM grades each retrieved chunk: RELEVANT / IRRELEVANT / AMBIGUOUS |
| Decision logic | If majority relevant → proceed to generation |
| Correction loop | If not relevant → rewrite query and re-retrieve (max 3 attempts) |
| Fallback | After 3 failed attempts → respond with "I couldn't find a relevant answer in the course content" |

**Flow:**
```
Retrieved docs → Grade relevance → Relevant? → YES → Generate answer
                                             → NO  → Rewrite query → Re-retrieve (loop, max 3)
```

---

### 3.7 Response Generation (Step 6)

**Goal:** Generate a final answer with citation to the specific lesson and timestamp.

| Sub-task | Details |
|----------|---------|
| Context assembly | Combine top-ranked relevant chunks into LLM context |
| Answer generation | LLM generates answer using retrieved context (via OpenRouter) |
| Citation format | Include lesson name + timestamp in the response |

**Output format example:**
```
Answer: To set up navigation in Expo, you use Expo Router which provides
file-based routing...

📍 Reference:
- Module 3 > "Setting Up Navigation with Expo Router" — [02:15 - 04:30]
- Module 3 > "Nested Navigation and Tab Setup" — [00:45 - 03:10]
```

---

## 4. Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript / Node.js |
| Runtime | Node.js 20+ |
| LLM Provider | OpenRouter API (supports GPT-4o, Claude, Llama, Mistral, etc.) |
| Embeddings | `@xenova/transformers` (free, local, runs in Node.js) — model: `all-MiniLM-L6-v2` |
| Vector DB | Qdrant (Docker container) |
| Sparse Search | Custom BM25 implementation or `wink-bm25-text-search` (free) |
| Subtitle Parsing | `subtitle` npm package (handles VTT + SRT) |
| API Framework | Express.js or Fastify |
| PII Detection | Custom regex + LLM-based classification via OpenRouter |
| Orchestration | Custom pipeline (no heavy framework needed) |
| Containerization | Docker + Docker Compose (for Qdrant + optional Redis) |
| Frontend (optional) | Simple HTML/CSS/JS or React for demo UI |

### Why These Choices:
- **`@xenova/transformers`** — runs embedding models locally for free, no API cost for embeddings
- **Qdrant (Docker)** — powerful vector DB, easy to run locally, no cloud dependency
- **OpenRouter** — single API key gives access to many LLM models, pay-per-use
- **`wink-bm25-text-search`** — lightweight, zero-dependency BM25 in pure JS

---

## 5. Docker Setup

### `docker-compose.yml`

```yaml
version: '3.8'

services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"    # REST API
      - "6334:6334"    # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped
    # Redis is optional — used for caching embeddings & LLM responses

volumes:
  qdrant_data:
  redis_data:
```

**Run:** `docker compose up -d`

---

## 6. Project Directory Structure

```
Advanced-RAG/
├── GUIDE.md                          ← This file
├── PROJECT.md                        ← Original project description
├── class_subtitle_lyst1784566935215/ ← Raw subtitle data
│   └── class-subtitle/
│
├── docker-compose.yml                ← Qdrant + Redis containers
├── package.json
├── tsconfig.json
├── .env.example                      ← Environment variables template
├── .gitignore
│
├── src/
│   ├── index.ts                      ← Entry point
│   ├── config.ts                     ← Settings, env vars, paths
│   │
│   ├── ingestion/
│   │   ├── parser.ts                 ← VTT/SRT file parser
│   │   ├── chunker.ts               ← Chunking logic (time-based grouping)
│   │   └── indexer.ts               ← Embedding + Qdrant insertion
│   │
│   ├── guardrails/
│   │   ├── input-validator.ts       ← Content safety + topic relevance
│   │   └── pii-detector.ts          ← PII detection & masking
│   │
│   ├── query/
│   │   ├── step-back.ts             ← Step-back prompting
│   │   ├── sub-questions.ts         ← Sub-question decomposition
│   │   └── rewriter.ts             ← Query rewriting
│   │
│   ├── retrieval/
│   │   ├── adapter.ts               ← Data source adapter interface
│   │   ├── dense-retriever.ts       ← Vector similarity search (Qdrant)
│   │   ├── sparse-retriever.ts      ← BM25 keyword search
│   │   └── rrf.ts                  ← Reciprocal Rank Fusion
│   │
│   ├── crag/
│   │   ├── grader.ts               ← Relevance grading
│   │   └── corrective-loop.ts      ← C-RAG loop logic (max 3 retries)
│   │
│   ├── generation/
│   │   ├── generator.ts            ← LLM answer generation (OpenRouter)
│   │   └── formatter.ts            ← Citation formatting (lesson + timestamp)
│   │
│   ├── llm/
│   │   └── openrouter.ts           ← OpenRouter API client wrapper
│   │
│   └── pipeline.ts                  ← Main orchestration (chains all steps)
│
├── api/
│   └── server.ts                    ← Express/Fastify API server
│
├── scripts/
│   └── ingest.ts                    ← Script to run full ingestion pipeline
│
└── tests/
    ├── parser.test.ts
    ├── guardrails.test.ts
    ├── retrieval.test.ts
    └── crag.test.ts
```

---

## 7. Implementation Order (Phases)

### Phase 1 — Setup & Data Ingestion
1. Initialize Node.js project with TypeScript
2. Set up Docker (Qdrant + Redis)
3. Build VTT/SRT parser (`src/ingestion/parser.ts`)
4. Implement chunking with metadata (`src/ingestion/chunker.ts`)
5. Set up local embedding with `@xenova/transformers`
6. Implement Qdrant indexer (`src/ingestion/indexer.ts`)
7. Run ingestion script and verify data is indexed

### Phase 2 — Basic Retrieval
8. Implement dense retriever (Qdrant vector search)
9. Implement sparse retriever (BM25)
10. Implement RRF to fuse results
11. Test retrieval quality with sample queries

### Phase 3 — Query Transformation
12. Set up OpenRouter client (`src/llm/openrouter.ts`)
13. Implement query rewriting
14. Implement step-back prompting
15. Implement sub-question decomposition
16. Integrate with retrieval layer

### Phase 4 — Input Guardrails
17. Implement PII detection/masking (regex-based)
18. Implement content safety + topic relevance check (LLM-based via OpenRouter)
19. Wire guardrails as first step in pipeline

### Phase 5 — Corrective RAG
20. Implement relevance grading
21. Implement C-RAG loop (max 3 retries)
22. Test with edge cases (vague queries, off-topic queries)

### Phase 6 — Response Generation & API
23. Implement answer generation with citations
24. Implement response formatter (lesson name + timestamp)
25. Build API endpoint (Express/Fastify)
26. End-to-end pipeline testing

### Phase 7 — Polish
27. Add error handling + logging
28. Build simple demo UI
29. Write documentation

---

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| TypeScript + Node.js | Strong typing, good ecosystem for APIs, `@xenova/transformers` works natively |
| Local embeddings (`@xenova/transformers`) | Free, no API cost, fast for batch ingestion, privacy-friendly |
| OpenRouter for LLM | Single API, access to many models, can switch between cheap/expensive models per task |
| Qdrant via Docker | No local install needed, persistent storage, scales well, great JS client |
| Custom BM25 / `wink-bm25` | Free, no external service, lightweight sparse search |
| RRF over simple re-ranking | Combines dense + sparse strengths without needing a trained re-ranker |
| C-RAG max 3 attempts | Prevents infinite loops; 3 retries covers most query reformulation needs |
| Time-based chunking (30-60s) | Subtitles are short; grouping by time gives enough context while keeping timestamps meaningful |
| Redis for caching | Avoids redundant LLM calls and re-embedding; keeps costs low |

---

## 9. Environment Variables (`.env.example`)

```env
# LLM
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=meta-llama/llama-3.1-8b-instruct:free
OPENROUTER_GRADING_MODEL=meta-llama/llama-3.1-8b-instruct:free

# Embeddings (local)
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=course_subtitles

# Redis (optional caching)
REDIS_URL=redis://localhost:6379

# Ingestion
SUBTITLE_DATA_PATH=./class_subtitle_lyst1784566935215/class-subtitle
CHUNK_DURATION_SECONDS=45

# RAG
MAX_CRAG_RETRIES=3
RRF_K=60
TOP_K_RESULTS=10

# API
PORT=3000
```

---

## 10. OpenRouter Usage Notes

- **Base URL:** `https://openrouter.ai/api/v1`
- **Compatible with OpenAI SDK** — just change the base URL and API key
- **Free models available:** `meta-llama/llama-3.1-8b-instruct:free`, `mistralai/mistral-7b-instruct:free`
- **For grading/classification tasks:** use a free/cheap model
- **For final answer generation:** use a better model if budget allows

**Example OpenRouter call pattern:**
```typescript
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    messages: [{ role: 'user', content: prompt }],
  }),
});
```

---

## 11. Next Steps

1. Run `docker compose up -d` to start Qdrant + Redis
2. Initialize the Node.js/TypeScript project
3. Start with **Phase 1** — parse a single VTT file, chunk it, embed it, store it in Qdrant, and verify retrieval works on a single lesson
4. Then scale to all modules
