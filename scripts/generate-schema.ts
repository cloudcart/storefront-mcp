/**
 * Build the Storefront GraphQL introspection JSON.
 *
 * Usage:
 *   SF_SCHEMA_DIR=/path/to/sf/schema npm run generate-schema
 *
 * Output: data/storefront.json
 *
 * The schema is assembled from the SDL files rather than fetched from a running
 * store. Those files are the source of truth — the server builds its schema
 * from exactly them — so this needs no store, no access token and no network.
 *
 * Point SF_SCHEMA_DIR at the files of the commit production runs, not at a
 * working copy: a developer's queries go to production, and a type that is
 * only on a branch validates here and fails there. There is no default for
 * that reason.
 *
 * Two things stand between the SDL and a schema graphql-js will build.
 *
 * The files use Lighthouse's `#import` comments to stitch themselves together,
 * which is a convention of the PHP server, not of GraphQL. And they carry
 * server-side directives — `@field(resolver:)`, `@rename`, `@scalar` — that say
 * how the server resolves a field and mean nothing to a client. Both are dealt
 * with here: imports are expanded, directives are dropped from the syntax tree
 * before the schema is built. What remains is what a client can actually see.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parse,
  visit,
  buildASTSchema,
  graphqlSync,
  getIntrospectionQuery,
  Kind,
  type DocumentNode,
} from "graphql";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.SF_SCHEMA_DIR) {
  console.error("Set SF_SCHEMA_DIR to the sf/schema directory of the commit production runs.");
  process.exit(1);
}

const schemaDir = resolve(process.env.SF_SCHEMA_DIR);

if (!existsSync(schemaDir)) {
  console.error(`Schema directory not found: ${schemaDir}`);
  process.exit(1);
}

/**
 * Expands Lighthouse's `#import <glob>` comments, depth-first, visiting each
 * file once — the same file is imported by more than one glob and a type may
 * only be declared once.
 */
function collect(entry: string, seen = new Set<string>()): string[] {
  const path = resolve(entry);

  if (seen.has(path)) return [];
  seen.add(path);

  const source = readFileSync(path, "utf-8");
  const parts: string[] = [];

  for (const line of source.split("\n")) {
    const match = line.match(/^#import\s+(.+?)\s*$/);

    if (!match) continue;

    const pattern = match[1];
    const dir = join(dirname(path), dirname(pattern));
    const base = pattern.split("/").pop() ?? pattern;

    if (!existsSync(dir)) {
      console.warn(`  skipped missing import: ${pattern}`);
      continue;
    }

    const matcher = new RegExp("^" + base.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");

    for (const file of readdirSync(dir).sort()) {
      if (matcher.test(file)) {
        parts.push(...collect(join(dir, file), seen));
      }
    }
  }

  parts.push(source.replace(/^#import\s+.+$/gm, ""));

  return parts;
}

console.log(`Reading ${schemaDir}`);
const sdl = collect(join(schemaDir, "schema.graphql")).join("\n\n");

let document: DocumentNode;

try {
  document = parse(sdl);
} catch (error) {
  console.error("The SDL does not parse:", (error as Error).message);
  process.exit(1);
}

// Server-side directives describe how a field is resolved. A client never sees
// them, and their definitions live in PHP, so building with them present would
// only fail.
const stripped = visit(document, {
  Directive: () => null,
  DirectiveDefinition: (node) =>
    // `@inContext` is part of the public contract — a client writes it.
    node.name.value === "inContext" ? node : null,
});

// `type Query` and `type Mutation` are declared without fields and filled in by
// `extend type` blocks across the schema. GraphQL has no such thing as an empty
// object type, so each gets a placeholder that is removed again below.
const STUB = "_placeholder";

const withStubs = visit(stripped, {
  ObjectTypeDefinition: (node) => {
    if (node.fields?.length) return node;

    return {
      ...node,
      fields: [
        {
          kind: Kind.FIELD_DEFINITION,
          name: { kind: Kind.NAME, value: STUB },
          arguments: [],
          type: { kind: Kind.NAMED_TYPE, name: { kind: Kind.NAME, value: "Boolean" } },
        },
      ],
    };
  },
});

let schema;

try {
  schema = buildASTSchema(withStubs, { assumeValidSDL: false });
} catch (error) {
  console.error("The schema does not build:", (error as Error).message);
  process.exit(1);
}

const result = graphqlSync({ schema, source: getIntrospectionQuery({ descriptions: true }) });

if (result.errors?.length) {
  console.error("Introspection failed:", result.errors.map((e) => e.message).join("\n"));
  process.exit(1);
}

const introspection = result.data as any;

// Take the placeholders back out so no consumer ever sees them offered.
for (const type of introspection.__schema.types) {
  if (Array.isArray(type.fields)) {
    type.fields = type.fields.filter((field: { name: string }) => field.name !== STUB);
  }
}

const outDir = join(__dirname, "..", "data");
mkdirSync(outDir, { recursive: true });

const outPath = join(outDir, "storefront.json");
writeFileSync(outPath, JSON.stringify({ data: introspection }, null, 0));

const types = introspection.__schema.types.filter((t: { name: string }) => !t.name.startsWith("__"));
const queries = types.find((t: { name: string }) => t.name === "Query")?.fields ?? [];
const mutations = types.find((t: { name: string }) => t.name === "Mutation")?.fields ?? [];

console.log(`Wrote ${outPath}`);
console.log(`  ${types.length} types, ${queries.length} queries, ${mutations.length} mutations`);
