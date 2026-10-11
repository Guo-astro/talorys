# Semantic recall

Semantic recall is an opt-in module that finds memories by meaning as well as by
keyword. It is off by default. While it is off, Talorys behaves exactly like
upstream: same tools, same system prompt, same memory responses, and no
`tal_semantic_*` tables.

The code lives in `apps/agent/src/semantic/` plus one web component
(`SemanticRecallCard`).

## Enabling

Turn it on in **Settings → AI → Semantic memory recall**. The card also shows
the embedder in use, how many memories have vectors, how many are pending, and
today's embeddings against the cap.

The installer can turn it on for you: answer Yes to "Enable semantic recall?",
or pass `--semantic` (`--no-semantic` or `-y` alone means No). A Yes adds the
Worker var `TALORYS_SEMANTIC_DEFAULT=on`, and the agent enables the feature once
on first boot. After that, Settings is the source of truth.

Enabling creates the module's tables. Existing memories are embedded in the
background and before each chat turn, 50 at a time.

The config is stored in `tal_settings` under the key `semantic.recall`.
Defaults come from `DEFAULT_SEMANTIC_CONFIG` in
`apps/agent/src/semantic/config.ts`:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Module on or off |
| `model` | `@cf/baai/bge-m3` | Workers AI embedding model (1024 dimensions) |
| `maxEmbeddingsPerDay` | `500` | Daily embedding cap (0 to 10,000) |
| `vectorFloor.absolute` | `0.55` | Minimum cosine score for a vector hit |
| `vectorFloor.relative` | `0.1` | A vector hit must also be within this of the best hit |
| `vectorFloor.backstop` | `0.4` | Minimum cosine for a top-k fallback hit; never above `vectorFloor.absolute` |

Turning it off keeps the vectors, so turning it back on only embeds what
changed in the meantime.

### Changing the embedding model

Vectors are stored per model. Recall only compares vectors of the configured
model and its size, so changing `model` never mixes old and new vectors: every
memory is re-embedded for the new model, lazily on the next chat turns or all at
once with **Reindex**, and keyword search covers the gap meanwhile. A stored
config that is still the untouched old default (`@cf/baai/bge-small-en-v1.5`
with floors 0.5 and 0.1) reads as the bge-m3 defaults, so such an instance moves
to bge-m3 without a Settings change. An owner who picks bge-small and sets those
exact floors by hand also reads as bge-m3.

bge-m3 compresses its cosines (correct hits about 0.43 to 0.66), so a newer
near-duplicate is pulled in beside a selected memory at a stored cosine of 0.57
under bge-m3 and 0.70 under every other model.

## How recall works

On each chat turn and scheduled prompt, the module replaces upstream
`selectRelevantMemories`:

1. **Lazy indexing.** Up to 50 pending memories (new, or edited since their
   vector was made) are embedded in one batched Workers AI call. Vector rows of
   deleted memories are purged.
2. **Two rankings.** A cosine scan over `tal_semantic_vectors`, keeping hits
   that clear both parts of `vectorFloor`, and the upstream keyword search.
3. **Top-k fallback.** When fewer than 4 vector hits clear the floors, the list
   is filled up to 4 with the best remaining vectors at or above
   `vectorFloor.backstop`, best first, so loose associations that score under
   the floor still reach the model. "What's the capital of France?" (best
   bge-m3 cosine 0.384) still gets no vector hits; a greeting such as "hello"
   (best about 0.51) brings up to 4 low-relevance memories.
4. **Fusion.** The two lists are merged with reciprocal rank fusion (k = 60).
5. **Selection.** The top 8 go into the prompt, padded with recent preferences
   by the upstream rule (up to 4, never past 8 in total).

Memories reach the prompt in the upstream format (`- [category] content`). No
system text is added.

If embedding fails, no embedder is bound, or the daily cap is spent, the vector
list is empty and the keyword list alone ranks, which matches upstream. If the
module itself fails, chat falls back to upstream recall.

## Newest first (M1)

The selected memories are ordered newest first by last update, and each line
starts with the date, 24-hour time and short zone it was saved in, in the owner's
timezone:

```
- [fact] (saved 2026-10-10 20:31 PDT) I just traded my VW bug away and got a 2025 Tesla.
- [fact] (saved 2026-03-02 09:14 PST) I drive a VW Bug.
```

That lets the model prefer the newer of two conflicting memories without any
extra bookkeeping, even for two memories saved minutes apart on the same day.
The prefix costs about 10 tokens per memory.

## Budgets

| Budget | Target |
| --- | --- |
| Embedding cap | 500 per day by default (`maxEmbeddingsPerDay`), separate from the AI request limit |
| Neurons | About 0.06 per turn at 1,075 neurons per million input tokens; a backfill of 1,000 memories is about 32 |
| Cosine scan | ≤ 5 ms at 5,000 memories |
| Storage | One vector row per memory |
| New npm dependencies | 0 |

Each query and each batch of memories counts toward the cap. When it is spent,
recall uses keyword search until the next day.

## Forget

Forgetting is real. Deleting a memory from the Memory page, with
`forget_memory` in chat, or with **Clear all** deletes its vector row in the
same request. A forgotten memory never appears in recall again. This also
happens while the feature is turned off, as long as its tables exist.

Saving a memory (Memory page, `remember`, `update_memory`, or a backup import)
starts a background index, so new memories do not wait for the next chat turn.

## Backups and Reindex

Vectors are derived data. The upstream backup (**Settings → Your data**) does not
include them, and there is no separate semantic backup. After a restore, the
imported memories are embedded in the background, lazily on the next chat
turns, or all at once with **Reindex**.

**Reindex** drops every vector and re-embeds all memories in batches of 50. It
stops early if the daily cap is reached; the rest are picked up the next day.

**Delete semantic data** drops every module table and the config key. Your
memories are kept. The feature returns to its never-enabled state.

## API

All routes sit under `/api`, behind the existing session, CSRF and security
headers.

| Route | Purpose |
| --- | --- |
| `GET /semantic/config`, `PUT /semantic/config` | Read or patch the config |
| `GET /semantic/status` | Enabled flag, embedder, vectors, pending, embeddings today and cap |
| `GET /semantic/search?q=&limit=` | Hybrid hits with cosine and fused scores |
| `POST /semantic/reindex` | Drop all vectors and re-embed |
| `DELETE /semantic/data` | Body `{"confirm": "DELETE"}`; drop every module table and the config key |

## Cleanup after the fact-layer fork

An instance that ran the earlier fact-layer fork still holds its `tal_sem_*`
tables. Slim works without cleanup: it ignores those tables and embeds memories
into its own. To remove them once, recommended after switching:

1. Settings → AI → Semantic memory recall → **Delete semantic data** (memories
   are kept).
2. Turn semantic recall **on** again.
3. Click **Reindex** (one embedding per memory, well under the 500/day cap for a
   personal store).

## Known limitation

The embedding model matches meaning, not loose associations, so these memories
score under the 0.55 floor and reach the model only through the top-k fallback.
For "Plan me a Saturday adventure in the mountains", "I'm afraid of heights"
(0.512) is recalled in a small store, while "My knee surgery was in August"
(0.409) gets in only when few memories compete: in a 21-memory pool the 4
fallback slots go to better-scoring memories. For "Can I play tennis like a
regular person?", "I only have one arm" (0.427) and "I have no arms" (0.435)
get in on the backstop. The live eval reports these cases but never fails on
them. Lowering `vectorFloor` or the backstop trades misses for more noise in
other answers.

The car and oil cases count the VW as current only when the answer says he
drives, owns or has it, and the oil case also fails when the answer gives the
VW its own oil advice or says it lacks info about his car; a separate L-arm
case reports, without failing, whether a tennis answer remembers that he has
one arm, and L-noarm does the same for a saved "I have no arms".

For local development and tests, see the mock embedder in
[development.md](development.md#semantic-recall).
