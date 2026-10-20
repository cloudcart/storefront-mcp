# @cloudcart/storefront-mcp

An MCP server for the **CloudCart Storefront GraphQL API** — the headless API
Nitrogen storefronts, the mobile app and other clients are built on.

It is a developer's assistant, not a shop's. It runs on your machine, reads the
schema, and never talks to a store: no access token, no network, nothing that
could touch live data.

Its companion is [`@cloudcart/dev-mcp`](https://www.npmjs.com/package/@cloudcart/dev-mcp), which covers the **Admin**
API. The two APIs differ in more than scope — the Admin API uses plain numeric
ids, the Storefront API uses `gid://cloudcart/…` — so keep them apart.

## Tools

| Tool | What it is for |
|---|---|
| `learn_cloudcart_storefront` | **Call first.** The whole API — catalog, collections, search, content, cart, checkout, customers, orders, returns, analytics — and what the schema cannot tell you: how a signed-in buyer is sent (never an `Authorization` header), that a Nitrogen storefront's checkout is the store's own (`cart.checkoutUrl`), that the server owns every price and money is shown as `formatted`, that facets come back with the products, that a cart is addressed by an unguessable key. |
| `introspect_graphql_schema` | Look up a type, query or mutation by name. Flags fields that stay empty unless the merchant runs the app behind them. |
| `validate_graphql_codeblocks` | Check GraphQL before it ships — both against the schema and against the mistakes that validate cleanly and still fail. |

There is deliberately no semantic search. The surface is small enough to look
up by name — `data/storefront.json` holds every type, query and mutation — and
`learn_cloudcart_storefront` names the operation for each step; an embedding
index would add size and a cold start to solve a problem this API does not have.

## What the validator notes beyond schema errors

Things that pass validation and still go wrong:

- a **numeric cart id** — carts are addressed by their key, and a row number
  resolves to nothing
- reading **delivery before there is an address** — couriers price against a
  destination, so the list is empty
- reading `paymentMethods` **before delivery is chosen** — the courier decides
  part of what is allowed
- selecting `amount` **without `formatted`** — fine for logic, but a buyer is
  shown the amount as the store writes money
- a paged product list or search **without its facets** (`filters`,
  `productFilters`) or **without `totalCount`** — the API already computed them
- a `metafield` asked for **without its `namespace`** — the store has no
  app-reserved namespace, so a key alone finds nothing

It also answers names borrowed from other storefront APIs — `productByHandle`,
`checkoutCreate`, `cartDeliveryAddressesAdd`, `cartGiftCardCodesUpdate`,
`customerAccessTokenCreate` — each coming back with the CloudCart equivalent and
the reason it differs. Most of the
vocabulary is deliberately familiar; these are the places it is not.

## Install

```bash
npm install
npm run build
```

`data/storefront.json` is part of the package: building needs no schema.

## Regenerate the schema

`generate-schema` reads the SDL from the folder in `SF_SCHEMA_DIR`. Give it the
`sf/schema` files of the commit production runs, never a working copy: a
developer's queries go to production, and a type that exists only on a branch
would validate here and fail there. Export them from cc-builder:

```bash
mkdir -p /tmp/sf-deployed
git -C /path/to/cc-builder archive <deployed commit> sf/schema | tar -x -C /tmp/sf-deployed
SF_SCHEMA_DIR=/tmp/sf-deployed/sf/schema npm run generate-schema
```

The schema is assembled from those files rather than fetched from a running
store. They are what the server itself builds from — no store, no token, no
network.

## Use it

The CloudCart AI Toolkit plugin registers it. To add it to an MCP host yourself:

```json
{
  "mcpServers": {
    "cloudcart-storefront-mcp": {
      "command": "npx",
      "args": ["-y", "@cloudcart/storefront-mcp@latest"]
    }
  }
}
```

From a local build, the command is `node` with `/absolute/path/to/storefront-mcp/dist/index.js`.

## After a schema change is deployed

Export the deployed commit's `sf/schema` as above, then:

```bash
SF_SCHEMA_DIR=/tmp/sf-deployed/sf/schema npm run generate-schema && npm run build
```

The shipped schema comes from that step, so run it after every deploy that
changes `sf/schema`.

## Release

1. Regenerate the schema from the deployed commit (above), `npm run build`, and check the three tools.
2. Bump `version` in `package.json` (the server reads it from there), commit, push `main`; CI builds and checks the tools on Node 20, 22 and 24.
3. `gh release create vX.Y.Z` — the `Publish to npm` workflow checks the tag equals the version and publishes. It needs the repository secret `NPM_TOKEN`.

## Layout

```
scripts/generate-schema.ts   SDL in the repo → data/storefront.json
src/prompts/storefront.ts    what an assistant must know before writing anything
src/app-resources.ts         which fields depend on a merchant's installed apps
src/tools/                   the three tools
src/schema/loader.ts         reads and caches the introspection JSON
.github/workflows/           CI on every push; the npm release on a GitHub release
```
