/**
 * Parts of the Storefront API that only answer when the merchant runs the app
 * behind them.
 *
 * A storefront that assumes every field is always populated ships bugs that
 * only appear on some stores — an empty list read as "this shop sells nothing
 * customisable", a null read as "no reviews yet". None of these fields error;
 * they simply return nothing, which is the harder failure to spot.
 *
 * Everything listed here was confirmed against the platform, not guessed, and
 * every pattern was checked to match a type or operation that exists. A group
 * whose patterns match nothing is worse than no group at all: it reads as
 * covered while never firing.
 *
 * That is why up-sell and cross-sell are not here. They are real app-gated
 * behaviour, but they surface as input fields — `CartLineInput.upSellTriggerVariantId`
 * and `crossSellId` — which this matcher never sees. The guide carries them
 * instead.
 */

export interface AppResourceGroup {
  /** Stable identifier for the group. */
  group: string;
  /** Human-readable label. */
  label: string;
  /** Shown once per group in introspection results. */
  notice: string;
  /** Matched case-insensitively as substrings of type / field / operation names. */
  patterns: string[];
}

export const APP_RESOURCE_GROUPS: AppResourceGroup[] = [
  {
    group: "product-options",
    label: "Product Options",
    notice:
      "Needs the `product_options` app. Without it `product.customizations` is an empty list and " +
      "`CartLineInput.customizations` has nothing valid to send — the platform returns no fields at all " +
      "rather than erroring. Treat an empty list as 'the merchant asks nothing about this product', " +
      "not as a failure.",
    patterns: ["customization", "productcustomization"],
  },
  {
    group: "store-locations",
    label: "Store Locations",
    notice:
      "Collect-from-shop is the merchant's `store_locations` app: `CartDeliveryAddressInput.storeId` picks one " +
      "of the shops `storeLocations` lists. `storeLocations` lists the merchant's shops whether the app is on or " +
      "not, so a store locator works either way.",
    patterns: ["storelocation"],
  },
  {
    group: "delivery-hours",
    label: "Delivery Time Slots",
    notice:
      "Needs the merchant's delivery hours app (`shipping_hours`), and only for couriers that deliver in slots. " +
      "For such a courier send `deliverySlotKey` with `cartSelectedDeliveryOptionUpdate`, from " +
      "`cartDeliverySlots`: without it `cartCheckoutReadiness` lists `DELIVERY_SLOT` and the order is refused. " +
      "For every other courier the list is empty and no slot is needed.",
    patterns: ["deliveryslot"],
  },
  {
    group: "gdpr",
    label: "GDPR Consents",
    notice:
      "When the GDPR app is active, `checkoutSettings.legal.gdprActive` is true and the consents to " +
      "collect come from `gdprPolicies`; the legacy `termsPages` list is then empty. The two are " +
      "mutually exclusive — render whichever is populated, never both.",
    patterns: ["gdpr", "consent"],
  },
  {
    group: "reviews",
    label: "Product Reviews",
    notice:
      "Needs the merchant's reviews app (`product_review`), installed and active. Without it `product.reviews` " +
      "is empty and `product.reviewSummary` " +
      "is null — which means 'reviews are not in use here', not 'this product has no reviews'. Hide the " +
      "section rather than showing a zero.",
    patterns: ["review"],
  },
  {
    group: "credit",
    label: "Instalments & Leasing",
    notice:
      "Requires a credit provider the merchant set up. A payment method with `group: CREDIT` is refused " +
      "without a plan — read `cartCreditPlans` and pass one of its `creditPlanId`s (and `downPayment` where " +
      "the plan takes one) to `cartPaymentMethodUpdate`.",
    patterns: ["creditplan"],
  },
  {
    group: "analytics",
    label: "Pixels & Server-side Events",
    notice:
      "Which pixels answer depends on what the merchant has connected — read `analyticsSettings` first. " +
      "`analyticsEventPublish` returns the `eventId` the browser pixel must reuse, otherwise the vendor counts " +
      "the same conversion twice.",
    patterns: ["analytics"],
  },
  {
    group: "returns",
    label: "Returns",
    notice:
      "Needs the merchant's returns app (`aftercare`): without it `returnByReference` answers null and the " +
      "flow a `NOT_AVAILABLE` error. The flow is start → verify by emailed code → create, and " +
      "`returnByReference` reads one back without a customer token.",
    patterns: ["return"],
  },
];

export function matchAppResourceGroup(name: string): AppResourceGroup | null {
  const needle = name.toLowerCase();

  return (
    APP_RESOURCE_GROUPS.find((group) =>
      group.patterns.some((pattern) => needle.includes(pattern)),
    ) ?? null
  );
}

export function formatAppNotice(group: AppResourceGroup): string {
  return `ℹ️  ${group.label} — ${group.notice}`;
}

/**
 * The admin MCP flags any operation taking an app `key`. The Storefront API has
 * no such parameter: a storefront never addresses an app directly, it just gets
 * emptier answers. Kept so the shared introspection code has something to
 * reference, and deliberately matches nothing.
 */
export const APP_KEY_NOTICE_GROUP: AppResourceGroup = {
  group: "app-key",
  label: "Application-Provided",
  notice:
    "This resource comes from a marketplace app. The Storefront API never names an app directly — " +
    "when one is missing the field simply answers empty.",
  patterns: [],
};
