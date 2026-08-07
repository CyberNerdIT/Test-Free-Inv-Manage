// What the paid upgrade adds — described, never implemented.
//
// This is the FREE edition, and "free" here means ABSENT, not disabled. There
// is no marketplace API client, no chat-alert sender and no custom-colour
// engine anywhere in this tree. Nothing checks a licence, nothing phones home,
// and there is no flag to flip — because there is nothing behind it to switch
// on. An install can only be what it is, and it can never be wrong about it.
//
// What lives here is a CATALOGUE: names and one-line descriptions, so the admin
// page can say what Pro adds and where to ask for it without the app shipping
// any of it.
//
// ---------------------------------------------------------------------------
// Upgrading is not self-service yet
// ---------------------------------------------------------------------------
// The intended path is a key you paste in, after which the app fetches the
// premium modules from GitHub and installs them itself. That machinery is still
// being built, so this build deliberately promises nothing it cannot do: it
// points at INV_UPGRADE_URL when one is set, and otherwise says plainly that
// the upgrade is arranged by getting in touch. No half-wired installer, no
// command that does not exist, no "coming soon" button that 404s.
export const PRODUCT = 'Tech Garage Pro';

/**
 * The premium features, for display only.
 *
 * Deliberately in the free build: an install has to be able to say what it is
 * missing. Descriptions and nothing else — no implementation, no stubs to
 * un-comment, no dormant code path waiting for a flag.
 */
export const FEATURES = [
  {
    key: 'custom-theme',
    name: 'Custom store colours',
    blurb: 'Set every colour in your shop, not just the six built-in schemes.',
  },
  {
    key: 'ebay',
    name: 'eBay price lookups',
    blurb: 'Real sold and active comparables from the eBay APIs, with condition filtering.',
  },
  {
    key: 'amazon',
    name: 'Amazon price lookups',
    blurb: 'Current Amazon offers via the Product Advertising API.',
  },
  {
    key: 'whatsapp',
    name: 'WhatsApp alerts',
    blurb: 'Purchase requests pushed to WhatsApp via the Business Cloud API.',
  },
  {
    key: 'discord',
    name: 'Discord alerts',
    blurb: 'Purchase requests posted to a Discord channel.',
  },
  {
    key: 'telegram',
    name: 'Telegram alerts',
    blurb: 'Purchase requests sent through a Telegram bot.',
  },
  {
    key: 'community-controls',
    name: 'Community controls',
    blurb: 'Show only shops you invited, or hide community listings from your storefront entirely.',
  },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

/**
 * Where to send someone who wants Pro.
 *
 * Configurable so a fork, or a reseller running their own fleet, points at
 * their own page rather than ours. Empty is a valid answer and the UI says so.
 */
export const upgradeUrl = () => process.env.INV_UPGRADE_URL || '';

/** One honest sentence about how an upgrade actually happens today. */
export const NOTICE =
  'Upgrading is not automatic yet — the key-based installer is still being built. ' +
  'Get in touch and Pro will be enabled on your install.';

/**
 * Summary for the admin page and /api/health.
 *
 * `available` is a constant, not a lookup: this build has no premium code, so
 * there is no state that could make it true.
 */
export function status() {
  return {
    product: PRODUCT,
    available: false,
    features: FEATURES,
    url: upgradeUrl(),
    notice: NOTICE,
  };
}
