# Web phase — design notes (not yet built)

Phase 1 (this repo) is CLI + MCP, with Claude Code as the answering engine. The
eventual web interface reuses the **same retrieval core** with the Claude API.
These are notes for that phase; no web code exists yet.

## The seam

Everything under `src/core/` is a plain library with **no MCP and no CLI
imports**. Both current front-ends are thin adapters over it:

- `src/mcp/build.ts` → wraps `core/retrieval.ts` in MCP tools.
- `scripts/*.ts` → wrap the same functions for the terminal.

A web server is a third adapter over the identical core. Do not fork retrieval
logic into it.

## Shape

```
core/retrieval.ts      ── shared, unchanged ──┐
core/store.ts                                 │
core/embeddings/*                             │
                                              ▼
  src/mcp/build.ts        src/web/server.ts (new)
  (Claude Code)           (Hono + @ai-sdk/anthropic)
```

- **HTTP server**: Hono is the light choice (`app.post('/ask')`). It calls the
  same `search` / `getEntity` / `getRelated` and streams an answer.
- **Answering loop**: `@ai-sdk/anthropic` with the four retrieval functions
  exposed as AI-SDK tools (mirror the MCP tool schemas 1:1). Use
  `.claude/skills/rules-lawyer/SKILL.md` **verbatim as the system prompt** — it
  already encodes the retrieve → read-full-text → reflect → cite-verbatim
  workflow, so the web answerer behaves like the Claude Code skill.
- **Model**: default to the current Sonnet (see the `claude-api` skill for live
  model ids); the answering task is retrieval-grounded, not heavy reasoning.
- **Corpus selection** is a required request parameter (same one-corpus-per-query
  rule). `list_corpora` becomes a `GET /corpora` for the UI's picker.

## Precedent to copy

`titterpig-mastra/src/mastra/claudeCliModel.ts` shows the AI-SDK v4 LanguageModel
shape used elsewhere in this project; the web answerer is the same idea but with
`@ai-sdk/anthropic` (API key) instead of the CLI backend.

## What NOT to change

- The SQLite index format and the embedding provider contract — the web server
  reads the exact same `data/index/<corpus>.db` files the CLI/MCP produce.
- The verbatim-quote rule. It lives in the skill/system-prompt, not in code, so
  it transfers for free.
