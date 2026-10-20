/**
 * What an assistant needs to know before writing against the Storefront API.
 *
 * Not a feature list — the schema carries one, and every type and field in it is
 * documented. This is the set of things a competent developer gets wrong on the
 * first attempt, because they follow from how the platform works rather than
 * from how the schema looks.
 *
 * Organised by what you are building, since almost nobody builds all of it at
 * once. Every claim here was checked against the deployed schema and the code
 * behind it; check again when either changes.
 */

export const STOREFRONT_GUIDE = `
# CloudCart Storefront API

\`POST /api/sf\` — one GraphQL endpoint for the whole storefront: catalog,
collections, search, content, metafields and metaobjects, cart, checkout,
customer accounts, orders and returns. One schema serves every client: Nitrogen
storefronts, the mobile app and others.

## On a Nitrogen storefront

Nitrogen is CloudCart's framework for headless storefronts, and it sends the
requests: you write \`#graphql\` documents, not headers.

- The storefront's tokens and the buyer's IP go from the storefront's server.
  The browser reaches the API only through the storefront's \`/api/sf\` proxy.
- The signed-in buyer's access token stays in the storefront's signed session
  cookie. A document that should run for that buyer declares
  \`$buyer: BuyerInput\` and \`@inContext(buyer: $buyer)\`, and the storefront
  passes the buyer it read from the session.
- The checkout is the platform's: send the buyer to \`cart.checkoutUrl\`. An
  order placed on the page itself — a product's one-step order — is
  \`fastOrderSubmit\`. The API's own checkout steps below are for a client that
  runs its own checkout, such as a mobile app.

The \`cloudcart-nitrogen\` skill shows the code for each.

## Authentication

The storefront's access token goes in \`X-Storefront-Access-Token\`. It names the
store, so no operation takes a store argument.

A signed-in buyer is sent in one of two ways — **never in an \`Authorization\`
header**:

- \`customerAccessToken\` — the argument of \`customer\`, \`order\` and every
  customer mutation; they always take it, \`@inContext\` does not replace it. An invalid or expired token gives \`null\` from a query and a
  \`TOKEN_INVALID\` error from a mutation.
- \`@inContext(buyer: {customerAccessToken: …})\` on the operation — the whole
  operation runs for that buyer: their customer group's prices and discounts,
  and the buyer of a fast order and of the store's forms. An invalid or expired
  token is ignored and the operation runs as a guest. It does not give a cart an
  owner: \`buyerIdentity.customerAccessToken\` on \`cartCreate\` or
  \`cartBuyerIdentityUpdate\` does. \`BuyerInput\` is \`{customerAccessToken}\`.

The token comes from \`customerLoginCodeVerify\`. On the web keep it on the server
— Nitrogen keeps it in the signed session cookie — never in a URL, browser
storage or client code.

\`@inContext(country:, language:)\` are accepted and ignored: a store serves one
country and one language.

## Conventions that hold everywhere

**Ids are global.** \`gid://cloudcart/Product/123\`. Most single-object queries
also accept \`handle\`, which is what a URL carries — prefer it. \`node(id)\` and
\`nodes(ids)\` read a product, collection, vendor, tag, page, blog, article or
store location by its id.

**Lists are Relay connections** with \`edges\`, \`nodes\`, \`pageInfo\`. Use \`nodes\`
unless you need cursors. \`first\` and \`last\` default to 25 and a larger value is
cut to 100 on most lists (a product's \`reviews\`: 10 and 50). \`first\`/\`after\` page forward
and \`last\`/\`before\` back, except \`relatedProducts\`, which pages forward only.
Trust \`pageInfo.hasNextPage\`, not the number of nodes you got.

**Show \`formatted\`.** Every \`MoneyV2\` has \`amount\`, a decimal string for logic,
and \`formatted\`, the amount as the store writes money: its currency's symbol and
where it stands, its decimals and separators. Never format \`amount\` yourself. An
amount you add up from amounts the API gave is written with \`Shop.currencyFormat\`,
the pattern \`formatted\` is made with.

**Mutations do not throw for a business failure.** Each payload carries its
errors — \`userErrors\`, or \`customerUserErrors\` on the customer payloads — each
with a \`message\` meant for the buyer and, on most, \`field\` and \`code\`. Empty
means success. A cart payload also carries \`warnings\`: inputs that were sent and
had no effect, such as a discount code the store did not honour. A GraphQL-level
error means the request itself was malformed.

**Some fields depend on the merchant's apps.** They answer empty rather than
erroring, which is the harder failure to notice. \`introspect_graphql_schema\`
flags them.

---

# Catalog

\`products(first, after, query, sortKey, reverse, filters, smartFacetCounts)\`
returns a \`ProductConnection\` with:

- \`nodes\` — the products
- \`totalCount\` — the real total for the query and filters, for "47 products"
- \`filters\` — the facets **for this result set**, from the store's search engine,
  and \`filterCapabilities\` — whether their counts are exact and their values
  complete

Build the facet sidebar from \`filters\` (on a search, \`productFilters\`); do not
hardcode facets. Each \`Filter\`
has an \`id\`, a \`label\`, a \`type\` (\`LIST\`, \`BOOLEAN\`, \`PRICE_RANGE\`, \`RANGE\`,
\`SWATCH_COLOR\`, \`SWATCH_IMAGE\`) and \`values\`, each with its \`count\` and its
\`input\`: the \`ProductFilter\` to send back when the buyer picks it. Ranges add
\`minValue\`/\`maxValue\`, \`rangeStep\` and \`decimals\`. A collection's, a vendor's
and a tag's \`products\` take the same arguments.

\`smartFacetCounts\` (default true) recounts each active facet as if its own
filter were off, so a buyer sees what another value would give. It costs one
more engine search per active filter; turn it off when you do not show those
counts.

\`ProductFilter\` accepts \`available\`, \`onSale\`, \`isNew\`, \`isFeatured\`, \`tag\`,
\`productVendor\`, \`price\`, \`variantOption\`, \`category\`, \`brandModel\` and
\`productMetafield\` (a category property's value). Send back a value's \`input\`
rather than building one.

Sort with \`ProductSortKeys\`: \`TITLE\`, \`PRICE\`, \`BEST_SELLING\`, \`CREATED_AT\`,
\`UPDATED_AT\`, \`PRODUCT_TYPE\`, \`VENDOR\`, \`RELEVANCE\`, \`ID\`. Without a \`sortKey\`
a list comes in the store's own order.

For "you may also like", \`product.relatedProducts\` pages through the merchant's
linked products, then the product's category; \`product.linkedProducts\` is the
linked ones alone. \`productRecommendations(productId | productHandle, intent)\`
gives a short list: \`RELATED\` or \`COMPLEMENTARY\`.

## Collections

A collection is a category or a merchant's selection (a smart collection), in
one type; \`kind\` on \`collection\` and \`collections\` tells them apart. A smart
collection's id carries \`sc_\` — \`gid://cloudcart/Collection/sc_12\` — so never
parse an id as a number.

\`Collection\` gives you a whole category page: \`parent\`, \`children\`,
\`breadcrumb\`, \`productsCount\`, \`displayChildren\`, \`seo\`, \`googleTaxonomy\`,
plus \`restrictions\`, which is why a payment or shipping method may be unavailable
later in the checkout.

## Search

\`search(query, types, productFilters, sortKey, unavailableProducts, smartFacetCounts)\`
spans products, pages and articles. Its facets are \`productFilters\`, not
\`filters\`; \`totalCount\` counts every result and \`productCount\` the products.
\`predictiveSearch(query, limit, limitScope, types)\` is the type-ahead —
products, collections, vendors, pages and articles, smaller and faster.

---

# Cart and checkout

**The server owns every number.** Never compute a price, discount, tax or total
in the storefront. Every cart mutation returns the whole repriced cart — read the
answer, do not predict it.

**Record where the buyer came from**, early, while the landing URL still exists:
\`cartAttributionUpdate\` keeps the landing page, referrer, visitor and UTM on the
cart, and both the store's checkout (through \`checkoutUrl\`) and
\`cartSubmitForCompletion\` read it. Skip it and the order is recorded as direct
traffic. A fast order takes the same in its \`attribution\` input.

**A cart's id is \`gid://cloudcart/Cart/<key>\`**, where the key is a long random
string. It is not a row number and cannot be guessed. Keep it yourself — a
Nitrogen storefront keeps it in a cookie; there is no implicit "current cart".

## The checkout

**\`cart.checkoutUrl\`** hands the cart to the store's own checkout, signed in as
the buyer when the request carried one. It is signed and **valid for ten
minutes**: read it right before sending the buyer, not from a page loaded long
before, or the buyer lands on a 404.

**\`fastOrderSubmit(attemptToken, input)\`** places an order from the page: one
line or bundle, the buyer's contact and consents. It answers \`COMPLETED\` with the
order, or \`FAILED\` with \`userErrors\`.

## The API's own checkout

For a client that runs its own checkout. **There are no steps:** no mutation has
to precede another. Ask what is missing and let that drive the UI:

\`\`\`graphql
query { cartCheckoutReadiness(cartId: $id) { status missing consents { id } } }
\`\`\`

\`missing\` names what remains — \`BUYER_EMAIL\`, \`DELIVERY_ADDRESS\`,
\`DELIVERY_OPTION\`, \`DELIVERY_SLOT\`, \`PAYMENT_METHOD\`, \`CONSENTS\` and others
(\`CartCheckoutRequirement\`).

1. \`cartCreate\` — lines, buyer identity and discount codes in one call
2. \`cartAttributionUpdate\` — early (above)
3. \`cartDeliveryAddressUpdate\` — a street address, a courier office or locker
   (\`pickupPointId\`), a merchant shop (\`storeId\`), or a signed-in buyer's saved
   address (\`addressId\`)
4. \`cart { delivery { carriers } }\` — the couriers that can deliver there; it
   **calls no courier** and is cheap
5. \`cartDeliveryQuote(cartId, carrierHandle)\` — one courier, live. Quote the
   couriers **in parallel**, so one slow courier does not hold up the rest.
6. \`cartSelectedDeliveryOptionUpdate\` — the option's handle, plus
   \`deliverySlotKey\` for a courier that delivers in slots (\`cartDeliverySlots\`)
7. \`cart { paymentMethods }\` → \`cartPaymentMethodUpdate\`
8. \`cartSubmitForCompletion\` with an \`attemptToken\`

\`CartSubmitStatus\` is one of three: \`COMPLETED\` — the order exists;
\`REQUIRES_REDIRECT\` with \`redirectUrl\` — send the buyer to the payment
provider; \`FAILED\` — read \`userErrors\`. The \`attemptToken\`
makes retrying safe: the same token returns the same order instead of a second
one.

## Traps

**Delivery needs an address.** \`carriers\` is empty until the cart has one, and a
quote without one is refused.

**Payment follows delivery.** \`paymentMethods\` is empty until a shippable cart
has a delivery service chosen: the courier decides half of what is allowed. Read
it again when delivery changes.

**Line discounts are already inside the subtotal.** Only order-level discounts
appear as separate rows of \`totals\` (the \`discount.before\` group). Adding the
line ones again double-counts.

**\`totals\` and \`cost\` come from one calculation** and cannot disagree.
\`totals\` is the merchant's ordered summary, with their own labels — the right
thing to render a summary panel from. \`cost\` is the same figures as named
aggregates, for when you just need the total.

**Customizations are not variant options.** A variant option picks *which*
variant. A customization — engraving, gift wrap, a cut to size — rides along with
the line, can change its price, and is part of the line's identity: the same
variant with different answers is a **separate line**, not a larger quantity.
Read \`product.customizations\` for what a product accepts.

**Bundles are groups, not lines.** \`cartBundleAdd\` adds one line per product in
the bundle, all sharing a \`bundle.id\`. Group by it for display. A bundle is added
whole or not at all.

**A cart may have no customer.** Identity arrives at any point, in any order.
Sending only a phone or a name creates nothing — it waits on the cart until an
email or a sign-in gives it an owner.

**Record where a line came from.** If the buyer took an up-sell or cross-sell
offer, send \`upSellTriggerVariantId\` or \`crossSellId\` on the line: the line is
then priced as the offer and counted in the merchant's reporting. Without the
store's up-sell and cross-sell app they do nothing, and the line gets a warning.

---

# Customers

Sign in with \`customerLoginCodeSend\`, then \`customerLoginCodeVerify\`, which
returns the access token. **There is deliberately no password login and no
password reset.**

\`customer(customerAccessToken)\` is the account area in one query: \`orders\`,
\`wishlist\`, \`downloads\`, \`payments\`, \`returns\`, \`addresses\`,
\`billingAddresses\`, \`defaultAddress\`, \`numberOfOrders\`, \`tags\`.

Delivery and billing addresses are separate sets with separate mutations. A
buyer can have several: a street address, one per courier office, one per
locker. Do not assume one buyer has one address.

## Orders

\`customer.orders\` lists them, newest first, with \`totalCount\`; there is no
filter or search over them. \`order(customerAccessToken, id)\` reads one with its
lines, addresses, payments, discounts, \`totals\` and \`returnEligibility\`.

**A guest reads an order's status** with \`orderStatus(id, email)\` — the order's
\`id\` and the email it was placed with: the status, the totals, whether it is
paid, nothing that identifies the buyer. A wrong pair answers \`null\`. It is how a
client returning from a payment provider asks the store what the payment did.

## Returns

\`returnRequestStart\` → \`returnRequestVerify\` (a code sent by email) →
\`returnRequestCreate\`. \`returnByReference(reference)\` reads one back **without
a sign-in**, by the reference from the notification email. Returns need the
merchant's returns app; without it they answer \`null\` or a \`NOT_AVAILABLE\`
error.

---

# Content and shop

\`page\`, \`pages\`, \`blog\`, \`blogs\`, \`article\`, \`articles\`, \`policies\` and
\`menu(handle)\` are the content. \`menu\` takes a handle such as \`main\` or
\`footer\` and returns the tree.

\`shop\` gives the store's name, description, logo, primary domain, contact,
payment settings and \`currencyFormat\`. \`checkoutSettings\` says which checkout
fields exist and whether each is required, optional or hidden — build a form from
it rather than hardcoding, because it differs per merchant. \`cookieConsent\` is
the merchant's cookie banner and its consent groups; \`subscribeForms\` are their
sign-up forms.

\`storeLocations\` lists the merchant's physical shops, for a store locator and
for collect-from-shop.

---

# Metafields and metaobjects

The merchant's own fields and content types. Only definitions whose storefront
access is \`PUBLIC_READ\` are returned; anything else answers \`null\` or an
empty list, never an error.

\`Product\`, \`Collection\` and \`Customer\` have \`metafield(namespace, key)\` and
\`metafields(identifiers: [{namespace, key}])\`. **Always pass \`namespace\`**: the
store has no app-reserved namespace, so a \`metafield(key:)\` without one finds
nothing. \`metafields\` answers one entry per identifier, in their order, \`null\`
where there is no value — read it by position. A smart collection has no
metafields.

\`value\` is always a string, whatever the \`type\` (\`boolean\`,
\`number_integer\`, \`single_line_text_field\`, \`list.product_reference\`, …); a
\`list.*\` type is a JSON array in that string, and \`list\` says which. A
reference type gives the record: \`reference\` for one,
\`references(first:)\` for a list, each a \`MetafieldReference\` — \`Product\`,
\`ProductVariant\`, \`Collection\`, \`Page\`, \`Metaobject\`, \`MediaImage\`,
\`Video\` or \`GenericFile\` — read with inline fragments. A record the storefront
does not show is \`null\` in \`reference\` and left out of \`references\`.

\`\`\`graphql
query ProductSpecs($handle: String!) {
  product(handle: $handle) {
    metafields(identifiers: [
      {namespace: "custom", key: "material"}
      {namespace: "custom", key: "care_guide"}
    ]) {
      key
      type
      value
      reference { ... on MediaImage { image { url altText } } }
    }
  }
}
\`\`\`

A metaobject is an entry of a content type: \`metaobject(handle: {type, handle})\`
or \`metaobject(id:)\` for one, \`metaobjects(type:, first:)\` for a type's
entries (an unknown or hidden type gives an empty list). Read its values with
\`field(key:)\` or \`fields\`, which has only the fields that have a value; a
\`MetaobjectField\` has the same \`value\`, \`reference\` and \`references\` as a
metafield. \`metaobjects\` sorts by \`sortKey\` (\`id\` or \`updated_at\`) with
\`reverse\`, and filters with \`query\` on the type's filterable fields:
\`fields.color:blue\`, \`fields.year:>=2020\`, \`-fields.tags:"sale"\`. A term it
cannot filter by is ignored, not refused.

A customer's own metafields come only to that customer, through
\`customer(customerAccessToken:)\`, and only for definitions the merchant opened
to customer accounts.

These fields count toward the query's complexity: \`metafields\` one object per
identifier, \`metaobjects\` and \`references\` per item of their page. Ask for
small pages; a document over 1 000 is refused.

---

# Analytics

\`analyticsSettings\` says which pixels the merchant runs. \`analyticsEventPublish\`
records an event and returns its \`eventId\` — fire the browser pixel's event with
that same id, or the vendor counts the conversion twice. A Nitrogen storefront
publishes its events through Nitrogen's analytics, not by hand.

---

# Before you ship a query

Run it through \`validate_graphql_codeblocks\`. The schema is large, and close
names are easy to invent.
`.trim();
