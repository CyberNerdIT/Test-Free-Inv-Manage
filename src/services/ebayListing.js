// Auto-fill inventory item details from an eBay listing.
//
// This build has one path: a best-effort parse of the listing's public web page
// (JSON-LD structured data), restricted to eBay hosts. It needs no credentials,
// but it is against eBay's ToS, it is fragile, and it yields fewer specs.
//
// The official route — the Browse API's get_item_by_legacy_id, which is
// structured and ToS-compliant — is part of the paid upgrade, so none of that
// client code is in this repository.
import { effective } from '../settings.js';

// Extract the numeric eBay item id from a URL or raw id.
export function parseItemId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{11,13}$/.test(s)) return s;
  // .../itm/123456789012  or  .../itm/Title-Words/123456789012  or  ?item=...&
  const patterns = [/\/itm\/(?:[^/]+\/)?(\d{11,13})/, /[?&]item=(\d{11,13})/, /(\d{11,13})/];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

function mapCondition(condition) {
  const c = String(condition || '').toLowerCase();
  if (!c) return 'used';
  if (c.includes('for parts') || c.includes('not working') || c.includes('damaged')) return 'for-parts';
  if (c.includes('refurb')) return 'refurbished'; // "Seller refurbished" / "Certified refurbished"
  // Open box / "New (other)" are physically opened goods — treat as used for resale.
  if (c.includes('open box') || c.includes('new (other)') || c.includes('new other')) return 'used';
  if (c === 'new' || c.startsWith('new ') || c.includes('brand new') || c.includes('new with')) return 'new';
  return 'used';
}

function guessCategory(path) {
  const p = String(path || '').toLowerCase();
  if (p.includes('laptop') || p.includes('notebook')) return 'laptop';
  if (p.includes('desktop') || p.includes('all-in-one') || p.includes('tower') || p.includes('workstation')) return 'desktop';
  const componentHints = [
    'graphics', 'video card', 'gpu', 'quadro', 'geforce', 'radeon', 'rtx ', 'gtx ', 'gddr',
    'processor', 'cpu', 'xeon', 'core i3', 'core i5', 'core i7', 'core i9', 'ryzen',
    'memory', 'ram', 'ddr3', 'ddr4', 'ddr5', 'dimm', 'sodimm',
    'motherboard', 'hard drive', 'solid state', 'ssd', 'nvme', 'hdd',
    'power supply', 'psu', 'heatsink', 'cooler', 'raid', 'network card', 'nic',
  ];
  if (componentHints.some((k) => p.includes(k))) return 'component';
  if (p.includes('tablet') || p.includes('phone') || p.includes('monitor') || p.includes('display')) return 'device';
  return 'other';
}

function pick(map, names) {
  for (const n of names) {
    const v = map[n.toLowerCase()];
    if (v) return v;
  }
  // fuzzy: any key that contains one of the names
  for (const [k, v] of Object.entries(map)) {
    if (names.some((n) => k.includes(n.toLowerCase()))) return v;
  }
  return undefined;
}

/**
 * Fill an inventory item from an eBay listing.
 *
 * Always the scrape. Calling the Browse API — and mapping its response — is
 * part of the paid upgrade, so this repository holds no eBay API code at all,
 * not even the parts that only reshape a response. `locked` tells the caller
 * that credentials are saved but unusable here, so the UI can explain the
 * fallback instead of leaving it looking like a bug.
 */
export async function fetchListing(input) {
  const cfg = effective().ebay;
  const r = await scrapeListing(input);
  return { ...r, apiUsed: false, locked: Boolean(cfg.locked) };
}

// ---- HTML fallback (no API) ----------------------------------------------

const MARKETPLACE_TLD = {
  EBAY_US: 'com', EBAY_GB: 'co.uk', EBAY_DE: 'de', EBAY_CA: 'ca',
  EBAY_AU: 'com.au', EBAY_FR: 'fr', EBAY_IT: 'it', EBAY_ES: 'es',
};

// Only ever fetch eBay-owned hosts (SSRF guard).
function isEbayHost(host) {
  return /(^|\.)ebay\.[a-z.]{2,7}$/i.test(host);
}

function listingUrl(input, id) {
  const s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (isEbayHost(u.hostname)) return `https://${u.hostname}${u.pathname}`;
    } catch { /* fall through */ }
  }
  if (!id) return null;
  const tld = MARKETPLACE_TLD[effective().ebay.marketplace] || 'com';
  return `https://www.ebay.${tld}/itm/${id}`;
}

function jsonLdProduct(html) {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of blocks) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
    for (const node of nodes) {
      const t = node && node['@type'];
      if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return node;
    }
  }
  return null;
}

function metaContent(html, prop) {
  // content= may come before or after the property/name attribute.
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${esc}["']`, 'i'))?.[1] ??
    null
  );
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, e)) return ENTITIES[e];
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}
// Turn an HTML fragment into readable text.
function stripTags(frag) {
  return decodeEntities(String(frag || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse a money string into a number, tolerating currency prefixes, thousands
 * separators and European decimal commas: "US $1,499.00" -> 1499, "99,50" -> 99.5.
 */
export function parseMoney(text) {
  if (text == null) return null;
  const m = String(text).match(/\d[\d.,]*/);
  if (!m) return null;
  let n = m[0].replace(/[.,]+$/, '');
  const lastDot = n.lastIndexOf('.');
  const lastComma = n.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Whichever separator comes last is the decimal point.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    n = n.split(thou).join('');
    if (dec === ',') n = n.replace(',', '.');
  } else if (lastComma >= 0) {
    // "1,234" = thousands; "12,50" = European decimal.
    n = n.length - lastComma - 1 === 3 ? n.split(',').join('') : n.replace(',', '.');
  } else if (lastDot >= 0 && n.length - lastDot - 1 === 3 && /^\d{1,3}(\.\d{3})+$/.test(n)) {
    n = n.split('.').join(''); // "1.234" thousands style
  }
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function offerPrice(offers) {
  if (!offers) return { price: null, currency: 'USD' };
  const o = Array.isArray(offers) ? offers[0] : offers;
  const raw = o.price ?? o.lowPrice ?? (Array.isArray(o.offers) ? o.offers[0]?.price : null);
  return { price: parseMoney(raw), currency: o.priceCurrency || 'USD' };
}

function conditionFromSchema(url, fallbackText) {
  const u = String(url || '').toLowerCase();
  if (u.includes('newcondition')) return 'new';
  if (u.includes('refurb')) return 'refurbished';
  if (u.includes('damaged')) return 'for-parts';
  if (u.includes('usedcondition')) return 'used';
  return mapCondition(fallbackText);
}

/**
 * Item specifics. eBay exposes these two ways and we merge both:
 *  1) embedded JSON state:  {"name":"Brand","value":["Dell"]}
 *  2) rendered markup:      <dl class="ux-labels-values..."><dt>Brand</dt><dd>Dell</dd></dl>
 * Modern item pages usually only have (2), which the old parser ignored.
 */
function scrapeAspects(html) {
  const asp = {};
  const put = (k, v) => {
    const key = String(k || '').toLowerCase().replace(/[:\s]+$/, '').trim();
    const val = String(v || '').trim();
    if (key && val && !asp[key]) asp[key] = val;
  };

  // (1) Rendered markup first — it is what the page actually shows, so it wins
  // over any stray JSON elsewhere on the page (`put` keeps the first value).
  const dlRe = /<dt[^>]*class="[^"]*ux-labels-values__labels[^"]*"[^>]*>([\s\S]{0,800}?)<\/dt>\s*<dd[^>]*class="[^"]*ux-labels-values__values[^"]*"[^>]*>([\s\S]{0,1200}?)<\/dd>/gi;
  for (const m of html.matchAll(dlRe)) {
    put(stripTags(m[1]), stripTags(m[2]));
  }
  // Older/table layout: <td class="attrLabels">Brand</td><td>Dell</td>
  const tdRe = /<t[dh][^>]*class="[^"]*attrLabels[^"]*"[^>]*>([\s\S]{0,300}?)<\/t[dh]>\s*<td[^>]*>([\s\S]{0,400}?)<\/td>/gi;
  for (const m of html.matchAll(tdRe)) {
    put(stripTags(m[1]), stripTags(m[2]));
  }

  // (2) Embedded JSON state as a fill-in — tolerate whitespace / non-array values.
  for (const m of html.matchAll(/\{\s*"name"\s*:\s*"([^"]{1,60})"\s*,\s*"value"\s*:\s*\[?\s*"([^"]{1,140})"/g)) {
    put(m[1], decodeEntities(m[2]));
  }
  // Newer payloads use aspectName/aspectValues.
  for (const m of html.matchAll(/"aspectName"\s*:\s*"([^"]{1,60})"\s*,\s*"aspectValues"\s*:\s*\[\s*"([^"]{1,140})"/g)) {
    put(m[1], decodeEntities(m[2]));
  }
  return asp;
}

// Title: JSON-LD -> rendered <h1> -> og:title -> <title> (minus the "| eBay" suffix).
function extractTitle(html, p) {
  if (p.name) return decodeEntities(String(p.name)).trim();
  const h1 = html.match(/<h1[^>]*class="[^"]*x-item-title[^"]*"[^>]*>([\s\S]{0,600}?)<\/h1>/i)
    || html.match(/<h1[^>]*id=["']itemTitle["'][^>]*>([\s\S]{0,600}?)<\/h1>/i);
  if (h1) {
    const t = stripTags(h1[1]).replace(/^details about\s*/i, '').trim();
    if (t) return t;
  }
  const og = metaContent(html, 'og:title');
  if (og) return decodeEntities(og).trim();
  const t = html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  if (t) {
    const s = stripTags(t[1]).replace(/\s*[|\-–]\s*eBay\s*$/i, '').trim();
    if (s && !/^ebay$/i.test(s)) return s;
  }
  return null;
}

// Price: JSON-LD -> meta/microdata -> embedded JSON -> rendered price element.
function extractPrice(html, p) {
  const fromLd = offerPrice(p.offers).price;
  if (fromLd != null) return fromLd;

  for (const prop of ['product:price:amount', 'og:price:amount', 'price']) {
    const v = parseMoney(metaContent(html, prop));
    if (v != null) return v;
  }
  const microdata = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
  if (microdata) { const v = parseMoney(microdata[1]); if (v != null) return v; }

  // Embedded state: "price":{"value":"189.99",...} / "convertedFromValue"
  const embedded = html.match(/"price"\s*:\s*\{[^{}]{0,120}?"value"\s*:\s*"?([\d.,]+)"?/i)
    || html.match(/"(?:currentPrice|binPrice|displayPrice)"\s*:\s*\{[^{}]{0,120}?"value"\s*:\s*"?([\d.,]+)"?/i);
  if (embedded) { const v = parseMoney(embedded[1]); if (v != null) return v; }

  // Rendered: <div class="x-price-primary"><span class="ux-textspans">US $189.99</span></div>
  const rendered = html.match(/class="[^"]*x-price-primary[^"]*"[\s\S]{0,400}?<span[^>]*>([^<]{1,60})</i)
    || html.match(/<span[^>]*(?:id=["'](?:prcIsum|mm-saleDscPrc)["'])[^>]*>([^<]{1,60})</i);
  if (rendered) { const v = parseMoney(rendered[1]); if (v != null) return v; }

  const legacyAttr = html.match(/id=["'](?:prcIsum|mm-saleDscPrc)["'][^>]*content=["']([\d.,]+)["']/i);
  if (legacyAttr) { const v = parseMoney(legacyAttr[1]); if (v != null) return v; }
  return null;
}

// Condition: JSON-LD -> rendered condition element -> item-specifics "Condition".
function extractCondition(html, p, asp) {
  const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  if (offers?.itemCondition) return conditionFromSchema(offers.itemCondition, null);
  const el = html.match(/class="[^"]*x-item-condition-value[^"]*"[\s\S]{0,400}?<span[^>]*>([^<]{1,80})</i)
    || html.match(/<div[^>]*id=["']vi-itm-cond["'][^>]*>([\s\S]{0,120}?)<\/div>/i);
  const text = (el && stripTags(el[1])) || pick(asp, ['Condition']) || null;
  return mapCondition(text);
}

// Image: JSON-LD -> og:image -> embedded state -> any eBay image URL on the page.
function extractImage(html, p) {
  const raw = p.image;
  const fromLd = Array.isArray(raw) ? raw[0] : (raw && (raw.url || raw.contentUrl)) || (typeof raw === 'string' ? raw : null);
  if (fromLd) return fromLd;
  const og = metaContent(html, 'og:image');
  if (og) return og;
  const embedded = html.match(/"(?:imageUrl|originalImg|URL)"\s*:\s*"(https:\/\/i\.ebayimg\.com\/[^"]+)"/i);
  if (embedded) return embedded[1].replace(/\\u002F/gi, '/');
  const any = html.match(/https:\/\/i\.ebayimg\.com\/(?:images|thumbs)\/[^\s"'\\<>]+\.(?:jpg|jpeg|png|webp)/i);
  return any ? any[0] : null;
}

// eBay's anti-bot interstitial answers HTTP 200 but carries no listing data.
export function isChallengePage(html) {
  const head = String(html || '').slice(0, 4000).toLowerCase();
  return /pardon our interruption|splashui\/challenge|are you a human|checking your browser|please verify yourself|captcha/.test(head);
}

export async function scrapeListing(input) {
  const id = parseItemId(input);
  const url = listingUrl(input, id);
  if (!url) {
    const e = new Error('Paste a full eBay listing URL or item number.');
    e.code = 'bad_input';
    throw e;
  }

  // eBay frequently blocks datacenter IPs with a 403 for a normal browser UA,
  // but serves search crawlers the full page. Try, in order: a real browser UA,
  // Googlebot, then the lighter mobile page (often served when desktop is blocked).
  const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  const attempts = [
    { url, ua: CHROME_UA },
    { url, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    { url: url.replace(/^https:\/\/www\./i, 'https://m.'), ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  ];

  let html = null;
  let lastStatus = null;
  let blockedPage = false;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(attempt.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': attempt.ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          Referer: 'https://www.google.com/',
        },
      });
      lastStatus = res.status;
      if (!res.ok) continue;
      const body = await res.text();
      // eBay sometimes answers 200 with a bot-check/consent interstitial that has
      // no listing data — treat that as a block and try the next strategy.
      if (isChallengePage(body)) { blockedPage = true; continue; }
      html = body;
      break;
    } catch (e) {
      if (e.name === 'AbortError') lastStatus = 'timeout';
    } finally {
      clearTimeout(timer);
    }
  }

  if (html == null) {
    const why = blockedPage
      ? 'eBay returned a bot-check page instead of the listing'
      : `eBay blocked the request (HTTP ${lastStatus})`;
    const e = new Error(`${why}. Scraping is unreliable from a server — add eBay API keys in Admin → API integrations for reliable lookups.`);
    e.code = 'blocked';
    throw e;
  }

  const item = parseListingHtml(html, id, url);
  if (!item) {
    const e = new Error('Fetched the page but could not find the listing details (eBay may have changed its layout). Add eBay API keys in Admin → API integrations for a reliable lookup.');
    e.code = 'unparsable';
    throw e;
  }
  return { item, legacyId: id, scraped: true };
}

// Pure parser: eBay listing HTML -> our item shape (or null if unreadable).
export function parseListingHtml(html, id, url) {
  const p = jsonLdProduct(html) || {};
  const title = extractTitle(html, p);
  if (!title) return null;

  const asp = scrapeAspects(html);
  const price = extractPrice(html, p);
  const image = extractImage(html, p);

  const specs = {};
  const setSpec = (key, names) => { const v = pick(asp, names); if (v) specs[key] = v; };
  setSpec('cpu', ['Processor', 'Processor Model', 'CPU']);
  setSpec('ram', ['RAM Size', 'Total RAM', 'Memory Size', 'Memory', 'RAM']);
  setSpec('storage', ['SSD Capacity', 'Hard Drive Capacity', 'Storage Capacity', 'Total Capacity', 'Storage Type']);
  setSpec('gpu', ['Chipset/GPU Model', 'GPU', 'Graphics Processing Type', 'Graphics Card', 'Video Card', 'Chipset Manufacturer']);
  setSpec('screen', ['Screen Size', 'Display Size']);
  setSpec('os', ['Operating System']);
  // Useful extras that often carry the real identity of a component listing.
  setSpec('memoryType', ['Memory Type']);
  setSpec('interface', ['Interface', 'Compatible Slot', 'Connectors']);
  setSpec('formFactor', ['Form Factor']);

  const brand = pick(asp, ['Brand']) || (typeof p.brand === 'object' ? p.brand?.name : p.brand) || null;
  const model = pick(asp, ['Model', 'Product Line', 'MPN', 'Chipset/GPU Model']) || p.mpn || null;

  // Category from the title plus any type-ish aspects (a GPU listing rarely says
  // "graphics" in the title alone, but its item specifics do).
  const categoryHint = [title, pick(asp, ['Type']), pick(asp, ['Chipset/GPU Model']), pick(asp, ['Memory Type'])]
    .filter(Boolean).join(' ');

  return {
    title,
    category: guessCategory(categoryHint),
    brand,
    model,
    condition: extractCondition(html, p, asp),
    specs,
    listing_price: price,
    image,
    notes: `Imported from eBay listing ${id || ''} (scraped, no API)${url ? ' — ' + url : ''}`.trim(),
    sourceUrl: url || null,
  };
}
