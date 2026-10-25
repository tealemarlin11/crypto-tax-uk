# 🪙 crypto-tax-uk

A free, private UK crypto tax tracker. Built for one person.

## What it does
- Stores your crypto transactions (in your browser only)
- Works out gains with HMRC rules: same-day, 30-day, Section 104 pool
- Makes a tax report per tax year (SA108 figures, CSV, PDF)
- Tracks portfolio value
- Checks your data for problems
- Syncs Kraken and Binance history with read-only keys

## Open the app
- **On GitHub Pages:** Settings → Pages → Deploy from `main`.
- **On your computer:** double-click `index.html`.

## Sync Kraken and Binance (on your computer only)
1. Make **read-only** API keys.
   - Kraken: Query Funds, Query Ledger Entries, Query Open Orders & Trades.
   - Binance: Enable Reading only. Restrict to your IP.
2. In the `sync` folder, copy `.env.example` to `.env`. Fill in the keys.
3. Run `node sync.mjs` (Node 18 or newer).
4. In the app, go to **Add** and import `exchange-import.csv`.
5. Open the **Check** tab. Fix any £0 rows.

## Rules
Rates and allowances are at the top of `index.html` (the `RULES` block).
A weekly GitHub Action opens an issue if the GOV.UK pages change.
Then you update `RULES` by hand.

## 🔒 Never commit
- `.env`
- `exchange-import.csv`
- backup `.json` files

## ⚠️ Not tax advice
It is an estimate. Check figures before you file.
Not covered: DeFi edge cases, margin, futures, brought-forward losses.
