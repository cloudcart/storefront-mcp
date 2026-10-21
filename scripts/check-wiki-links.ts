/**
 * Checks data/wiki-links.json, the hand-curated links from schema names to the platform wiki,
 * against a clean checkout of the wiki at the commit the map names. It decides no link: it fails
 * when a name is not in this package's schema (a type, a root query or mutation, or `Type.field`),
 * a page is missing or its title is not the page's own, or a name has more than three pages.
 * The same file is in both CloudCart MCPs.
 *
 *   npm run check-wiki-links -- --wiki <a clean checkout of cloudcart/platform-wiki>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PAGES = 3;

interface TypeRef {
  kind: string;
  name?: string | null;
}
interface IntrospectionType {
  name: string;
  fields?: Array<{ name: string }> | null;
  inputFields?: Array<{ name: string }> | null;
}
interface WikiLinks {
  wikiCommit: string;
  links: Record<string, Array<{ title: string; path: string }>>;
}

/** Every name a link may hang on: types, root queries and mutations, and `Type.field`. */
function schemaNames(): Set<string> {
  const schemaFile = readdirSync(join(ROOT, "data")).find((file) => file === "admin.json" || file === "storefront.json");
  if (!schemaFile) throw new Error("No data/admin.json or data/storefront.json");
  const raw = JSON.parse(readFileSync(join(ROOT, "data", schemaFile), "utf8"));
  const schema = (raw.data ?? raw).__schema as {
    queryType: TypeRef;
    mutationType?: TypeRef | null;
    types: IntrospectionType[];
  };
  const roots = new Set([schema.queryType.name, schema.mutationType?.name].filter(Boolean));
  const names = new Set<string>();
  for (const type of schema.types) {
    if (type.name.startsWith("__")) continue;
    const fields = [...(type.fields ?? []), ...(type.inputFields ?? [])];
    if (roots.has(type.name)) {
      for (const field of fields) names.add(field.name);
      continue;
    }
    names.add(type.name);
    for (const field of fields) names.add(`${type.name}.${field.name}`);
  }
  return names;
}

function main(): void {
  const wikiAt = process.argv.indexOf("--wiki");
  const wiki = wikiAt >= 0 ? process.argv[wikiAt + 1] : undefined;
  if (!wiki) {
    console.error("Pass --wiki <a clean checkout of cloudcart/platform-wiki>.");
    process.exit(1);
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", wiki, ...args], { encoding: "utf8" }).trim();
  const map = JSON.parse(readFileSync(join(ROOT, "data", "wiki-links.json"), "utf8")) as WikiLinks;
  const problems: string[] = [];
  if (git("status", "--porcelain")) problems.push(`${wiki} has uncommitted changes`);
  if (git("rev-parse", "HEAD") !== map.wikiCommit) problems.push(`the wiki checkout is not at ${map.wikiCommit}`);

  const names = schemaNames();
  let pages = 0;
  for (const [name, links] of Object.entries(map.links)) {
    if (!names.has(name)) problems.push(`${name}: not in the schema`);
    if (links.length === 0 || links.length > MAX_PAGES) problems.push(`${name}: ${links.length} pages (1 to ${MAX_PAGES})`);
    if (new Set(links.map((link) => link.path)).size !== links.length) problems.push(`${name}: a page twice`);
    for (const link of links) {
      pages++;
      const file = join(wiki, link.path);
      if (!link.path.startsWith("wiki/") || !existsSync(file)) {
        problems.push(`${name}: ${link.path} does not exist`);
        continue;
      }
      const title = readFileSync(file, "utf8").match(/^# (.+)$/m)?.[1].trim();
      if (title !== link.title) problems.push(`${name}: "${link.title}" is not the title of ${link.path} ("${title}")`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`${Object.keys(map.links).length} names, ${pages} links, all checked against wiki ${map.wikiCommit.slice(0, 7)}.`);
}

main();
