# titterpig-rules-lawyer

Ask a TTRPG ruling question, get an answer with the **verbatim** rules text and
its source. It indexes the resolved output of
[titterpig-synthesist](../Titterpig%20Utilities/titterpig-synthesist) (a
`*.merged.ttrpg` + `*.resolved.json` pair per edition) into a hybrid
keyword + semantic search index, and answers through Claude Code via an MCP
server + skill.

Each corpus is one edition/composition (e.g. `daggerheart-0.4`, `tor2e-0.4`,
`l5r5e-0.4`); every query targets exactly one corpus.

## How it works

```
synthesist output ──► ingest ──► SQLite index ──► retrieval ──► answer
 merged.ttrpg          chunk       FTS5 + vec0      hybrid RRF     (Claude Code
 resolved.json         + embed     per corpus       search         skill + MCP)
```

- **Chunk** = one entity (`^"Name" DEF { … }`) from the merged `.ttrpg`, plus
  top-level structural blocks (`GAME_STRUCTURE`, tables) and the named DEFs
  nested inside them. Entity metadata (sources, `extends`, hash) is joined from
  `resolved.json`. The stored text is a verbatim slice — the quote source.
- **Index** = one SQLite DB per corpus (`data/index/<id>.db`) with an FTS5 table
  (BM25) and a `sqlite-vec` `vec0` table.
- **Retrieval** = FTS + vector legs fused with Reciprocal Rank Fusion. Falls
  back to keyword-only when no embedding backend is available.
- **Embeddings** = local, via [Ollama](https://ollama.com) `nomic-embed-text`
  (768-dim). Pluggable; no external API. Optional — keyword search works without
  it.

## Setup

```bash
npm install
cp .env.example .env          # optional; defaults are fine
ollama pull nomic-embed-text  # optional; enables semantic search
```

### Where corpora come from

`corpora.json` points at a **corpus store** via `root` (default
`../titterpig-corpora`, overridable with the `TITTERPIG_CORPORA` env var). Every
`<id>.merged.ttrpg` under that root — paired with a sibling `<id>.resolved.json`,
and optionally `<id>.sources.json` — is auto-discovered as a corpus, its id taken
from the filename. Drop synthesist output in, organized however you like (the
convention is `<edition>/<version>/`):

```
titterpig-corpora/
  tor2e/0.4/tor2e-0.4.merged.ttrpg
  tor2e/0.4/tor2e-0.4.resolved.json
  daggerheart/0.4/daggerheart-0.4.merged.ttrpg
  daggerheart/0.4/daggerheart-0.4.resolved.json
```

For artifacts that live elsewhere, add explicit `corpora` entries (with absolute
or corpora.json-relative `merged`/`resolved`/`sources` paths); they supplement
discovery and win on id collision.

## Use

```bash
# Build/refresh an index (‑‑embed adds vectors; omit for keyword-only)
npm run ingest -- --corpus daggerheart-0.4 --embed
npm run ingest -- --corpus daggerheart-0.4 --embed --force   # rebuild

# List indexed corpora (marks the in-scope one)
npm run corpora

# Choose the in-scope corpus (the working set questions run against)
npm run use -- daggerheart-0.4
npm run use               # print current scope
npm run use -- --clear    # clear it

# Debug retrieval without the LLM (uses the in-scope corpus if no id given)
npm run search -- "what happens when I mark my last Stress" --mode hybrid --k 8
npm run search -- tor2e-0.4 "being Weary"   # ad-hoc override
```

### Scope: one corpus at a time

Exactly one corpus is **in scope** at a time — a `cd`-like working set. The query
tools operate only on it, so questions never blend rules across editions. Set it
with `select_corpus` (in Claude) or `npm run use` (CLI); it persists in
`data/active-corpus.json` until changed. To lock a whole session to one corpus
with no cross-session bleed, launch pinned:

```bash
RULES_LAWYER_CORPUS=daggerheart-0.4 claude   # immutable scope for this session
```

Then, in **Claude Code** (the `.mcp.json` here registers the server), just ask a
ruling question — the `rules-lawyer` skill drives select → search → read → cite.
MCP tools: `list_corpora`, `active_corpus`, `select_corpus`, `search_rules`,
`get_entity`, `get_related` (the last three run against the in-scope corpus and
take no corpus argument).

## Layout

| Path | What |
|------|------|
| `src/core/` | retrieval library — no MCP/CLI deps (the web-phase seam) |
| `src/core/chunker.ts` | merged.ttrpg → chunks (the one nontrivial algorithm) |
| `src/core/store.ts` | SQLite schema, FTS5 + vec0 |
| `src/core/retrieval.ts` | hybrid search, `get_entity`, `get_related` |
| `src/core/embeddings/` | pluggable providers (Ollama default, fake for tests) |
| `src/mcp/` | MCP server (`build.ts` factory + `server.ts` stdio entry) |
| `src/core/session.ts` | in-scope corpus selection (env pin / state file) |
| `scripts/` | `ingest` / `search` / `corpora` / `use` CLIs |
| `.claude/skills/rules-lawyer/` | the answering workflow (verbatim quotes, reflection) |
| `docs/web-phase.md` | notes for the future Claude-API web UI |

## Testing

```bash
npm run typecheck
npm test
```

Tests run against real synthesist fixtures in `test/fixtures/` (daggerheart
primary, tor2e secondary) with deterministic fake embeddings; live-Ollama tests
are skipped automatically when the backend isn't available.

## Status

CLI + MCP (phase 1) complete. Web UI on the Claude API is designed-for but not
built — see `docs/web-phase.md`.
