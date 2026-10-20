#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { learnStorefrontApi } from "./tools/learn-storefront-api.js";
import { introspectSchema } from "./tools/introspect-schema.js";
import { validateGraphql } from "./tools/validate-graphql.js";

// The package's own version, so a release changes it in one place.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({
  name: "cloudcart-storefront-mcp",
  version,
});

server.tool(
  "learn_cloudcart_storefront",
  `Call this first, before anything else in this server.

It returns a conversationId that every other tool here requires, and — more
usefully — what the CloudCart Storefront API's schema does not show: how a
signed-in buyer is sent (an argument or @inContext(buyer:), never an
Authorization header), that a Nitrogen storefront's checkout is the store's own
(cart.checkoutUrl), that the server owns every price and money is shown as
\`formatted\`, and that a cart is addressed by an unguessable key.

Reading it first is the difference between a storefront that works and one that
charges the wrong total.`,
  {
    conversationId: z
      .string()
      .optional()
      .describe("An existing conversation id. Omit to start a new one."),
    model: z
      .string()
      .optional()
      .describe("Your model name or id (e.g. 'claude-opus-5'). Used to improve this documentation."),
  },
  async (input) => learnStorefrontApi(input),
);

server.tool(
  "introspect_graphql_schema",
  `Look up types, queries and mutations in the CloudCart Storefront schema by name.

Use this when you already know what something is called. When you know what you
want to do but not what it is called, read learn_cloudcart_storefront's guide
first — it names the operation for each step.

It searches the names of types, queries and mutations, not of fields: look up
the type that holds a field.

Results flag fields that only answer when the merchant runs the app behind them,
which is the usual explanation for an empty list.`,
  {
    query: z
      .string()
      .describe("Name or part of a name — 'Cart', 'cartLinesAdd', 'delivery', 'MoneyV2'."),
    filter: z
      .array(z.enum(["all", "types", "queries", "mutations"]))
      .optional()
      .default(["all"])
      .describe("Restrict the search to one category."),
    mode: z
      .enum(["full", "compact"])
      .optional()
      .default("full")
      .describe(
        "`full` expands the best match with all its fields. `compact` returns the summary line only — use it when you already have the signature and just want a sanity check.",
      ),
    conversationId: z.string().describe("From learn_cloudcart_storefront."),
    api: z.enum(["storefront"]).optional().default("storefront").describe("Which schema to search."),
  },
  async (input) => introspectSchema(input),
);

server.tool(
  "validate_graphql_codeblocks",
  `Check GraphQL against the Storefront schema before it reaches a browser.

Always run generated queries and mutations through this. The schema is large
and has many close names, and an invented field looks entirely plausible until
it fails.

Beyond schema validity it flags mistakes that validate cleanly and still fail at
runtime, such as a numeric cart id or reading delivery before the cart has an
address, and it answers names borrowed from other storefront APIs with the
CloudCart one.`,
  {
    codeblocks: z
      .array(
        z.object({
          content: z
            .string()
            .describe("Raw GraphQL — no markdown fences."),
          artifactId: z
            .string()
            .optional()
            .describe("Reuse the same id when revalidating a corrected version of the same block."),
          revision: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Starts at 1; increment on each retry of the same artifactId."),
        }),
      )
      .describe("The code blocks to check."),
    api: z.enum(["storefront"]).optional().default("storefront").describe("Which schema to validate against."),
    conversationId: z.string().describe("From learn_cloudcart_storefront."),
  },
  async (input) => validateGraphql(input),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
