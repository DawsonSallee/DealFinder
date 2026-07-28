#!/usr/bin/env node
// Turns a raw shopify-scan.js output into the compact, UI-ready snapshot consumed by the
// Finances app's Deals tab: dedupes, drops non-USD shops (Shopify shows local-currency prices
// unconverted), classifies each listing into a coarse category, and keeps only the fields the
// UI needs (incl. image + createdAt for sorting/filtering).
//
// Usage: node build-snapshot.js --in latest_scan_full.json --out deals_snapshot.json [--minDiscount 30] [--minPrice 20]

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { in: "latest_scan_full.json", out: "deals_snapshot.json", minDiscount: 30, minPrice: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--minDiscount") args.minDiscount = Number(argv[++i]);
    else if (a === "--minPrice") args.minPrice = Number(argv[++i]);
  }
  return args;
}

// Shops confirmed (or inferred by domain TLD) to show a non-USD price with no conversion applied.
// Cross-checked by hand against each shop's storefront currency — see README "Known gaps".
const FOREIGN_TLD = /\.(au|uk|nl|fr|de|it|nc|ae|mv|es|ch|jp|br|no|ro|bg|ru)$/i;
const NON_USD_SHOPS = new Set([
  "Kitepower Australia Pty Ltd", "Surface 2 Air Sports Ltd.", "H2O", "Northern Watersports", "Vakarm",
  "Kitesurfshop Haarlem", "SHQ Boardsports", "Sunshine Coast Boardsports", "Aventure Sports Noosa",
  "The Kite Loft Australia", "Groundswell Sports Ltd", "Impact Surf", "Radical Spot", "WakeStyle", "Sea Gear",
  "Kitetiki", "The Ridery Paris", "Core N More", "Blue Ocean Sports", "Ocean Gate",
  "ActionSports WA", "Unhooked Watersports", "Sail Repair WA", "Perth Wake Park", "DeJa Vu Ski Mannum",
  "Stonker", "Deja Vu Ski & Board", "Melbourne Cable Park", "JaySails", "EKITES BRASIL",
]);

// Keyword-based category classifier. Checked in order — first match wins, so put more specific
// terms (e.g. "wing" before generic "board") ahead of broader ones.
const CATEGORY_RULES = [
  ["Kite", /\bkites?\b/i],
  ["Wing", /\bwing(foil|s)?\b/i],
  ["Board", /\b(twin\s?tip|twintip|kiteboard|surfboard|foilboard|foil board)\b/i],
  ["Bar", /\b(control bar|bar\b)/i],
  ["Foil", /\b(hydrofoil|front wing|mast\b|foil\b)/i],
  ["Harness", /\bharness/i],
  ["Wetsuit", /\bwetsuit/i],
  ["Vest", /\b(impact vest|life vest|pfd)\b/i],
  ["Pump", /\bpump\b/i],
  ["Accessory", /.*/],
];
function classify(title) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(title)) return cat;
  return "Accessory";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(__dirname, args.in);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(__dirname, args.out);
  const raw = JSON.parse(fs.readFileSync(inPath, "utf-8"));

  let items = raw.filter((l) => {
    if (l.available === false || !l.compareAt) return false;
    if (l.discountPct < args.minDiscount || l.price < args.minPrice) return false;
    if (NON_USD_SHOPS.has(l.shop)) return false;
    if (l.domain && FOREIGN_TLD.test(l.domain)) return false;
    return true;
  });

  const seen = new Set();
  items = items.filter((l) => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });

  const snapshot = items.map((l) => ({
    shop: l.shop,
    title: l.title,
    variant: l.variant,
    price: l.price,
    compareAt: l.compareAt,
    discountPct: l.discountPct,
    url: l.url,
    image: l.image || null,
    // Always use our own classifier, not each shop's raw product_type — that field turned out
    // wildly inconsistent across ~350 shops (e.g. "Kite"/"Kites"/"KITES"/"Kiteboarding"/"Kite -
    // Kites Parts - Kites" all meaning the same thing), which made a category filter useless.
    category: classify(l.title),
    addedAt: l.createdAt || null,
  }));
  snapshot.sort((a, b) => b.discountPct - a.discountPct);

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 1));
  console.error(`Wrote ${snapshot.length} deals (from ${raw.length} raw listings) to ${outPath}`);
  const byCategory = {};
  for (const s of snapshot) byCategory[s.category] = (byCategory[s.category] || 0) + 1;
  console.error("By category:", byCategory);
}

main();
