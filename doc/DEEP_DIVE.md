# Advanced RAG System — Deep Dive Explanation

This document explains every part of the system in depth. No code. Pure understanding. Read this before you write a single line.

---

## What Are We Actually Building?

At its core, this is a question-answering system over spoken lecture content. A student watches a Udemy course and later wants to revisit something — but instead of scrubbing through hours of video, they ask a natural language question. The system finds the exact moment in the exact lesson where that topic was discussed and gives them a precise, context-rich answer along with a reference to which lesson and timestamp to revisit.

The challenge is not just "search" — it is smart, corrective, safe, and citation-aware retrieval. That is what makes it Advanced RAG and not just a vector search wrapper.

---

## Understanding the Raw Data First

Before touching any system design, you need to understand what you are working with.

You have 87 lessons across 18 modules (including "module 1 hc" for hot chapter content). Each lesson lives inside its own folder. Inside that folder are two files — one `.vtt` and one `.srt` — that contain the exact same spoken content, just in different formats.

**VTT format** starts with the word `WEBVTT` on the first line, followed by blank-line-separated cue blocks. Each cue block has a timestamp line like `00:00:04.260 --> 00:00:07.740` followed by the spoken text for that time window. Timestamps use periods as millisecond separators.

**SRT format** is almost identical but each cue has a sequential number above the timestamp, and timestamps use commas as millisecond separators instead of periods.

Each individual cue is typically one to three sentences long and covers only two to eight seconds of speech. This is very granular — far too granular to use as individual units for retrieval. If you searched for "what is Expo Router" and got back a single cue that says "It provides file-based routing" with no surrounding context, that answer is useless. So the first major design challenge is deciding how to group these tiny cues into meaningful chunks.

The folder and file names themselves carry useful metadata. A folder named `module 13/chapter-3-implementing-google-oauth_epm` tells you the module number, the lesson position within the module, and a human-readable lesson title. This is valuable — you extract this as structured metadata attached to every chunk you store, so your final answer can cite it clearly.

---

## The Ingestion Pipeline — Turning Raw Files Into a Searchable Index

### Parsing

Parsing is straightforward but has a few nuances worth thinking through carefully.

You walk the entire class-subtitle directory recursively. For every folder at depth 2 (lesson level), you pick the `.vtt` file. SRT is the fallback if VTT is missing for any reason. You parse the file into a flat list of cue objects, where each cue has a start time in seconds, an end time in seconds, and the spoken text string.

From the folder path itself, you extract the module name and the lesson name. The lesson folder name has a suffix of `_epm` that you strip off. Some lessons use numeric prefixes like `01_`, others use `chapter-1`, and some have no prefix at all — your name extraction logic needs to handle all three patterns and produce a clean, human-readable lesson title.

One practical issue: VTT text sometimes has HTML-like tags such as `<c>` or `<00:00:01.234>` embedded in it for karaoke-style highlighting. These need to be stripped out during parsing so you do not store garbage in your index.

### Chunking — The Most Critical Design Decision

Chunking is where most RAG systems fail or succeed. Too small and you lose context. Too large and you dilute relevance and hit token limits.

For subtitle data specifically, the right approach is time-window chunking. You accumulate consecutive cues until the total time span of the accumulated cues reaches a threshold — something between 30 and 60 seconds is the sweet spot. Once you hit that threshold, you finalize that group of cues as one chunk and start a new one.

Why time-based rather than token-count-based? Because subtitles are already aligned to time. Your chunk's start and end timestamps become the citation you show the user — "watch from 02:15 to 04:30." If you chunk by token count, your chunk boundaries become arbitrary and the timestamps are less clean to represent.

Each chunk stores: the full concatenated text of all its cues, the start timestamp of its first cue, the end timestamp of its last cue, the module name, the lesson name, the lesson folder path, and a unique deterministic ID derived from module + lesson + chunk index. That unique ID is important — it lets you re-run ingestion without creating duplicate records, because you can upsert by ID.

A subtle but important decision is overlapping chunks. If you chunk strictly without overlap, a sentence at the boundary of two chunks gets split — the beginning is in chunk 3 and the conclusion is in chunk 4. Retrieval might return only one of them and the answer is incomplete. A small overlap — carrying the last 5-10 seconds of one chunk into the start of the next — fixes this at the cost of some index size increase. For a 87-lesson course this overhead is negligible, so overlapping is worth doing.

### Embedding

Once you have chunks, each chunk's text needs to be converted into a vector — a list of floating-point numbers that encodes the semantic meaning of that text in a high-dimensional space.

You are using `@xenova/transformers` with the `all-MiniLM-L6-v2` model. This model runs entirely locally in your Node.js process — no API call, no cost, no rate limit. It produces 384-dimensional vectors. The model is small enough to load into memory once and reuse for all 87 lessons without significant performance issues.

The important thing to understand about this model is that it was trained on general English text, which means it handles conversational spoken language reasonably well. It understands that "setting up navigation" and "configuring the router" are semantically close. That is the power of dense retrieval — it captures meaning rather than just matching keywords.

One practical consideration: the first time you run ingestion, the model needs to download from Hugging Face. After that it is cached locally. Budget a few minutes for the first run.

### Storing in Qdrant

Qdrant is a vector database. Its job is to efficiently store vectors and find the nearest neighbors to a query vector — in other words, find the stored chunks whose embeddings are most similar to the embedding of the user's query.

Each record in Qdrant is called a point. A point has a unique ID, a vector (the embedding), and a payload (an arbitrary JSON object where you put all the metadata — module name, lesson name, timestamps, text, file path).

You store every chunk as one point. At query time, you embed the user's query using the same model, then ask Qdrant to find the top-K points whose vectors are most similar. Qdrant uses cosine similarity for this comparison — it measures the angle between vectors rather than the Euclidean distance, which works better for text embeddings.

Qdrant runs in Docker with a persistent volume, so your indexed data survives container restarts. You only need to run the ingestion script once. After that, the index is ready and the API server just queries it.

---

## The Query-Time Pipeline — What Happens When a User Asks a Question

Once ingestion is done, the interesting work begins at query time. A user types a question. That question travels through six stages before an answer comes back.

### Stage 1 — Input Guardrails and PII Detection

This is the first gate. Before you do anything with the query, you need to answer three questions: Is this query safe? Does it contain personal information that should not be logged or processed? Is it even on topic for this course?

**PII Detection** runs first because it is fast and does not require an LLM call. You scan the query text for patterns that match email addresses, phone numbers, and similar identifiers using regular expressions. If you find PII, you either mask it or reject the query with a message explaining why. The reasoning is that users sometimes accidentally paste in contact details or personal information when asking questions, and you do not want that flowing into LLM prompts or being logged.

**Topic relevance and content safety** require an LLM judgment call. You send the query to OpenRouter with a tightly constrained prompt that asks only: "Is this question related to mobile development, React Native, Expo, or general programming concepts as taught in a software course? Answer YES or NO with a brief reason." You use a cheap or free model for this because the task is simple classification, not complex reasoning. If the answer is NO, you return an early response telling the user this system only answers course-related questions.

**Length validation** is a simple check — queries longer than a reasonable limit (say 500 characters) are likely not genuine questions and can be rejected with a message asking the user to be more concise.

The key principle of this stage is "fail fast and cheaply." You want to eliminate bad inputs before doing expensive retrieval and generation work.

### Stage 2 — Query Transformation

This is the most intellectually interesting stage. The core insight here is that the way users phrase questions is often a poor match for how information is stored in your index. Retrieval quality depends heavily on the quality of the query, so you invest effort in improving the query before using it.

There are three transformations, and all three run in parallel since they are independent of each other.

**Query Rewriting** takes the original question and rephrases it for better vector search performance. Natural language questions are often verbose, ambiguous, or rely on pronouns and context. "How do I do that thing with the router?" is a terrible retrieval query. A rewritten version might be "configuring Expo Router for file-based navigation in React Native." Rewriting involves an LLM call with a prompt that asks it to rephrase the query into a clear, specific, jargon-appropriate form without answering the question. The output replaces the original query for the primary retrieval.

**Step-Back Prompting** asks a fundamentally different question: what broader concept does this query belong to? If the user asks "Why does my stack navigator not show a back button on Android?" the step-back question might be "How does React Native navigation handle the back button behavior across platforms?" The step-back question retrieves broader conceptual context that often contains the background needed to give a complete answer, even when it does not directly answer the specific question. It is an LLM call that produces one broader question, which then goes into retrieval alongside the rewritten query.

**Sub-Question Decomposition** handles complex questions that are actually multiple questions bundled together. "How do I set up authentication with Google OAuth and also configure protected routes in Expo?" is really two questions. Decomposing it into distinct sub-questions — "How to configure Google OAuth in Expo" and "How to set up protected routes in Expo Router" — lets you retrieve targeted results for each part and then combine them. The LLM call here produces a JSON array of simpler questions. Each sub-question runs retrieval independently.

After transformation, you have multiple queries: the rewritten original, the step-back question, and N sub-questions. All of them go into Stage 3 and 4 simultaneously.

### Stage 3 — The Data Source Adapter

This is an architectural layer, not a computation-heavy one. Its purpose is to keep the retrieval logic clean and decoupled from where data lives.

You define an interface with a single method: given a query string, return a list of document chunks with their metadata. The adapter hides all the details of connecting to Qdrant, embedding the query, running the search, and formatting the results.

The reason this matters is extensibility. Right now all your data is subtitle files in Qdrant. But in the future you might add a PDF reader for slide decks, or a code repository adapter for source code examples. The retrieval layer above the adapter does not need to change — it just calls the same interface. Each new data source gets its own adapter implementation.

For now you have one concrete adapter: the Qdrant subtitle adapter. It embeds the incoming query, searches Qdrant with that embedding, and returns the matching chunks with their full metadata payload.

### Stage 4 — Multi-Strategy Retrieval and RRF

For every query that comes in (remember you now have multiple queries from Stage 2), you run two types of retrieval and then fuse the results.

**Dense Retrieval** is semantic search. You embed the query and find the nearest vectors in Qdrant. This is great at finding conceptually related content even when the exact words do not match. "How do I navigate between screens?" will find chunks that talk about "routing" and "screen transitions" because the embeddings are close in vector space.

**Sparse Retrieval (BM25)** is keyword-based scoring. You precompute a BM25 index from the text of all your stored chunks at startup. BM25 scores documents based on term frequency and document frequency — essentially how often the query words appear in each document, adjusted for how common those words are across the whole corpus. This is great for precise technical terms — if someone asks about "useLocalSearchParams" (a specific Expo Router API), dense retrieval might not find it because that exact token might not be well-represented in the embedding space, but BM25 will find every chunk that literally contains that function name.

Each strategy returns a ranked list of chunks. The problem is that two ranked lists need to be combined into one. This is where Reciprocal Rank Fusion comes in.

**RRF** is an elegant algorithm. For each document, it calculates a score based on its rank position in each list. The formula is: `1 / (60 + rank)`. The number 60 is a constant that dampens the effect of very high or very low ranks. A document ranked 1st in one list and 5th in another gets a combined RRF score of `1/61 + 1/65 = 0.0164 + 0.0154 = 0.0318`. A document ranked 3rd in both lists gets `1/63 + 1/63 = 0.0317`. You can see how consistent mid-level performance across both lists can beat a single very high rank in one list — this is intentional, because consistent relevance across multiple strategies is a stronger signal than being highly relevant to only one strategy.

After RRF, you have one unified ranked list of the most relevant chunks across all queries and all retrieval strategies. You take the top K (typically 10) chunks into the next stage.

### Stage 5 — Corrective RAG

This is the quality gate that separates Advanced RAG from basic RAG. The question this stage answers is: "Are the retrieved chunks actually useful for answering this question, or are we about to generate a hallucinated response from irrelevant content?"

**Relevance Grading** sends each retrieved chunk along with the original query to an LLM. The prompt asks it to grade the chunk on a three-point scale: RELEVANT means the chunk directly helps answer the question, IRRELEVANT means it does not, AMBIGUOUS means it provides some peripheral context but not a direct answer. You use a cheap model here — this is pattern recognition, not reasoning.

After grading, you look at the distribution. If a majority of your top chunks are RELEVANT, you are confident the retrieved context is good and you proceed to generation. If most chunks are IRRELEVANT or AMBIGUOUS, something went wrong in retrieval — the query did not match well with what is in the index.

**The Correction Loop** handles the failure case. When retrieval quality is poor, you do not give up immediately. Instead you rewrite the query differently — using a more aggressive rewriting strategy that significantly changes the vocabulary, perhaps going broader or more specific — and run retrieval again from scratch. You track how many attempts have been made. The maximum is 3. On the third failure, you return a graceful fallback response that says no relevant content was found for this question in the course material.

Why max 3 and not more? Because if three different query formulations all return irrelevant content, the answer almost certainly does not exist in the course. More retries would just burn more LLM calls and user patience without improving results.

What happens to AMBIGUOUS chunks? They are included in the context if there are not enough RELEVANT chunks, but they are given lower weight in the context assembly. The LLM generator is instructed to use them only if they supplement RELEVANT content.

### Stage 6 — Response Generation

This is the final stage. You have a set of relevant, graded chunks. You now construct a prompt for the LLM that contains those chunks as context and asks it to answer the user's original question.

**Context Assembly** is about ordering and selection. You put the highest-scoring RELEVANT chunks first, followed by AMBIGUOUS chunks if needed to fill the context window. For each chunk you include in the context, you label it with its source: module name, lesson name, start timestamp, and end timestamp. This labeling is what makes citations possible — the LLM can see exactly where each piece of information came from.

**Answer Generation** uses a better model via OpenRouter than the cheap models used for grading and classification. This is where cost management matters — grading runs on a free or cheap model, but the final answer generation uses a more capable model because answer quality matters here. The prompt instructs the LLM to answer based only on the provided context, to cite which lessons it drew from, and to format those citations with the module name, lesson title, and timestamp range. It is explicitly told not to invent information that is not in the context.

**Response Formatting** produces the final output structure. The answer text comes first, then a clearly formatted reference section listing each lesson that was used. The timestamp format is human-readable — "Module 3 > Implementing Google OAuth — [02:15 - 04:30]" — so the student knows exactly where to seek in the video. If multiple chunks from the same lesson were used, they are grouped under one lesson entry with multiple timestamp ranges rather than repeating the lesson name multiple times.

---

## The Data Flow In Full — End to End

Here is the complete journey of one user question through the system:

A student types "How do I add a loading spinner while fetching data in Expo?" 

The guardrails check it — no PII, it is on-topic for a mobile development course, it is a reasonable length. It passes.

Query transformation runs in parallel. The rewriter produces "displaying activity indicator during async data fetch in React Native Expo." The step-back produces "How does Expo handle asynchronous operations and loading states in UI components?" Sub-question decomposition produces two questions: "What is ActivityIndicator in React Native?" and "How to show loading state during fetch in Expo?"

All four query variants go to the adapter layer. Each one runs both dense retrieval (semantic search via Qdrant) and sparse retrieval (BM25 keyword search). Each pair returns a ranked list. RRF fuses all eight ranked lists (four queries times two retrieval strategies) into one unified top-10 list.

The C-RAG grader evaluates the top-10 chunks. Seven are marked RELEVANT, two AMBIGUOUS, one IRRELEVANT. Majority are relevant, so no correction loop is needed.

The generator receives the seven RELEVANT chunks plus the two AMBIGUOUS ones, all labelled with their lesson sources. It composes an answer explaining ActivityIndicator, how to conditionally render it while an async operation is pending, and how to use a loading state variable with useState. The response cites Module 6 > "Data Fetching Patterns in Expo" at [03:45 - 06:10] and Module 8 > "Building a Weather App — Handling API Responses" at [01:20 - 02:55].

Total time: under 5 seconds. Total LLM calls: 1 (guardrail check) + 3 (query transformation, parallel) + 10 (grading, one per chunk) + 1 (final generation) = approximately 15 LLM calls, most of which use a free or cheap model.

---

## Why Each Architectural Decision Was Made

Understanding the "why" prevents you from second-guessing yourself or going off-track during implementation.

**Why not use a single query and single retrieval?**
Because simple RAG is brittle. A single vector search only finds content whose phrasing closely matches the query. Step-back, sub-questions, and rewriting dramatically expand the surface area of retrieval, catching content that would be missed by any single query formulation. The cost is a few more LLM calls; the benefit is dramatically better recall.

**Why BM25 alongside dense retrieval?**
Dense retrieval is terrible at precise technical terms that appear rarely or in ways the embedding model has not seen in training. If a student asks about a specific API method name, a function name, or an acronym specific to the course, BM25 will find it reliably where dense retrieval might miss it. They are complementary, not redundant.

**Why RRF and not a learned re-ranker?**
A learned re-ranker needs training data. You do not have any labeled query-document relevance pairs for this course. RRF is a parameter-free method that works well without any training, and it has been shown empirically to outperform naive score combination on most retrieval tasks.

**Why an Adapter layer if there is only one data source?**
Because the architecture should not be refactored the moment you want to add a second source. Building the adapter now costs maybe 30 minutes. Not building it now costs hours of refactoring later when someone says "can we also search through the PDF slides?"

**Why C-RAG at all?**
Without C-RAG, your system will generate confident-sounding but wrong answers when retrieval fails. C-RAG gives you a quality signal before generation, turning retrieval failures into honest "I don't know" responses rather than hallucinations. This is the difference between a useful tool and a misleading one.

**Why max 3 C-RAG retries?**
One retry handles the case where the original query was poorly phrased. Two retries handle the case where the first rewrite was also not great. Three retries is a reasonable exhaustion of strategies. Beyond three, you are likely dealing with a question that genuinely is not covered in the course content, and continuing is wasteful.

**Why time-based chunking and not sentence or token based?**
The output of this system is always a timestamp reference. That timestamp must correspond to a real contiguous segment of video, not an arbitrary token window. Time-based chunking ensures every chunk is a coherent speech segment that a student can actually navigate to and watch.

**Why local embeddings and not OpenRouter embeddings?**
Ingestion needs to embed 87 lessons worth of content in batch. At even a small per-call cost, this becomes expensive and slow if done through an API. Running the embedding model locally is free, has no rate limits, and is fast in batch. The model quality (`all-MiniLM-L6-v2` at 384 dimensions) is entirely sufficient for sentence-level semantic search on English text.

**Why Redis for caching?**
Two scenarios justify it. First, if the same query is asked repeatedly (common in a course setting — many students ask the same questions), caching the LLM responses saves both money and latency. Second, embedding computation for query-time is fast locally, but caching frequent queries avoids even that. Redis with a TTL (time-to-live) is the simplest possible caching layer.

---

## Things That Can Go Wrong and How to Prevent Them

**Chunking boundary problems:** A key concept that spans two chunks might get split and never retrieved as a whole. Overlap between adjacent chunks (carrying the last few seconds of each chunk into the start of the next) is the mitigation.

**Embedding model cold start:** The first time the embedding model is needed, it downloads several hundred megabytes and loads into memory. This causes a slow first request. Mitigate by pre-loading the model when the API server starts, not on the first request.

**Qdrant collection not initialized:** If someone starts the API before running ingestion, the collection does not exist in Qdrant and queries will throw errors. The API server should check on startup and return a clear error if the collection is missing or empty.

**OpenRouter rate limits:** Free models on OpenRouter have rate limits. Under normal usage this is fine, but if multiple students query simultaneously, you may hit them. Implement simple request queuing or retry-with-backoff logic in your OpenRouter client wrapper.

**Lesson name noise in metadata:** Some lesson folder names have inconsistent formatting — some use underscores, some use spaces, some use numbers, some use the word "chapter." Clean this during ingestion so your citations always look professional and consistent.

**Very short chunks:** Some lessons have very sparse subtitle content — cues spaced far apart with minimal text. A time-window chunker might produce chunks with only one or two sentences. Set a minimum text length threshold: if a chunk has fewer than some number of words, merge it with the next chunk regardless of the time boundary.

**Query that spans multiple lessons:** A student might ask "What changed between how we did navigation in module 3 versus module 8?" This is a comparative question across lessons. Sub-question decomposition handles this naturally — it breaks the question into "navigation approach in module 3" and "navigation approach in module 8" as two separate retrievals. The combined context lets the LLM compare them.

---

## The Ingestion Script vs The API Server

These are two separate entry points that you run at different times.

The ingestion script is a one-time (or occasional) batch job. It reads all the subtitle files, parses them, chunks them, embeds them, and writes them to Qdrant. It also builds and saves the BM25 index to a local file. It has no HTTP server, no real-time interaction — it just runs, processes everything, and exits. You run it once before the API goes live, and re-run it only if the course content changes.

The API server is what students interact with. It starts by loading the pre-built BM25 index from disk, pre-loading the embedding model, verifying Qdrant is reachable and the collection has data, and then binding to a port and waiting for requests. Each incoming question triggers the full pipeline.

Keeping them separate is important because ingestion is slow and memory-intensive, while the API server needs to be fast and responsive. Mixing them would mean either the API server does slow batch work at startup, or you end up with complexity managing background jobs.

---

## Summary of Every File's Purpose

Every file in this project has a single responsibility. When you open any file, you should be able to describe its job in one sentence.

The **parser** only knows about VTT and SRT file formats. It does not know about chunking, embedding, or Qdrant.

The **chunker** only knows about grouping cues by time window. It does not know where cues came from or where chunks are going.

The **indexer** only knows about taking chunks and putting them into Qdrant. It does not know how chunks were created.

The **pii-detector** only knows about finding and masking personal information in a text string.

The **input-validator** only knows about deciding whether a query is safe and on-topic.

The **rewriter**, **step-back**, and **sub-questions** modules each only know about one query transformation technique.

The **adapter** only knows about the contract between retrieval strategies and the pipeline.

The **dense-retriever** only knows about querying Qdrant.

The **sparse-retriever** only knows about querying BM25.

The **rrf** module only knows about combining multiple ranked lists into one.

The **grader** only knows about asking an LLM whether a document is relevant to a query.

The **corrective-loop** only knows about the retry logic and when to give up.

The **generator** only knows about calling OpenRouter with context and getting an answer.

The **formatter** only knows about turning a raw LLM answer and its source chunks into a structured, citation-rich response.

The **pipeline** orchestrates all of the above. It does not contain any logic itself — it only calls the other modules in the right order and passes data between them.

This strict single-responsibility design means that when something goes wrong, you know exactly which file to look in. It also means each piece can be tested and reasoned about independently.
