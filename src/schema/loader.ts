import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientSchema, type GraphQLSchema, type IntrospectionQuery } from "graphql";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SchemaCache {
  raw: IntrospectionQuery;
  schema: GraphQLSchema;
  types: IntrospectionType[];
  queries: IntrospectionField[];
  mutations: IntrospectionField[];
}

export interface IntrospectionType {
  name: string;
  kind: string;
  description?: string | null;
  fields?: IntrospectionField[] | null;
  inputFields?: IntrospectionInputField[] | null;
  enumValues?: IntrospectionEnumValue[] | null;
  interfaces?: IntrospectionTypeRef[] | null;
}

export interface IntrospectionField {
  name: string;
  description?: string | null;
  args?: IntrospectionArg[];
  type: IntrospectionTypeRef;
}

interface IntrospectionInputField {
  name: string;
  description?: string | null;
  type: IntrospectionTypeRef;
  defaultValue?: string | null;
}

interface IntrospectionEnumValue {
  name: string;
  description?: string | null;
}

interface IntrospectionArg {
  name: string;
  description?: string | null;
  type: IntrospectionTypeRef;
  defaultValue?: string | null;
}

interface IntrospectionTypeRef {
  kind: string;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
}

const cache = new Map<string, SchemaCache>();

function getSchemaPath(api: string): string {
  return join(__dirname, "..", "..", "data", `${api}.json`);
}

export function loadSchema(api: string): SchemaCache {
  const existing = cache.get(api);
  if (existing) return existing;

  const path = getSchemaPath(api);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { data: IntrospectionQuery };
  const introspection = raw.data;
  const schema = buildClientSchema(introspection);

  const schemaType = introspection.__schema;
  const allTypes = (schemaType.types as IntrospectionType[]).filter(
    (t) => !t.name.startsWith("__")
  );

  const queryTypeName = schemaType.queryType?.name ?? "Query";
  const mutationTypeName = schemaType.mutationType?.name ?? "Mutation";

  const queryType = allTypes.find((t) => t.name === queryTypeName);
  const mutationType = allTypes.find((t) => t.name === mutationTypeName);

  const result: SchemaCache = {
    raw: introspection,
    schema,
    types: allTypes.filter((t) => t.name !== queryTypeName && t.name !== mutationTypeName),
    queries: queryType?.fields ?? [],
    mutations: mutationType?.fields ?? [],
  };

  cache.set(api, result);
  return result;
}
