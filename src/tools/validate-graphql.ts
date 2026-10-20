import { randomUUID } from "node:crypto";
import {
  parse,
  print,
  validate,
  Kind,
  type DocumentNode,
  type GraphQLError,
  type GraphQLSchema,
} from "graphql";
import { loadSchema } from "../schema/loader.js";

interface Codeblock {
  content: string;
  artifactId?: string;
  revision?: number;
}

export interface ValidateInput {
  codeblocks: Codeblock[];
  conversationId: string;
  api?: string;
}

interface ValidationResult {
  artifactId: string;
  revision: number;
  status: "success" | "inform" | "failed";
  operationType: string;
  errors?: string[];
  warnings?: string[];
}

function formatGraphQLError(error: GraphQLError): string {
  const location = error.locations?.[0];

  return location ? `${error.message} (line ${location.line}, column ${location.column})` : error.message;
}

/**
 * Operations that do not exist here but are reached for anyway, and what to use
 * instead.
 *
 * Storefront APIs across the industry share most of their vocabulary, and this
 * one deliberately keeps the familiar names wherever they fit. What is listed
 * here is only where it genuinely parts company — and each entry says why,
 * because "use X instead" without a reason gets ignored.
 */
const UNKNOWN_OPERATIONS: Record<string, string> = {
  checkoutCreate:
    "there is no checkout object. A Nitrogen storefront sends the buyer to `cart.checkoutUrl`, the store's own checkout; a client with a checkout of its own completes the cart with `cartSubmitForCompletion`.",
  checkoutCompleteFree: "a Nitrogen storefront sends the buyer to `cart.checkoutUrl`; a client with its own checkout uses `cartSubmitForCompletion`.",
  checkoutCompleteWithTokenizedPaymentV3:
    "a Nitrogen storefront sends the buyer to `cart.checkoutUrl`; a client with its own checkout uses `cartSubmitForCompletion`.",
  checkoutShippingAddressUpdateV2: "use `cartDeliveryAddressUpdate`.",
  checkoutEmailUpdateV2: "use `cartBuyerIdentityUpdate`.",
  cartDeliveryAddressesAdd:
    "a cart holds exactly one delivery address. Use `cartDeliveryAddressUpdate` (singular).",
  cartDeliveryAddressesUpdate: "use `cartDeliveryAddressUpdate` (singular).",
  cartDeliveryAddressesRemove: "use `cartDeliveryAddressRemove` (singular).",
  cartSelectedDeliveryOptionsUpdate:
    "use `cartSelectedDeliveryOptionUpdate` (singular) — it takes one `optionHandle`.",
  cartGiftCardCodesUpdate: "the API has no gift cards. Discount codes go through `cartDiscountCodesUpdate`.",
  cartGiftCardCodesRemove: "the API has no gift cards.",
  customerAccessTokenCreate:
    "signing in is by emailed code: `customerLoginCodeSend`, then `customerLoginCodeVerify`. There is deliberately no password login.",
  customerRecover: "there is no password, so there is nothing to recover. Sign in with `customerLoginCodeSend`.",
  customerReset: "there is no password to reset.",
  customerActivate: "an account is usable as soon as `customerCreate` returns; there is no activation step.",
  productVariants: "variants are a field on a product: `product(handle:) { variants { … } }`.",
  collectionByHandle: "use `collection(handle:)`.",
  productByHandle: "use `product(handle:)`.",
  // Until the metafields and metaobjects of the platform are deployed to sf: then
  // the schema has them, and these two entries go.
  metaobject: "there are no metaobjects. Category property values are on `product.properties`.",
  metaobjects: "there are no metaobjects. Category property values are on `product.properties`.",
};

/**
 * Fields that are commonly assumed to exist, and their counterpart here.
 */
const UNKNOWN_FIELDS: Record<string, string> = {
  "Cart.checkoutChargeAmount": "use `cost { totalAmount }`",
  "CartLine.attributes":
    "use `options`: the customizations chosen for the line. `product.customizations` says what a product accepts",
  "Product.metafields": "use `properties` for category property values; the `productMetafield` filter finds products by them",
  "Customer.lastIncompleteCheckout": "there is no such link; keep the cart id in your own client",
  "Order.fulfillments": "use `fulfillment`",
  "SearchResultItemConnection.filters": "a search's facets are `productFilters`",
};

function hintForError(message: string): string | null {
  const unknownField = message.match(/Cannot query field "(\w+)" on type "(\w+)"/);

  if (unknownField) {
    const [, field, parent] = unknownField;

    // A borrowed name is worth answering outright, whether it was reached for
    // on the Query or the Mutation root.
    if ((parent === "Query" || parent === "Mutation") && UNKNOWN_OPERATIONS[field]) {
      return `\`${field}\` does not exist — ${UNKNOWN_OPERATIONS[field]}`;
    }

    const key = `${parent}.${field}`;

    if (UNKNOWN_FIELDS[key]) {
      return `\`${key}\` does not exist — ${UNKNOWN_FIELDS[key]}.`;
    }

    if (parent === "Mutation" || parent === "Query") {
      return `Search for the right name with \`introspect_graphql_schema\` before guessing — several operations have close names.`;
    }
  }

  if (/Unknown argument "shop"|Cannot query field "shop" on type "Query"/.test(message)) {
    return null;
  }

  if (/Expected value of type "ID!"/.test(message) && /cartId/.test(message)) {
    return "A cart id is `gid://cloudcart/Cart/<key>`, where the key is the long random string returned by `cartCreate`. It is not a row number.";
  }

  return null;
}

/**
 * Checks that pass validation but are known to be wrong at runtime. Each one is
 * a note, not an error: the document may be right for what it does.
 */
function runtimeHints(query: string): string[] {
  const hints: string[] = [];

  // A numeric cart id is the single most common mistake: it looks plausible,
  // validates fine, and always resolves to nothing.
  const numericCart = query.match(/gid:\/\/cloudcart\/Cart\/(\d+)\b/);

  if (numericCart) {
    hints.push(
      `\`gid://cloudcart/Cart/${numericCart[1]}\` will not resolve. A cart is addressed by its key — the long random string in the \`id\` returned by \`cartCreate\` — not by a row number.`,
    );
  }

  // `amount` is right for logic and analytics; shown to a buyer it is not how
  // the store writes money.
  if (/\bformatted\b/.test(query) === false && /\bamount\b/.test(query)) {
    hints.push(
      "Selecting `amount` without `formatted`: fine for logic or analytics, but show a buyer `formatted` — the amount as the store writes money. Formatting `amount` yourself can show a different text than the store's.",
    );
  }

  // Delivery without an address returns nothing, every time.
  if (/\bcarriers\b/.test(query) && !/deliveryAddress|addressId|pickupPointId|storeId/.test(query)) {
    hints.push(
      "Delivery is priced against a destination — `carriers` is empty until the cart has a delivery address. Call `cartDeliveryAddressUpdate` first.",
    );
  }

  // Payment methods are filtered by the chosen courier.
  if (/\bpaymentMethods\b/.test(query) && !/selectedDeliveryOption|deliveryAddress/.test(query)) {
    hints.push(
      "`paymentMethods` is empty until a shippable cart has a delivery service chosen: the courier decides part of what is allowed. Read it after selecting delivery, and again if delivery changes.",
    );
  }

  // A listing page that pages through products usually wants the facets and the
  // count the search engine already computed for it.
  if (/\bpageInfo\b/.test(query)) {
    if (/\bproducts\s*\(/.test(query) && !/\bfilters\b/.test(query)) {
      hints.push(
        "A paged `products` list without `filters`: if the page has a facet sidebar, the connection already returns its facets for this result set — build the sidebar from them instead of hardcoding facets.",
      );
    }

    if (/\bsearch\s*\(/.test(query) && !/\bproductFilters\b/.test(query)) {
      hints.push(
        "A paged `search` without `productFilters`: if the page has a facet sidebar, the search already returns its facets as `productFilters`.",
      );
    }

    if (/\bproducts\s*\(/.test(query) && !/\btotalCount\b/.test(query)) {
      hints.push(
        "`ProductConnection.totalCount` gives the real total for the current query and filters — worth selecting alongside `pageInfo` if the UI shows a count.",
      );
    }
  }

  return hints;
}

function detectOperationType(document: DocumentNode): string {
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      return definition.operation;
    }
  }

  return "query";
}

function findDeprecated(schema: GraphQLSchema, document: DocumentNode): string[] {
  const found: string[] = [];
  const types = schema.getTypeMap();

  for (const type of Object.values(types)) {
    const fields = (type as any).getFields?.();

    if (!fields) continue;

    for (const field of Object.values(fields) as any[]) {
      if (!field.deprecationReason) continue;

      const pattern = new RegExp(`\\b${field.name}\\b`);

      if (pattern.test(document.loc?.source.body ?? "")) {
        found.push(`\`${(type as any).name}.${field.name}\` is deprecated: ${field.deprecationReason}`);
      }
    }
  }

  return found;
}

export function validateGraphql(input: ValidateInput) {
  const api = input.api ?? "storefront";

  let schema;

  try {
    schema = loadSchema(api);
  } catch (error: any) {
    return {
      content: [{ type: "text" as const, text: `Failed to load the ${api} schema: ${error.message}` }],
    };
  }

  const results: ValidationResult[] = [];

  for (const block of input.codeblocks) {
    const result: ValidationResult = {
      artifactId: block.artifactId ?? `artifact-${randomUUID()}`,
      revision: block.revision ?? 1,
      status: "failed",
      operationType: "query",
    };

    try {
      const document = parse(block.content);
      result.operationType = detectOperationType(document);

      const errors = validate(schema.schema, document);

      if (errors.length === 0) {
        // The printed document has no comments, so a word in a comment never
        // triggers a note.
        const warnings = [...findDeprecated(schema.schema, document), ...runtimeHints(print(document))];

        result.status = warnings.length > 0 ? "inform" : "success";

        if (warnings.length > 0) result.warnings = warnings;
      } else {
        result.errors = errors.map(formatGraphQLError);
      }
    } catch (error: any) {
      result.errors = [error.message];
    }

    results.push(result);
  }

  const allValid = results.every((r) => r.status !== "failed");

  const lines: string[] = [
    "## Validation Summary\n",
    `**Overall Status:** ${allValid ? "✅ VALID" : "❌ INVALID"}`,
    `**Total Code Blocks:** ${results.length}\n`,
    "## Detailed Results\n",
  ];

  results.forEach((result, index) => {
    lines.push(`### Code Block ${index + 1}`);
    lines.push(`**Artifact ID:** ${result.artifactId}`);
    lines.push(`**Revision:** ${result.revision}`);
    lines.push("*Reuse this id and increment the revision when retrying the same code block.*\n");

    if (result.status === "success") {
      lines.push("**Status:** ✅ SUCCESS");
      lines.push(`**Details:** The ${result.operationType} validates against the Storefront schema.\n`);
    } else if (result.status === "inform") {
      lines.push("**Status:** ⚠️ INFORM");
      lines.push(`**Details:** The ${result.operationType} validates against the Storefront schema.`);

      for (const warning of result.warnings ?? []) {
        lines.push(`> NOTE: ${warning}`);
      }

      lines.push("");
    } else {
      lines.push("**Status:** ❌ FAILED");
      lines.push(`**Details:** ${result.errors!.join("; ")}`);

      for (const error of result.errors ?? []) {
        const hint = hintForError(error);

        if (hint) lines.push(`> HINT: ${hint}`);
      }

      lines.push("");
    }
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
