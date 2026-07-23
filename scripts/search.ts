import "dotenv/config";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { Store } from "../src/core/store.js";
import { search } from "../src/core/retrieval.js";
import { dbPathFor, defaultProvider } from "../src/core/config.js";
import { getActiveCorpus } from "../src/core/session.js";
import type { SearchMode } from "../src/core/types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "hybrid" },
    k: { type: "string", default: "8" },
    corpus: { type: "string" },
  },
});

// Corpus resolution: --corpus flag > active selection > first positional.
// This lets `search.ts "<query>"` reuse the in-scope corpus (npm run use),
// while `search.ts <corpus> "<query>"` still works for ad-hoc lookups.
let corpus = values.corpus ?? getActiveCorpus().corpus ?? undefined;
let queryParts = positionals;
if (!corpus) {
  [corpus, ...queryParts] = positionals;
}
const query = queryParts.join(" ");
if (!corpus || !query) {
  console.error(
    'usage: search.ts [<corpus>] "<query>" [--corpus id] [--mode hybrid|keyword|vector] [--k N]\n' +
      "       (corpus defaults to the in-scope one set via `npm run use`)",
  );
  process.exit(2);
}

const dbPath = dbPathFor(corpus);
if (!existsSync(dbPath)) {
  console.error(`no index for "${corpus}" — run: npm run ingest -- --corpus ${corpus}`);
  process.exit(2);
}

const mode = values.mode as SearchMode;
const store = Store.open(dbPath, { readonly: true });
const res = await search(store, {
  query,
  k: Number(values.k),
  mode,
  provider: mode === "keyword" ? undefined : defaultProvider(),
});
store.close();

if (res.degradedToKeyword) console.error(`[degraded] ${res.note}`);
if (res.results.length === 0) {
  console.log("(no matches)");
} else {
  for (const [i, r] of res.results.entries()) {
    const tag = r.parent ? `${r.parent} › ${r.name}` : r.name;
    const src = r.sources.join(", ") || "—";
    console.log(
      `${String(i + 1).padStart(2)}. ${tag}  [${r.kind}]  score=${r.score.toFixed(4)}`,
    );
    console.log(`    sources: ${src}`);
    console.log(`    ${r.snippet}`);
  }
}
