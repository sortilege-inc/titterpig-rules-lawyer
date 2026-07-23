import { createHash } from "node:crypto";
import type { Chunk } from "./types.js";
import type { ResolvedIndex } from "./resolved.js";

/**
 * Extracts retrievable chunks from a canonically pretty-printed merged.ttrpg.
 *
 * Structure (verified against real synthesist output):
 *   BASE "edition" {                       depth 0 → 1
 *       ^"Name" DEF { ... }                depth-1 entity   → one chunk
 *       ACTOR "Name" DEF { ... }           depth-1 entity   → one chunk
 *       GAME_STRUCTURE { ... }             depth-1 block    → one chunk
 *   }
 *
 * Rules:
 *  - Every depth-1 block becomes a chunk. DEF/ACTOR/TEMPLATE → entity chunk;
 *    a bare UPPER_IDENT block (GAME_STRUCTURE, CONDITIONS, …) → 'block' chunk.
 *  - Nested DEFs inside a depth-1 *generic block* are additionally promoted to
 *    their own child chunk (parent = the block name). These are real lookup
 *    targets that resolved.json drops (e.g. "Adventuring Phase" in GAME_STRUCTURE).
 *  - Nested DEFs inside a depth-1 *entity* are NOT promoted — they are the
 *    entity's own typed sub-structure and stay within the entity's text.
 *
 * The scanner is character-level so it tracks string state across newlines
 * (multi-line string values occur) and treats `#` as a comment only outside
 * strings (the spec guarantees comments carry no tool-needed data).
 */

interface RawBlock {
  header: BlockHeader;
  /** byte offsets into source */
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  /** depth-1 generic blocks collect their promoted nested DEFs here */
  nested: RawBlock[];
}

interface BlockHeader {
  kind: Chunk["kind"];
  name: string;
  hashId: string | null;
}

const HEADER_RE =
  /(?:#(\S+)\s+)?(?:\^"((?:[^"\\]|\\.)*)"|(ACTOR|TEMPLATE)\s+"((?:[^"\\]|\\.)*)")\s+DEF\s*$/;
const GENERIC_RE = /^([A-Z][A-Z0-9_]*)\s*$/;

function classifyHeader(headerText: string): BlockHeader | null {
  const t = headerText.trimEnd();
  const def = HEADER_RE.exec(t);
  if (def) {
    const hashId = def[1] ?? null;
    if (def[2] !== undefined) {
      return { kind: "def", name: unescape(def[2]), hashId };
    }
    const actorKind = def[3] === "ACTOR" ? "actor" : "template";
    return { kind: actorKind, name: unescape(def[4]!), hashId };
  }
  const generic = GENERIC_RE.exec(t.trim());
  if (generic) return { kind: "block", name: generic[1]!, hashId: null };
  return null;
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** Pull ^"Name" / ^\"Name\" caret refs out of a text slice, deduped, order-preserving. */
export function extractRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\^\\?"((?:[^"\\]|\\.)*?)\\?"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = unescape(m[1]!);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Walk the source once, producing the raw block tree for depth-1 blocks (and,
 * for generic blocks, their nested DEFs). Returns depth-1 blocks in file order.
 */
function scan(src: string): RawBlock[] {
  const topLevel: RawBlock[] = [];
  let depth = 0;
  let inString = false;
  let inComment = false;
  let line = 1;

  // The header of a block is the text on the line up to its opening `{`.
  // We track the start offset of the current line and the offset of the last
  // `{`-owning line so we can recover the header when a block opens.
  let lineStartOffset = 0;

  // Stack of blocks currently open whose chunk boundaries we care about:
  // depth-1 blocks and (within a depth-1 generic block) nested DEF blocks.
  interface Open {
    block: RawBlock;
    /** brace depth at which this block's body lives (header depth + 1) */
    bodyDepth: number;
    /** true when this is a depth-1 generic block (promote nested DEFs) */
    promoteNested: boolean;
  }
  const open: Open[] = [];

  const lineNoAt = (offset: number): number => {
    // maintained incrementally via `line`; this helper exists for header lines
    return offset >= lineStartOffset ? line : line;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;

    if (ch === "\n") {
      inComment = false;
      line++;
      lineStartOffset = i + 1;
      continue;
    }

    if (inComment) continue;

    if (inString) {
      if (ch === "\\") {
        i++; // skip escaped char
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // not in string / comment
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "#") {
      // `#word` is an anchor token (e.g. #hashID, or a #ruleId: prefix), not a
      // comment. Only `#` followed by whitespace/punctuation starts a comment.
      const next = src[i + 1];
      if (next !== undefined && /[A-Za-z0-9_]/.test(next)) continue;
      inComment = true;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      inComment = true;
      i++;
      continue;
    }

    if (ch === "{") {
      const headerText = src.slice(lineStartOffset, i);
      const openingDepth = depth; // depth of the header line
      depth++;

      // depth-1 blocks: direct children of BASE (openingDepth === 1)
      if (openingDepth === 1) {
        const header = classifyHeader(headerText);
        if (header) {
          const block: RawBlock = {
            header,
            start: lineStartOffset,
            end: -1,
            lineStart: lineNoAt(lineStartOffset),
            lineEnd: -1,
            nested: [],
          };
          open.push({
            block,
            bodyDepth: depth,
            promoteNested: header.kind === "block",
          });
        }
      } else if (
        open.length > 0 &&
        open[open.length - 1]!.promoteNested &&
        openingDepth > open[open.length - 1]!.bodyDepth - 1
      ) {
        // Inside a depth-1 generic block: promote any nested DEF header.
        const header = classifyHeader(headerText);
        if (header && header.kind !== "block") {
          const parentTop = open[0]!.block;
          const block: RawBlock = {
            header,
            start: lineStartOffset,
            end: -1,
            lineStart: line,
            lineEnd: -1,
            nested: [],
          };
          parentTop.nested.push(block);
          open.push({ block, bodyDepth: depth, promoteNested: false });
        }
      }
      continue;
    }

    if (ch === "}") {
      depth--;
      const top = open[open.length - 1];
      if (top && depth === top.bodyDepth - 1) {
        top.block.end = i + 1;
        top.block.lineEnd = line;
        open.pop();
        if (open.length === 0) topLevel.push(top.block);
      }
      continue;
    }
  }

  return topLevel;
}

/** Strip full-line and trailing `#`/`//` comments outside strings, for embedding input. */
export function stripComments(text: string): string {
  const out: string[] = [];
  let inString = false;
  for (const rawLine of text.split("\n")) {
    let result = "";
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i]!;
      if (inString) {
        result += ch;
        if (ch === "\\") {
          if (i + 1 < rawLine.length) {
            result += rawLine[i + 1]!;
            i++;
          }
        } else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        result += ch;
        continue;
      }
      if (ch === "#") {
        const next = rawLine[i + 1];
        if (next !== undefined && /[A-Za-z0-9_]/.test(next)) {
          result += ch; // anchor token, keep it
          continue;
        }
        break; // comment to end of line
      }
      if (ch === "/" && rawLine[i + 1] === "/") break;
      result += ch;
    }
    const trimmed = result.replace(/\s+$/, "");
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out.join("\n");
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface ChunkOptions {
  corpusId: string;
  resolved: ResolvedIndex;
}

/**
 * Produce the final Chunk list. Entity chunks (depth-1 DEFs) get their metadata
 * from resolved.json by name; generic blocks and promoted nested DEFs carry no
 * JSON metadata (they are absent from resolved.json) and inherit the enclosing
 * top-level block's sources where available.
 */
export function chunk(src: string, opts: ChunkOptions): Chunk[] {
  const { corpusId, resolved } = opts;
  const blocks = scan(src);
  const chunks: Chunk[] = [];

  const build = (
    b: RawBlock,
    parent: string | null,
    inheritedSources: string[],
  ): Chunk => {
    const text = src.slice(b.start, b.end);
    const meta = parent === null ? resolved.byName.get(b.header.name) : undefined;
    const sources = meta?.sources ?? inheritedSources;
    const qualified = parent ? `${parent}::${b.header.name}` : b.header.name;
    return {
      id: sha256(`${corpusId}|${qualified}|${text}`),
      name: b.header.name,
      parent,
      kind: b.header.kind,
      extends: meta?.extends ?? null,
      hashId: b.header.hashId ?? meta?.hashId ?? null,
      sources,
      refs: extractRefs(text),
      text,
      lineStart: b.lineStart,
      lineEnd: b.lineEnd,
    };
  };

  for (const b of blocks) {
    const top = build(b, null, []);
    chunks.push(top);
    for (const child of b.nested) {
      chunks.push(build(child, b.header.name, top.sources));
    }
  }
  return chunks;
}
