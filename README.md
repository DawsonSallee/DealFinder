# DealFinder

Bulk deal scanner for kiteboarding gear (and eventually other categories). Auto-discovers dealer networks
for a brand (via their public "Stockist" store-locator widget, when they use one), checks each dealer domain
for Shopify, and bulk-pulls every product in kite/sale/clearance/used-relevant collections via each shop's
public `/products.json` endpoint — no page-by-page clicking, no scraping HTML.

## How it works

1. **Dealer discovery** (`discover-dealers.js`) — takes a raw dealer-locator export (see `*_dealers_raw.json`)
   and, for every dealer with a website, probes `https://<domain>/collections.json` to detect Shopify, then
   auto-selects collections whose name looks kite/sale/clearance/used-relevant. Writes an auto-generated shop
   config (merged into `shops.json`).
2. **Bulk scan** (`shopify-scan.js`) — hits every configured shop's relevant collections' `/products.json`,
   computes real discount % from `compare_at_price` vs `price`, dedupes, and writes a ranked JSON of every
   listing found. Rate-gated globally (not per-domain — Shopify appears to throttle by requesting IP across
   its whole platform) with retry/backoff on 429s.

## Usage

```
node scripts/shopify-scan.js --category kiteboarding --concurrency 4 --out latest_scan.json
node scripts/shopify-scan.js --category kiteboarding --keyword "9m" --minDiscount 30
```

## Known gaps / caveats

- Only covers dealers whose store-locator uses the "Stockist" widget (Cabrinha, Naish, Slingshot confirmed;
  Duotone/Core/F-One/Ozone/Eleveight/Flysurfer use other platforms or weren't found — not yet covered).
- Only covers Shopify-platform shops. WooCommerce/BigCommerce/custom-platform dealers are skipped entirely.
- Non-USD shops (e.g. Kitepower Australia = AUD, UK shops = GBP, Vakarm New Caledonia = XPF) show their
  local-currency price in the `price` field — **not currency-converted**. Treat cross-shop $ comparisons
  involving non-US dealers with caution.
- `shops.json` is the merged, hand-curated + auto-discovered shop list. Re-run `discover-dealers.js` against
  a fresh dealer export to pick up new dealers.

## Future direction

Long-term: generalize beyond kiteboarding gear to other deal categories, feeding a "deals" pane in a
personal dashboard app rather than being a one-off script.
