#!/usr/bin/env node
// Bulk-scans Shopify storefronts' public /products.json endpoints across many
// collections/shops in one shot, so hundreds of listings can be pulled and
// ranked by discount without clicking through pages one at a time.
//
// Usage:
//   node shopify-scan.js [--category kiteboarding] [--keyword "kite"] [--minDiscount 15] [--out results.json]
//
// --category picks a group from shops.json (default: all groups).
// Extra ad-hoc shops can be scanned with --domain <domain> --collection <handle> (repeatable).

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { domains: [], collections: [], concurrency: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--category") args.category = argv[++i];
    else if (a === "--keyword") args.keyword = argv[++i];
    else if (a === "--minDiscount") args.minDiscount = Number(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--domain") args.domains.push(argv[++i]);
    else if (a === "--collection") args.collections.push(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
  }
  return args;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shopify appears to rate-limit by requesting IP across its WHOLE platform,
// not per individual store — scanning 47 different *.myshopify.com-backed
// domains still tripped a shared limit because they all ultimately hit the
// same edge. So pacing has to be global (one shared gate), not per-domain.
let lastRequestAt = 0;
const MIN_GAP_MS = 350;
async function globalGate() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function fetchWithRetry(url, attempt = 1) {
  await globalGate();
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delay = retryAfter ? retryAfter * 1000 : attempt * 1500 + Math.random() * 500;
    await sleep(delay);
    return fetchWithRetry(url, attempt + 1);
  }
  return res;
}

async function fetchCollectionProducts(domain, collection) {
  const products = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://${domain}/collections/${collection}/products.json?limit=250&page=${page}`;
    let res;
    try {
      res = await fetchWithRetry(url);
    } catch (e) {
      console.error(`  ! fetch failed ${url}: ${e.message}`);
      break;
    }
    if (!res.ok) {
      if (page === 1) console.error(`  ! ${domain}/${collection}: HTTP ${res.status} (after retries)`);
      break;
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      if (page === 1) console.error(`  ! ${domain}/${collection}: not JSON (not a Shopify store?)`);
      break;
    }
    const batch = json.products || [];
    if (batch.length === 0) break;
    products.push(...batch);
    if (batch.length < 250) break; // last page
    await sleep(150); // be polite between pages of the same collection
  }
  return products;
}

function flattenListings(domain, shopName, collection, products) {
  const listings = [];
  for (const p of products) {
    for (const v of p.variants || []) {
      const price = Number(v.price);
      const compareAt = v.compare_at_price ? Number(v.compare_at_price) : null;
      const onSale = compareAt && compareAt > price;
      const discountPct = onSale ? Math.round(((compareAt - price) / compareAt) * 100) : 0;
      listings.push({
        shop: shopName,
        domain,
        collection,
        title: p.title,
        variant: v.title !== "Default Title" ? v.title : null,
        price,
        compareAt,
        discountPct,
        available: v.available,
        url: `https://${domain}/products/${p.handle}${v.id ? `?variant=${v.id}` : ""}`,
      });
    }
  }
  return listings;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shopsConfigPath = path.join(__dirname, "shops.json");
  const shopsConfig = JSON.parse(fs.readFileSync(shopsConfigPath, "utf-8"));

  let targets = [];
  const groups = args.category ? [args.category] : Object.keys(shopsConfig);
  for (const g of groups) {
    for (const shop of shopsConfig[g] || []) {
      for (const collection of shop.collections) {
        targets.push({ shopName: shop.name, domain: shop.domain, collection });
      }
    }
  }
  for (const domain of args.domains) {
    for (const collection of args.collections.length ? args.collections : ["all"]) {
      targets.push({ shopName: domain, domain, collection });
    }
  }

  // Group by domain so concurrency is spent across DIFFERENT shops, not
  // hammering one shop's rate limit with many collections at once.
  const byDomain = new Map();
  for (const t of targets) {
    if (!byDomain.has(t.domain)) byDomain.set(t.domain, []);
    byDomain.get(t.domain).push(t);
  }
  const domains = [...byDomain.keys()];
  console.error(`Scanning ${targets.length} shop/collection pairs across ${domains.length} domains (domain concurrency ${args.concurrency})...`);
  let done = 0;
  const perDomain = await pool(
    domains,
    async (domain) => {
      const domainTargets = byDomain.get(domain);
      const out = [];
      for (const t of domainTargets) {
        const products = await fetchCollectionProducts(t.domain, t.collection);
        out.push(...flattenListings(t.domain, t.shopName, t.collection, products));
        done++;
        await sleep(120); // stay polite within a single domain
      }
      if (done % 25 < domainTargets.length) console.error(`  ...${done}/${targets.length} collections fetched`);
      return out;
    },
    args.concurrency
  );
  let all = perDomain.flat();

  // de-dupe by url (same product can appear in multiple collections)
  const seen = new Set();
  all = all.filter((l) => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  if (args.keyword) {
    const kw = args.keyword.toLowerCase();
    all = all.filter((l) => l.title.toLowerCase().includes(kw));
  }
  if (args.minDiscount) {
    all = all.filter((l) => l.discountPct >= args.minDiscount);
  }

  all.sort((a, b) => b.discountPct - a.discountPct);

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(all, null, 2));
    console.error(`Wrote ${all.length} listings to ${args.out}`);
  }

  console.error(`\n=== Top results (${all.length} total after filters) ===`);
  console.log(JSON.stringify(all.slice(0, 100), null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
