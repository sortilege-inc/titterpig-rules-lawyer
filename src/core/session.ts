import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { REPO_ROOT } from "./config.js";

/**
 * Session scope: the one corpus that is currently "in scope". Query tools
 * (search_rules / get_entity / get_related) operate ONLY on this corpus, so a
 * user can `cd` into a single synthesist output and never accidentally pull in
 * another book's rules.
 *
 * Precedence:
 *   1. RULES_LAWYER_CORPUS env var — pins the session, immutable, no bleed
 *      across concurrent sessions (launch: `RULES_LAWYER_CORPUS=id claude`).
 *   2. data/active-corpus.json — the persisted selection set via select_corpus
 *      (MCP) or `npm run use` (CLI). Shared by all sessions in this repo.
 *   3. none — query tools refuse until a corpus is selected.
 */
export const ACTIVE_CORPUS_PATH = resolve(
  REPO_ROOT,
  "data",
  "active-corpus.json",
);

/** Env pin, read once at load; wins over the state file for this process. */
export const PINNED_CORPUS = process.env.RULES_LAWYER_CORPUS?.trim() || undefined;

export interface ActiveCorpus {
  /** The in-scope corpus id, or null if none is selected. */
  corpus: string | null;
  /** True when fixed by RULES_LAWYER_CORPUS and not changeable this session. */
  pinned: boolean;
}

export function getActiveCorpus(
  statePath: string = ACTIVE_CORPUS_PATH,
): ActiveCorpus {
  if (PINNED_CORPUS) return { corpus: PINNED_CORPUS, pinned: true };
  if (!existsSync(statePath)) return { corpus: null, pinned: false };
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      corpus?: string | null;
    };
    return { corpus: raw.corpus ?? null, pinned: false };
  } catch {
    return { corpus: null, pinned: false };
  }
}

/**
 * Persist the selection. When the session is env-pinned this is a no-op that
 * returns the pinned value, so callers can report "can't switch — pinned".
 */
export function setActiveCorpus(
  corpus: string,
  statePath: string = ACTIVE_CORPUS_PATH,
): ActiveCorpus {
  if (PINNED_CORPUS) return { corpus: PINNED_CORPUS, pinned: true };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ corpus }, null, 2) + "\n");
  return { corpus, pinned: false };
}

export function clearActiveCorpus(
  statePath: string = ACTIVE_CORPUS_PATH,
): ActiveCorpus {
  if (PINNED_CORPUS) return { corpus: PINNED_CORPUS, pinned: true };
  if (existsSync(statePath)) {
    writeFileSync(statePath, JSON.stringify({ corpus: null }, null, 2) + "\n");
  }
  return { corpus: null, pinned: false };
}
