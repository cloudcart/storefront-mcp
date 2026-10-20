import { loadSchema } from "../schema/loader.js";
import { matchAppResourceGroup, APP_KEY_NOTICE_GROUP, type AppResourceGroup } from "../app-resources.js";

type FilterKind = "all" | "types" | "queries" | "mutations";
type Mode = "full" | "compact";

export interface IntrospectInput {
  query: string;
  filter?: FilterKind[];
  conversationId: string;
  api?: string;
  mode?: Mode;
}

function resolveTypeRef(typeRef: { kind: string; name?: string | null; ofType?: any }): string {
  if (typeRef.kind === "NON_NULL") {
    return `${resolveTypeRef(typeRef.ofType)}!`;
  }
  if (typeRef.kind === "LIST") {
    return `[${resolveTypeRef(typeRef.ofType)}]`;
  }
  return typeRef.name ?? "Unknown";
}

function signatureFor(field: { name: string; args?: any[]; type: any }): string {
  let sig = field.name;
  if (field.args && field.args.length > 0) {
    const argStr = field.args
      .map((a: any) => {
        let s = `${a.name}: ${resolveTypeRef(a.type)}`;
        if (a.defaultValue != null) s += ` = ${a.defaultValue}`;
        return s;
      })
      .join(", ");
    sig += `(${argStr})`;
  }
  sig += `: ${resolveTypeRef(field.type)}`;
  return sig;
}

/** Compact one-line field: `name: Type  # description` (or just signature if no desc). */
function formatField(field: { name: string; description?: string | null; args?: any[]; type: any }): string {
  const sig = signatureFor(field);
  return field.description ? `${sig}  # ${field.description}` : sig;
}

/** Ultra-compact: `name → ReturnType  # description`, no args. For compact mode listings. */
function formatFieldCompact(field: { name: string; description?: string | null; type: any }): string {
  const ret = resolveTypeRef(field.type);
  const line = `${field.name} → ${ret}`;
  return field.description ? `${line}  # ${field.description}` : line;
}

const MAX_FIELDS_PER_TYPE = 20;

/** Root types known to have been consolidated into grouped sub-types. */
const GROUPED_PARENT_HINTS: Record<string, string> = {
  Cart: "cost/totals/lines/delivery/paymentMethods/messages/attributes",
  CheckoutSettings: "fields/registration/limits/delivery/maps/legal/customFields",
  CartLine: "cost/options/discountAllocations/warnings/unit/bundle",
};

/** True if a type looks like a Relay connection that exposes the flat `nodes` + `totalCount` alternative. */
function hasFlatNodesShape(type: { name: string; fields?: any[] | null }): boolean {
  if (!type.name.endsWith("Connection")) return false;
  const fieldNames = new Set((type.fields ?? []).map((f: any) => f.name));
  return fieldNames.has("nodes") && fieldNames.has("totalCount");
}

/** Collect contextual hints specific to this type (nodes preference, grouped sub-types). */
function hintsForType(type: { name: string; kind: string; fields?: any[] | null }): string[] {
  const hints: string[] = [];
  if (hasFlatNodesShape(type)) {
    hints.push("> TIP: prefer `{ nodes { ... } totalCount }` unless you need cursor pagination (~2× smaller payload).");
  }
  const grouped = GROUPED_PARENT_HINTS[type.name];
  if (grouped) {
    hints.push(`> TIP: ${type.name} fields live in grouped sub-types — ${grouped}.`);
  }
  return hints;
}

/** One-line type summary: `KIND Name  # Description`. No field body. */
function formatTypeSummary(type: { name: string; kind: string; description?: string | null }): string {
  return type.description ? `${type.kind} ${type.name}  # ${type.description}` : `${type.kind} ${type.name}`;
}

function formatType(type: {
  name: string;
  kind: string;
  description?: string | null;
  fields?: any[] | null;
  inputFields?: any[] | null;
  enumValues?: any[] | null;
  interfaces?: any[] | null;
}): string {
  const lines: string[] = [formatTypeSummary(type)];

  if (type.interfaces && type.interfaces.length > 0) {
    const ifaceNames = type.interfaces.map((i: any) => i.name ?? resolveTypeRef(i)).filter(Boolean);
    if (ifaceNames.length > 0) lines.push(`  implements ${ifaceNames.join(", ")}`);
  }

  if (type.fields && type.fields.length > 0) {
    const shown = type.fields.slice(0, MAX_FIELDS_PER_TYPE);
    for (const f of shown) {
      lines.push(`  ${formatField(f)}`);
    }
    if (type.fields.length > MAX_FIELDS_PER_TYPE) {
      // Expose the remaining field names + types (no descriptions) — critical
      // fields like `Product.customizations` must stay discoverable rather than
      // being hidden behind a "... +N more fields" truncation.
      const rest = type.fields.slice(MAX_FIELDS_PER_TYPE);
      const sigs = rest.map((f: any) => signatureFor(f));
      lines.push(`  # +${rest.length} more: ${sigs.join(", ")}`);
    }
  }

  if (type.inputFields && type.inputFields.length > 0) {
    const shown = type.inputFields.slice(0, MAX_FIELDS_PER_TYPE);
    for (const f of shown) {
      const sig = `${f.name}: ${resolveTypeRef(f.type)}`;
      lines.push(`  ${f.description ? `${sig}  # ${f.description}` : sig}`);
    }
    if (type.inputFields.length > MAX_FIELDS_PER_TYPE) {
      const rest = type.inputFields.slice(MAX_FIELDS_PER_TYPE);
      const sigs = rest.map((f: any) => `${f.name}: ${resolveTypeRef(f.type)}`);
      lines.push(`  # +${rest.length} more: ${sigs.join(", ")}`);
    }
  }

  if (type.enumValues && type.enumValues.length > 0) {
    for (const v of type.enumValues) {
      lines.push(`  ${v.name}${v.description ? `  # ${v.description}` : ""}`);
    }
  }

  return lines.join("\n");
}

const RESULTS_LIMIT = 10;

function formatAppNotice(group: AppResourceGroup): string {
  return `> ⚠️ ${group.label} (Application-Provided) — ${group.notice}`;
}

export function introspectSchema(input: IntrospectInput) {
  const api = input.api ?? "storefront";
  const filters = input.filter ?? ["all"];
  const includeAll = filters.includes("all");
  const mode: Mode = input.mode ?? "full";

  // Reject empty/whitespace-only queries — returning a random top-10 slice
  // (1 500+ tokens) helps nobody. Nudge the caller to provide a term.
  const rawQuery = input.query?.trim() ?? "";
  if (rawQuery === "") {
    return {
      content: [{
        type: "text" as const,
        text: `Provide a search term (e.g. "product", "cartCreate", "discount"). Empty queries are rejected to avoid flooding your context with arbitrary results.`,
      }],
    };
  }

  let schema;
  try {
    schema = loadSchema(api);
  } catch (e: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to load schema for "${api}": ${e.message}` }],
    };
  }

  // Normalize query: lowercase, strip whitespace, drop trailing 's' so
  // "categories" and "category" both match CategoryConnection / Category.
  let normalized = rawQuery.toLowerCase().replace(/\s+/g, "");
  if (normalized.endsWith("s") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }

  const sections: string[] = [];
  // Dedup app notices across the whole response — a grouped speedy hit in
  // Types + Queries + Mutations should only emit one banner.
  const shownAppNotices = new Set<string>();
  let anyTruncated = false;

  const renderAppPrefix = (name: string, field?: { args?: Array<{ name: string }> }): string => {
    // A resource is app-provided if its name carries a vendor token, OR it is an
    // operation that takes a `key` (app-key) parameter. Core resources (no vendor
    // token, no key) are never flagged — so built-in features like campaigns,
    // payment/shipping statuses, order-shipping data and addresses no longer get
    // a spurious "install the app" notice.
    let appGroup = matchAppResourceGroup(name);
    if (!appGroup && field?.args?.some((a) => a.name === "key")) {
      appGroup = APP_KEY_NOTICE_GROUP;
    }
    if (!appGroup || shownAppNotices.has(appGroup.group)) return "";
    shownAppNotices.add(appGroup.group);
    return formatAppNotice(appGroup) + "\n";
  };

  if (includeAll || filters.includes("types")) {
    const all = schema.types.filter((t) => t.name.toLowerCase().includes(normalized));
    const matched = all.sort((a, b) => a.name.length - b.name.length).slice(0, RESULTS_LIMIT);
    if (all.length > RESULTS_LIMIT) anyTruncated = true;
    if (matched.length > 0) {
      // When multiple types match, only expand the top hit with full fields.
      // The rest are 1-line summaries — the agent can follow up with a
      // specific introspect(query: "ExactName") if they need details.
      // Exact-name hits always get full detail regardless of result count.
      const lines: string[] = ["## Types"];
      const emittedHints: string[] = [];
      matched.forEach((t, i) => {
        const exactHit = t.name.toLowerCase() === normalized || t.name.toLowerCase() === rawQuery.toLowerCase();
        const expand = i === 0 || exactHit || matched.length === 1;
        // Compact mode suppresses full field listings — only the summary
        // line (`KIND Name  # description`) plus any grouped sub-type
        // hint is emitted. Typical saving for a fat type like Product:
        // ~1 500 tokens down to ~120.
        //
        // EXCEPTION: INPUT_OBJECT types are always expanded even in
        // compact mode — their sole purpose is to show the input fields
        // the agent must fill, so summarising them to a single line would
        // force a second introspect call with `mode: full`. No tokens
        // saved, worse UX. ENUM values are equally essential on exact
        // hits, so we expand those too.
        const essentialExpand = expand && (t.kind === "INPUT_OBJECT" || t.kind === "ENUM");
        const body = (expand && mode === "full") || essentialExpand
          ? formatType(t)
          : formatTypeSummary(t);
        lines.push(renderAppPrefix(t.name) + body);
        if (expand) emittedHints.push(...hintsForType(t));
      });
      // Per-type hints (nodes/totalCount, grouped sub-types) — dedup.
      const uniqueHints = Array.from(new Set(emittedHints));
      uniqueHints.forEach((h) => lines.push(h));
      if (matched.length > 1 && !matched.every((t, i) => i === 0 || t.name.toLowerCase() === rawQuery.toLowerCase())) {
        lines.push(`> Only the top match is expanded. For full fields on others, re-run with the exact type name.`);
      }
      sections.push(lines.join("\n\n"));
    }
  }

  if (includeAll || filters.includes("queries")) {
    const all = schema.queries.filter((q) => q.name.toLowerCase().includes(normalized));
    const matched = all.sort((a, b) => a.name.length - b.name.length).slice(0, RESULTS_LIMIT);
    if (all.length > RESULTS_LIMIT) anyTruncated = true;
    if (matched.length > 0) {
      const fmt = mode === "compact" ? formatFieldCompact : formatField;
      sections.push(
        `## Queries\n` +
        matched.map((f) => renderAppPrefix(f.name, f) + fmt(f)).join("\n")
      );
    }
  }

  if (includeAll || filters.includes("mutations")) {
    const all = schema.mutations.filter((m) => m.name.toLowerCase().includes(normalized));
    const matched = all.sort((a, b) => a.name.length - b.name.length).slice(0, RESULTS_LIMIT);
    if (all.length > RESULTS_LIMIT) anyTruncated = true;
    if (matched.length > 0) {
      const fmt = mode === "compact" ? formatFieldCompact : formatField;
      sections.push(
        `## Mutations\n` +
        matched.map((f) => renderAppPrefix(f.name, f) + fmt(f)).join("\n")
      );
    }
  }

  if (sections.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No results for "${input.query}" in the ${api} API. Try a broader term or a different word stem.`,
      }],
    };
  }

  const header = anyTruncated
    ? `> Some sections hit the ${RESULTS_LIMIT}-item cap; refine your term for more specific results.\n\n`
    : "";

  const footer = `\n\n> NEXT: pass your drafted query to validate_graphql_codeblocks before executing — it catches typos, wrong types, and deprecated fields.`;

  return {
    content: [{ type: "text" as const, text: header + sections.join("\n\n") + footer }],
  };
}
