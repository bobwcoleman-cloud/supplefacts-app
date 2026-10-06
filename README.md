# SuppleFacts

Phone web app that scans or searches supplement labels (NIH Dietary Supplement Label Database), summarizes ingredients with Claude, and hands the full label to the American Supplement Investigation website for a deeper evidence check.

- App: `supplefacts.html` (single file). Open at https://supplefacts.brokenpromiseshealthcare.org/supplefacts.html
- Scan test page: `scan-test.html` (developer page, not indexed)
- Functions: `netlify/functions/ai-summary.js` (Generate summary), `netlify/functions/barcode-lookup.js` (barcode to product name); shared rate limiter in `netlify/lib/ratelimit.js`
- Website it links to (separate repo/project): https://supplements.brokenpromiseshealthcare.org (the app's "Investigate the Evidence" buttons open its /product-lookup page)

## Netlify settings
- Project name: `supplefacts` (preview addresses look like `barcode-dev--supplefacts.netlify.app`; if you pick another name, update `PREVIEW_HOST` in `netlify/functions/barcode-lookup.js` and the ALLOWED_ORIGINS value)
- Build command: none. Publish directory: `.` (set in netlify.toml). Functions: `netlify/functions`
- Custom domain: supplefacts.brokenpromiseshealthcare.org (Cloudflare CNAME, DNS only)

## Environment variables (Project configuration > Environment variables)
| Name | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | secret; Functions + Runtime |
| `FDC_API_KEY` | secret; USDA FoodData Central key from api.data.gov |
| `ALLOWED_ORIGINS` | comma list: `https://supplefacts.brokenpromiseshealthcare.org,https://barcode-dev--supplefacts.netlify.app` |
| `UPCITEMDB_KEY` | optional paid key; without it the free 100/day endpoint is used |
| `RATE_SUMMARY_PER_HOUR`, `RATE_SUMMARY_PER_DAY`, `RATE_BARCODE_PER_HOUR`, `RATE_BARCODE_PER_DAY` | optional; defaults 20, 600, 60, 1500 |

Never put keys in the code or in this repo.

## Not medical advice
SuppleFacts is for education. Label data is manufacturer-reported.
