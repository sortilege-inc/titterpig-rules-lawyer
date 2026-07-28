import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Schema for titterpig-synthesist's `*.resolved.json` (see synthesist
 * internal/emit/json.go). We only model the fields the rules-lawyer joins on;
 * `.passthrough()` keeps forward-compat with new emitter fields.
 */
const PropertySchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({}).passthrough(),
);

export const ResolvedEntitySchema = z
  .object({
    name: z.string().optional(),
    hash: z.string().optional(),
    kind: z.string(),
    extends: z.string().optional(),
    applies_to: z.array(z.string()).optional(),
    properties: z.array(PropertySchema).optional(),
    rules: z.array(z.unknown()).optional(),
    sources: z.array(z.string()).optional(),
  })
  .passthrough();
export type ResolvedEntity = z.infer<typeof ResolvedEntitySchema>;

export const ResolvedDocumentSchema = z
  .object({
    edition: z.string(),
    spec_version: z.string().optional().default(""),
    entity_count: z.number().optional(),
    entities: z.array(ResolvedEntitySchema),
  })
  .passthrough();
export type ResolvedDocument = z.infer<typeof ResolvedDocumentSchema>;

/** Metadata for one entity, keyed by name, for joining onto chunker output. */
export interface EntityMeta {
  kind: string;
  extends: string | null;
  hashId: string | null;
  sources: string[];
}

export interface ResolvedIndex {
  edition: string;
  specVersion: string;
  entityCount: number;
  /** name → metadata */
  byName: Map<string, EntityMeta>;
}

export function parseResolved(json: string): ResolvedDocument {
  return ResolvedDocumentSchema.parse(JSON.parse(json));
}

/**
 * Strip DSL string escaping (`\"` → `"`), matching how the chunker unescapes
 * names captured from `^"…"` headers. synthesist's resolved.json keeps the
 * DSL escaping in names (e.g. arm5e's `Intellego (In) \"I Perceive\"`), so both
 * sides must be normalized the same way or the metadata join silently misses.
 */
function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

export function loadResolved(path: string): ResolvedIndex {
  const doc = parseResolved(readFileSync(path, "utf8"));
  const byName = new Map<string, EntityMeta>();
  for (const e of doc.entities) {
    if (!e.name) continue;
    byName.set(unescape(e.name), {
      kind: e.kind,
      extends: e.extends ? unescape(e.extends) : null,
      hashId: e.hash ?? null,
      sources: e.sources ?? [],
    });
  }
  return {
    edition: doc.edition,
    specVersion: doc.spec_version ?? "",
    entityCount: doc.entity_count ?? doc.entities.length,
    byName,
  };
}
