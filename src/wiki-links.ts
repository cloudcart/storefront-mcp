import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Links from schema names to the CloudCart platform wiki. `data/wiki-links.json` is curated by
 * hand: each link was read on its page, for a type, a root query or mutation, or a `Type.field`
 * that the page documents. The same file is in both CloudCart MCPs.
 */

/** A wiki page's address on GitHub; the map holds the page's path inside the wiki repository. */
export const WIKI_BASE_URL = "https://github.com/cloudcart/platform-wiki/blob/master/";
const MAX_PAGES = 3;

export interface WikiPage {
  title: string;
  path: string;
}

interface WikiLinks {
  wikiCommit?: string;
  links: Record<string, WikiPage[]>;
}

let cache: WikiLinks | null = null;

function load(): WikiLinks {
  if (cache) return cache;
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "wiki-links.json");
  // Without the map the answers carry no links.
  cache = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as WikiLinks) : { links: {} };
  return cache;
}

/** A wiki page as a Markdown link. */
export function wikiPageLink(page: WikiPage): string {
  return `[${page.title}](${WIKI_BASE_URL}${page.path})`;
}

/** The wiki pages that document a name — a type, a root query or mutation, or `Type.field` — at most three. */
export function wikiPages(name: string): WikiPage[] {
  return (load().links[name] ?? []).slice(0, MAX_PAGES);
}

/** `Wiki: [Title](url) · …` for a name the wiki documents, or "" when no page does. */
export function wikiLine(name: string): string {
  const pages = wikiPages(name);
  return pages.length ? `Wiki: ${pages.map(wikiPageLink).join(" · ")}` : "";
}
