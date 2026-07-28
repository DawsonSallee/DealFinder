#!/usr/bin/env node
// Takes the raw Cabrinha dealer-locator export (cabrinha_dealers_raw.json) and,
// for every dealer with a website, auto-detects whether it runs Shopify and —
// if so — auto-discovers its real collection handles via /collections.json,
// keeping only ones that look kite/sale/clearance/used-relevant. No manual
// per-shop curation: this replaces hand-editing shops.json one dealer at a time.
//
// Usage:
//   node discover-dealers.js [--in cabrinha_dealers_raw.json] [--out discovered_shops.json] [--concurrency 12]

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { in: "cabrinha_dealers_raw.json", out: "discovered_shops.json", concurrency: 12 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
  }
  return args;
}

function domainFromWebsite(website) {
  try {
    const u = new URL(website.startsWith("http") ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

const KITE_COLLECTION_RE = /kite|clearance|sale|used|demo|closeout|outlet|cabrinha|wing|foil|surfboard|twintip|twin-tip|harness|bar\b/i;
const EXCLUDE_COLLECTION_RE = /wetsuit|apparel|clothing|shirt|hat|sunglasses|accessor(y|ies)$/i;

async function probeShop(entry) {
  const { name, domain } = entry;
  let res;
  try {
    res = await fetchWithTimeout(`https://${domain}/collections.json?limit=250`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
  } catch (e) {
    return { name, domain, platform: "unreachable", error: e.message };
  }
  if (!res.ok) {
    return { name, domain, platform: res.status === 404 ? "not-shopify" : `http-${res.status}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { name, domain, platform: "not-shopify" };
  }
  if (!json.collections) {
    return { name, domain, platform: "not-shopify" };
  }
  const relevant = json.collections
    .filter((c) => KITE_COLLECTION_RE.test(c.handle + " " + c.title) && !EXCLUDE_COLLECTION_RE.test(c.handle + " " + c.title))
    .map((c) => c.handle);
  return {
    name,
    domain,
    platform: "shopify",
    totalCollections: json.collections.length,
    relevantCollections: relevant,
  };
}

async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await worker(items[my], my);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(__dirname, args.in);
  const dealers = JSON.parse(fs.readFileSync(inPath, "utf-8"));

  const withSite = dealers.filter((d) => d.website);
  const seenDomain = new Set();
  const candidates = [];
  for (const d of withSite) {
    const domain = domainFromWebsite(d.website);
    if (!domain || seenDomain.has(domain)) continue;
    seenDomain.add(domain);
    candidates.push({ name: d.name, domain, country: d.country, city: d.city });
  }

  console.error(`${dealers.length} total dealers, ${withSite.length} with a website, ${candidates.length} unique domains to probe...`);

  let done = 0;
  const results = await pool(
    candidates,
    async (c) => {
      const r = await probeShop(c);
      done++;
      if (done % 20 === 0) console.error(`  ...${done}/${candidates.length} probed`);
      return r;
    },
    args.concurrency
  );

  const shopify = results.filter((r) => r.platform === "shopify" && r.relevantCollections.length > 0);
  const shopifyNoRelevant = results.filter((r) => r.platform === "shopify" && r.relevantCollections.length === 0);
  const notShopify = results.filter((r) => r.platform !== "shopify");

  console.error(`\nDone. ${shopify.length} confirmed Shopify shops with relevant collections.`);
  console.error(`${shopifyNoRelevant.length} are Shopify but no kite-relevant collections found (may need manual handle review).`);
  console.error(`${notShopify.length} are not Shopify / unreachable (skipped for bulk scan; would need per-site scraping).`);

  const outShops = shopify.map((r) => ({
    name: r.name,
    domain: r.domain,
    collections: r.relevantCollections,
  }));

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(__dirname, args.out);
  fs.writeFileSync(outPath, JSON.stringify({ kiteboarding: outShops }, null, 2));
  console.error(`Wrote ${outShops.length} auto-discovered shops to ${outPath}`);

  const reportPath = outPath.replace(/\.json$/, "_report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ shopify, shopifyNoRelevant, notShopify }, null, 2));
  console.error(`Full probe report (incl. non-Shopify) written to ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
