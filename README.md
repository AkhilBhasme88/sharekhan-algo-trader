# Sharekhan Algo Trader (local scaffold)

A local-only skeleton: a Vue 3 frontend + a small Express backend that
holds your Sharekhan API credentials and proxies calls. Runs entirely
on your own laptop.

```
sharekhan-algo-trader/
├── backend/     # Express server — holds secrets, talks to Sharekhan
└── frontend/    # Vue 3 (Vite) UI — talks only to localhost:4000
```

## Why two processes instead of one Vue app

Your Sharekhan **API secret** is needed to exchange the login token for
an access token, and a secret embedded in browser JavaScript is not
actually secret — anyone can read it from devtools. The backend keeps
it in a local `.env` file instead, and the browser never sees it.

## 1. Get Sharekhan API credentials

1. Register on Sharekhan's API developer portal and create an app
   (a "Partners App" in some flows) to get an **API Key** and **API
   Secret**.
2. Register `http://localhost:4000/api/auth/callback` as the app's
   redirect/callback URL.
3. As of April 2026, SEBI's retail algo-trading rules require API
   access to come from a **static IP** registered with your broker,
   plus OAuth login + 2FA. If you're on a home connection with a
   dynamic IP, you'll likely need to request a static IP from your ISP
   (or run this from a small VPS instead) and register it with
   Sharekhan before live orders will go through.

## 2. Backend setup

```bash
cd backend
cp .env.example .env
# edit .env and fill in SHAREKHAN_API_KEY / SHAREKHAN_API_SECRET
npm install
npm run dev
```

Runs on `http://localhost:4000`.

## 3. Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Runs on `http://localhost:5173`. Open it, click **Login with
Sharekhan**, log in on Sharekhan's own page, and you'll land back on
the dashboard.

## Running both at once

Instead of two terminals, install once from the project root and use
the combined dev script:

```bash
npm run install:all   # installs backend/ and frontend/ deps
npm run dev            # starts both, with prefixed/colored log output
```

This uses `concurrently` (added as a root dependency) to run
`backend`'s and `frontend`'s own `npm run dev` scripts in parallel and
tags each line of output with `backend` or `frontend` so you can tell
which process logged what. Ctrl+C in that terminal stops both.

The frontend's dev script now runs with `--open`, so `http://localhost:5173`
opens automatically in your default browser once Vite is ready — no
need to hunt for the link in the terminal output. The backend still
just logs its URL (`http://localhost:4000`) to the console, since
there's nothing to visit there directly.

## Important: verify the API details before trading real money

`backend/src/sharekhanClient.js` now uses Sharekhan's **official
`sharekhan-api` Node SDK** for session exchange, holdings, funds, and
order placement — this replaced an earlier hand-rolled version that
guessed at the token-exchange request shape and failed. Two things
about this SDK to know:

- It's **not published on the npm registry** — despite its own
  README saying `npm i sharekhan-api`, nobody ever ran `npm publish`
  on it. `backend/package.json` instead points npm at the GitHub repo
  directly (`"sharekhan-api": "github:Sharekhan-API/shareconnectnodejs"`),
  which is why a plain `npm install sharekhan-api` fails with a 404 —
  always run `npm install` from inside `backend/` so it picks up that
  git reference from `package.json`.
- Its own `package.json` also has a **broken `"main"` field** —
  pointing at a root `index.js` that doesn't exist in the repo (the
  real code lives somewhere under `lib/`), so a plain
  `import { SharekhanApi } from "sharekhan-api"` throws
  `ERR_MODULE_NOT_FOUND`. `backend/src/sharekhanSdkLoader.js` works
  around this by scanning the installed package at startup for
  whichever file actually exports `SharekhanApi`, instead of
  hardcoding a guessed filename. `sharekhanClient.js` calls
  `loadSharekhanApi()` instead of importing the package directly. If
  this loader ever fails to find the class (it'll throw a clear error
  telling you so), run
  `dir node_modules\sharekhan-api -Recurse -Name` inside `backend/`
  and check the real package layout.

You also need one more credential the SDK requires beyond API
key/secret:

- `SHAREKHAN_CUSTOMER_ID` — your Sharekhan Customer/Login ID (not the
  API key), required by the SDK's constructor.

Still worth checking before trusting it with real money:

- The login-URL-building step (`buildLoginUrl`) is still built
  manually, since the Node SDK's README doesn't document a helper for
  it — only the Java SDK exposes `getLoginURL`. Confirm this still
  matches your developer-portal docs if the initial redirect ever
  breaks.
- The SDK's README only documents `getHoldings`, `getFundsDetails`,
  and order placement/history methods — no plain "get quote" or "get
  positions" call. The repo's `example/test.js` (its real usage
  sample, more complete than the README) additionally shows
  `getAllOrdersHistoryOfDay`, `getAllTradesHistory`,
  `getHistoryByOrderID`, `getTradeGeneratedByOrder`,
  `getActiveScriptOfDay`, and `getScriptMasterCSV` — but still no
  quote/positions call and no historical-chart-data call (see below).
  Check `node_modules/sharekhan-api/lib` (that example imports from
  `../lib`, confirming that's where the real code lives) for the full
  method list if your strategy needs live quotes.
- `placeOrder`'s expected shape (`scripCode`, `tradingSymbol`,
  `exchange`, `transactionType: 'B'|'S'`, etc.) comes straight from
  the SDK's own example — test with tiny quantities before wiring up
  real strategy logic.

## Safety switch: backtest-only mode (default)

`POST /api/orders/place` is refused by default — both at the route
level (`backend/src/routes/orders.js`) and again inside
`placeOrder()` itself (`assertLiveTradingEnabled()` in
`sharekhanClient.js`), so a live order can't slip through even if
something calls the client function directly instead of going
through the route. Historical data and scrip search are unaffected;
only order placement is gated.

To actually place a live order, set `ENABLE_LIVE_TRADING=true` in
`backend/.env` and restart the backend. There's currently no
`modifyOrder`/`cancelOrder` wired up anywhere in this codebase (the
SDK exposes `modifyOrder`/`cancelOrder`, but nothing here calls
them yet) — if you add that later, route it through
`assertLiveTradingEnabled()` too rather than calling the SDK
directly.

## Historical data: SDK has none — direct REST call instead (confirmed)

The community Node SDK's `example/test.js` exercises essentially
every other endpoint — new/modify/cancel order, order history, trade
history, holdings, `getActiveScriptOfDay`, `getScriptMasterCSV`, even
the websocket feed — but never once calls anything historical/chart-
shaped, unlike the Java/R/Python SDKs which each have their own name
for it (`getHistorical`/`get_historical`/`historicaldata`). That's
strong evidence this particular package doesn't wrap historical data
at all for Node.

`getHistoricalData()` in `sharekhanClient.js` still tries a list of
candidate method names (`HISTORICAL_METHOD_CANDIDATES`) against your
actual installed SDK first, in case a newer version adds one — but
for the currently installed build, `npm run inspect-sdk` (or
`GET /api/market/debug/sdk-methods`) confirms nothing historical-
shaped exists, so it falls through to a **direct REST call**,
bypassing the SDK entirely for just this one endpoint:

```
GET https://api.sharekhan.com/skapi/services/historical/{exchange}/{scripcode}/{interval}
Headers: Content-Type: application/json
         access-token: <token from /services/access/token>
         api_key: <your SHAREKHAN_API_KEY>
```

Path and `access-token` header confirmed straight from Sharekhan's
Historical Chart Data documentation. `api_key` wasn't in that
endpoint's doc table but turned out to be required too — a live call
without it came back `401 auth_error: "Please provide valid api key"`.
Evidently `api_key` is a common header Sharekhan expects across
REST endpoints generally, not something called out per-endpoint in
each doc page. Both headers are sent now; a 401/403 error message
tells you to check whether it's the token (try logging in again) or
the key (confirm `SHAREKHAN_API_KEY` in `backend/.env` matches your
developer-portal app) before assuming it's a new problem.

**A second, sneakier version of the same auth_error also showed up**:
Sharekhan sometimes answers with a plain HTTP `200` whose *body* is
actually an error — `{ status: 401, message: "Please provide valid
api key", errorType: "auth_error" }` — rather than a real `4xx`.
axios only throws on the latter, so the first version of this code
treated that body as valid candle data and happily labeled it
`"source": "sharekhan"` as if it had succeeded. `fetchHistoricalDirect()`
now detects any response body with an `errorType` field and throws on
it the same way as a real HTTP error, so it surfaces as a proper 502
with Sharekhan's actual message instead of masquerading as data. If
it recurs, the error message now also notes: if it only fails for
some scripCodes and not others in the same session, the token/key
are fine and it's more likely a scrip-specific entitlement gap than
an auth problem — worth confirming with Sharekhan support if that
pattern holds for a particular scrip.

`interval` accepts exactly these documented values (validated up
front — both in `fetchHistoricalDirect()` and again as a 400 in the
`/api/market/historical` route, before either ever calls Sharekhan):
`daily`, `weekly`, `monthly`, `quarterly`, `halfyearly`, `yearly`,
`1minute`, `3minute`, `5minute`, `10minute`, `15minute`, `30minute`,
`60minute`, `90minute`. The full list is exported from
`sharekhanClient.js` as `VALID_HISTORICAL_INTERVALS` and served at
`GET /api/market/intervals` (no auth needed) — `Dashboard.vue`'s
interval dropdown now pulls from that endpoint on load instead of
only offering `daily`, so it can't drift out of sync with what the
server actually validates against.

`SHAREKHAN_BASE_URL` in `.env` (already present, previously unused)
now actually drives this call — override it there if your account
ever needs a different API host.

## When Sharekhan doesn't come through: automatic Yahoo Finance fallback

Sharekhan's historical endpoint can fail to provide data two
different ways, and `GET /api/market/historical` now falls back to
Yahoo Finance for **either**:

1. **Hard failure** — a real error, most commonly the `401 auth_error:
   "Please provide valid api key"` case (see above), which kept
   recurring in testing even with both headers correctly set.
2. **Soft failure** — Sharekhan answers `200` but reports **no data
   for that specific scrip** (a real case hit while testing:
   `scripCode=2885`, exchange `NC`, `daily` returned a "No Historic
   data available" body).

Either way, the route now: catches the failure, looks up the scrip's
trading symbol from the cached scrip master (`resolveTradingSymbol()`),
and retries via **Yahoo Finance** (`getYahooHistoricalData()` in the
new `openDataSources.js`) — a free, unauthenticated public endpoint,
no Sharekhan session/api_key/access-token involved. The response is
always `{ source, data }`, plus `sharekhanReason` explaining *why*
Sharekhan didn't provide it whenever the fallback was used — `source`
is `"sharekhan"` or `"yahoo-finance"` so you always know which one
actually answered. `Dashboard.vue` shows both under the fetch button
now, along with an interval-approximation `note` when one applies
(see below).

This is a deliberate change from an earlier version of this fallback,
which only triggered on the "soft failure" case and let hard failures
(including the 401) surface as a plain error — on the reasoning that
masking an auth problem behind Yahoo data risked hiding something
that needed fixing. Since the 401 kept recurring anyway despite the
headers being correct, backtesting continuity was prioritized over
that caution: any Sharekhan failure now falls through to Yahoo, and
`sharekhanReason` keeps the underlying problem visible instead of
silently dropping it.

Why Yahoo and not NSE's own site: NSE's historical API sits behind
Akamai bot protection that expects a browser-like cookie handshake —
workable, but fragile and prone to silently breaking whenever NSE
tweaks it. Yahoo's chart endpoint needs no auth/cookies at all and is
what most open-source Indian-equities backtesting tooling already
relies on, so it was chosen for reliability over exactness.

Two things to know about the fallback data:
- **Symbols**: NSE trading symbols get `.NS` appended, BSE gets
  `.BO` (`EXCHANGE_TO_YAHOO_SUFFIX` in `openDataSources.js` — extend
  it if you trade other exchanges; note MCX commodities aren't on
  Yahoo under a simple suffix at all).
- **Intervals**: Yahoo's buckets don't line up 1:1 with Sharekhan's.
  `quarterly`/`halfyearly`/`yearly` all fall back to monthly candles
  (Yahoo has no such buckets at all — this is an approximation, not a
  resample), and `3minute`/`10minute`/`90minute` fall back to the
  nearest bucket Yahoo does support. Every such substitution is
  reported in the response's `note` field rather than silently
  pretending it's exact — see `INTERVAL_MAP` in `openDataSources.js`
  for the full mapping.

You can also skip Sharekhan entirely and call the fallback directly:
`GET /api/market/historical-open?symbol=RELIANCE&exchange=NC&interval=daily`
— no login required, useful for backtesting a scrip you don't want to
spend a Sharekhan API call on, or for double-checking a Sharekhan
result against an independent source.

## Scrip master: fetched once per exchange, filtered locally

`getScripMaster(exchange)` in `sharekhanClient.js` calls
`getScriptMasterCSV(exchange)` — confirmed straight from the comment
`//script details` / `sharekhan_api.getScriptMasterCSV('NC')` in
`example/test.js` — which returns the **entire** exchange's tradable
list as CSV in one call, not something meant to be called per
symbol. This file now:

- Parses that CSV generically (first row → object keys, whatever
  they turn out to be — the real column names are still unverified
  until you have a live response to inspect).
- Caches the parsed rows in memory per exchange for 24h, since the
  master list doesn't change intraday.
- `GET /api/market/scrips?exchange=&search=&refresh=true` filters
  that cached list — the `refresh=true` param forces a fresh fetch
  (e.g. after a corporate action changes a listing) instead of
  serving from cache.

This means the first search for a given exchange does one real
network call; every search after that (including a fresh browser
session, as long as the backend hasn't restarted) filters in memory
instead of hitting Sharekhan again. `Dashboard.vue`'s `applyScrip()`
was also made more robust to this — it scans every column
case-insensitively for something scrip-code-shaped
(`/scrip.*code/i`, then `code`/`token`) instead of checking a fixed
list of exact key names, since the real CSV headers are still
unverified.

`getActiveScriptOfDay(exchange)` (also confirmed in that same
example) is kept as a fallback candidate in
`SCRIP_MASTER_METHOD_CANDIDATES` — it's a narrower "what actually
traded today" list rather than the full master, so it's only used
if `getScriptMasterCSV` isn't found on your installed build.

## Frontend: tabular display instead of raw JSON dumps

Holdings, scrip search results, and historical candles were
previously shown as raw `JSON.stringify()` dumps in `<pre>` blocks —
readable but not something you could actually scan. `Dashboard.vue`
now renders all three through a shared `DataTable.vue` component
(`frontend/src/components/`) instead.

Since several of these APIs' real field names are still unverified
against a live response (the scrip master CSV, Sharekhan's raw
historical payload, holdings), `DataTable` doesn't assume a fixed
column list — it derives columns from the union of keys actually
present across the rows it's given, so it degrades gracefully rather
than silently showing blank columns the moment a name is wrong.
Rows/columns are capped (`maxRows`/`maxColumns` props, default 200/10)
so an unexpectedly wide or long response doesn't produce an
unusable table.

Each endpoint's response is unwrapped into a plain row array before
reaching the table, via a small `extractRows()` helper in
`Dashboard.vue` that tries common wrapper shapes in order
(`candles`, `data`, `holdings`, etc.) — since holdings/scrips/
historical each wrap their actual array differently, and (for
historical) that shape further varies by which source answered
(Sharekhan vs. the Yahoo fallback above). Scrip search rows are also
still clickable — the row-click fills in the scrip code field, same
as before.

## About session persistence

Sharekhan's access token is valid for roughly 24 hours, and SEBI's
algo-trading rules require a fresh authenticated login each trading
day — there's no way to make the login itself permanent, and you
shouldn't want to (it's a security control on the broker's side).

What this app does handle for you:

- The access token is written to `backend/data/token.json`, so
  restarting the backend, closing your laptop, or a crash mid-session
  won't force a re-login — only actual expiry will.
- Opening the frontend while a session is still valid skips the login
  screen automatically and drops you straight on the dashboard.

You'll still need to click "Login with Sharekhan" once per ~24h
window (in practice, once each trading morning).

## Current focus: connection + backtest data, not live orders

The dashboard leads with **Find scrip code** and **Historical data**
since that's what backtesting needs — see the "Scrip master" and
"Historical data" sections above for how each is actually wired up
now. The manual order form still exists (collapsed, clearly marked
"blocked — backtest-only mode") for whenever you're deliberately
ready to test live — see "Safety switch" above.

`scripCode` is Sharekhan's internal numeric code for an instrument,
not its trading symbol (e.g. "RELIANCE"). Two ways to find one:

- **In-app (preferred)**: the dashboard's "Find scrip code" section
  calls `GET /api/market/scrips?exchange=&search=`, backed by
  `getScripMaster()` — searches the full cached list, not a live
  per-call lookup. Clicking a result fills in the scripCode field
  above automatically.
- **Offline fallback**: Sharekhan also publishes a full scrip master
  at <https://www.sharekhan.com/Downloads/Tradable_scrips.xls> — no
  login needed, open in Excel and search — useful if you want to
  cross-check the in-app result against something independent.

## Confirmed working: login end-to-end

As of this build, a full login round-trip has been confirmed against
the real API — Sharekhan's response includes your name, customer ID,
login ID, enabled exchanges, and a real JWT access token. The token
lives at `data.data.token` in the SDK's response (now fixed in
`exchangeRequestToken()` — earlier guesses at the field name were
close but not exact). If login ever breaks again, compare the raw
`[CLIENT] generateSession* raw response:` log line against this
confirmed shape first before assuming it's a new bug.

## Fixed: request_token corruption in the callback

Express's default query parser follows form-encoding convention and
turns `+` into a space. Sharekhan's `request_token` contains literal
`+` characters, so it was getting silently corrupted before the token
exchange — causing a `400 Bad Request` from Sharekhan with no useful
detail. `backend/src/routes/auth.js` now pulls the raw token straight
from the URL instead of Express's parsed query object to avoid this.

## Fixed: invalid SHAREKHAN_VERSION_ID also caused a 400

Separately, `.env` had `SHAREKHAN_VERSION_ID=1` set. Sharekhan's docs
say only a blank value, `1005`, or `1006` are valid — `1` isn't, and
got silently accepted on the login-page redirect but rejected by the
token-exchange endpoint. `sharekhanClient.js` now warns at startup if
`SHAREKHAN_VERSION_ID` is set to anything outside that allowed set,
so this mistake surfaces immediately instead of as an opaque `400`
after a full login round-trip.

## Backtest target: Reliance Industries

The dashboard defaults the scrip search to `RELIANCE` on NSE Cash
(`NC`) and runs it automatically on load, so its real `scripCode`
shows up right away — click the result to fill in the historical-data
form. I did **not** hardcode a numeric scripCode for it: Sharekhan
uses its own internal numbering scheme (their Java SDK's own example
shows ONGC as `2475`, which matches no other public code for ONGC),
their live scrip-locator page needs an authenticated portal session I
don't have, and I can't parse their downloadable `.xls` scrip master
from here. Guessing a number risked silently pulling the wrong
instrument into your backtest, so the safer move was making the real
lookup one click away instead.

## Tracing / log tags

Both sides now log with consistent tags so a failure's origin is
obvious without digging:

- **Backend** (terminal running `npm run dev` in `backend/`):
  `[BOOT]` startup/env check, `[REQ]` every HTTP request in/out with
  status + timing, `[AUTH]` login/callback/token flow, `[CLIENT]`
  every call into the Sharekhan SDK (with the raw response or error
  body), `[MARKET]` / `[ORDERS]` route-level logs, `[MW]` the auth
  middleware. `[OK]`/`[FAIL]` suffixes mark success/failure.
- **Frontend** (browser DevTools console): `[API]` every request the
  app makes to the backend (via an axios interceptor, so this covers
  every call automatically), `[DASHBOARD]` / `[LOGIN]` / `[ROUTER]`
  which UI action or navigation triggered a given call.

To trace a failure: reproduce it, then read top-to-bottom through
whichever `[FAIL]` lines show up in each console — the backend
terminal shows exactly which internal step broke (env/auth/client
call), and the browser console shows exactly which button/route
triggered the request that failed.

## Backtest engine: session-aware, shared-capital, portfolio-level

`POST /api/backtest/run` replaces the old "Algo strategy" placeholder.
Given a list of scrips, it fetches each one's intraday candles (via
`getHistoricalWithFallback()` in `marketDataService.js` — the same
Sharekhan→Yahoo fallback the historical-data section above describes),
runs a strategy against each independently, then applies **one shared
capital pool** across all of them so concurrent positions are actually
capital-constrained like a real account — not each scrip pretending it
has its own ₹1,00,000.

**Module layout** (`backend/src/backtest/`):
- `sessions.js` — IST-aware time helpers. Trading-hours logic needs
  explicit IST handling regardless of the server's own timezone (a
  server running in UTC would otherwise silently compute the wrong
  session boundaries) — every time comparison here shifts the UTC
  instant by the IST offset rather than trusting `Date.getHours()`.
- `capitalTracker.js` — enforces the per-trade cap (`maxPerTrade`,
  default ₹20,000) and total capital (`capital`, default ₹1,00,000).
  `capital / maxPerTrade` = the theoretical max concurrent positions
  (5 at the defaults) — real concurrency can be lower if positions
  aren't evenly sized.
- `strategies/openingRangeBreakout.js` — the default/example strategy,
  chosen because it fits an intraday session window directly and no
  specific entry/exit logic was given. **Opening Range Breakout**: the
  first `openingRangeMinutes` (default 15, so 09:15–09:30) sets a
  high/low range; a close outside it is the entry, with a stop on the
  range's opposite side and a target at `targetMultiple` (default `3`,
  i.e. a nominal **1:3 risk:reward** — a winner covers three losers of
  the same size, needing only a ~25% win rate to break even) times the
  range's width. Since entries trigger on a *close* beyond the range
  rather than exactly at its edge, the realized R:R on any given trade
  is often a bit under the nominal 1:3 (breakout slippage past the
  range boundary) — the target/stop levels themselves are still exactly
  1x/3x the range width apart. One trade per scrip per day by default
  (`oneTradePerDay`) — the classic ORB rule, added after testing showed
  the strategy would otherwise immediately re-enter right after a
  target hit if price was still beyond the range. Forces a square-off
  at the session's last candle if neither stop nor target was hit
  (intraday can't carry positions overnight). To use a different
  strategy: write a module with the same `generateTrades(candles,
  options) -> [trade]` shape and register it in `STRATEGIES` in
  `engine.js`.
- `engine.js` — the portfolio-level orchestrator. Each strategy
  resolves a scrip's candles into **complete trade outcomes**
  (entry/exit price, time, P&L per share) independent of capital — a
  scrip's own price path doesn't depend on what else the account is
  trading. The engine's only job is merging every scrip's resolved
  trades into one chronological timeline and greedily deciding which
  ones capital can actually afford, freeing capital as earlier
  positions' exit times pass. Trades that couldn't be afforded are
  returned separately as `skippedTrades`, not silently dropped.

**Known simplification**: capital is freed/re-deployed based on each
trade's entry/exit *times* processed in order — accurate for "did this
trade have room to open," but doesn't model slippage from many trades
competing for the same capital at the exact same instant. Fine for a
backtest, not a claim of exact live-market simulation.

**Request shape**:
```json
POST /api/backtest/run
{
  "scrips": [{ "exchange": "NC", "scripCode": "2885" }],
  "interval": "5minute",
  "capital": 100000,
  "maxPerTrade": 20000,
  "strategy": "opening-range-breakout",
  "strategyOptions": {
    "session": { "start": "09:15", "end": "10:15" },
    "openingRangeMinutes": 15,
    "targetMultiple": 3,
    "allowShort": true
  }
}
```
`GET /api/backtest/defaults` (no auth needed) returns the same
defaults shown above, so the frontend form and the engine can't drift
apart. Neither route needs a Sharekhan session — the underlying fetch
falls back to Yahoo Finance automatically, which is exactly what you
want for a backtest.

`Dashboard.vue`'s "Backtest" section wraps this: add one or more
scrips, set capital/session/interval, run, and see the summary
(trades, win rate, total P&L, peak capital deployed) plus the full
trade log and any capital-skipped trades as tables via `DataTable.vue`.

## Index F&O backtest: NIFTY / BANKNIFTY futures (separate block)

A deliberately separate route, strategy, and UI section from the
stock backtest above — `POST /api/index-backtest/run`,
`backend/src/routes/indexBacktest.js`,
`backend/src/backtest/strategies/emaCrossoverScalping.js`, and its own
card in `Dashboard.vue` ("Index F&O scalping backtest"). Three real
differences justify keeping this separate rather than bolting it onto
the stock routes:

1. **Data source.** NIFTY/BANKNIFTY aren't Sharekhan scrip-master
   entries — there's no exchange/scripCode pair to look up, and no
   Sharekhan fallback chain the way stocks have. Their candles come
   straight from Yahoo's own index tickers (`^NSEI`, `^NSEBANK` —
   `INDEX_YAHOO_SYMBOLS` in `openDataSources.js`), via a dedicated
   `getIndexHistoricalData(indexName, interval)` helper. Both routes
   are login-free for the same reason as `/api/backtest/run`: nothing
   here depends on a live Sharekhan session either.
2. **Position sizing is lot-based, not capital-based, and per-index.**
   A single index "point" is worth thousands of rupees (Nifty
   ~24,000, BankNifty ~51,000+), so the stock routes' `budget ÷ price
   = whole shares` model breaks down completely. Real F&O exposure is
   via futures with a **fixed lot size** — and NIFTY and BANKNIFTY
   don't even share the same one, so a single global quantity breaks
   the moment you backtest both together (confirmed by testing: with
   one shared number, both indices traded the same quantity, which is
   wrong). Fixed via `createFixedQuantityTracker()` in
   `capitalTracker.js` accepting either one number or a **map keyed by
   scripCode** — `engine.js` resolves each signal's quantity by its
   own scrip. The route computes that map from `numberOfLots × each
   index's lot size` (`INDEX_LOT_SIZES` in `openDataSources.js`:
   **NIFTY = 65, BANKNIFTY = 30**, confirmed current as of the January
   2026 NSE revision — these change periodically by exchange circular,
   so treat them as a starting default and override via the `lotSizes`
   request field if they've since gone stale; check NSE's site or your
   broker's contract specs for the current value). `capital` is still
   accepted, but only to report a return-on-capital percentage and
   sanity-check margin against it — it doesn't constrain sizing here.
3. **Margin estimation.** The summary reports `peakNotionalExposure`
   (quantity × price) rather than `peakCapitalDeployed` — labeling
   notional value "capital deployed" would misleadingly dwarf the
   account's real capital (seen directly while testing: 130 units of
   Nifty + 60 of BankNifty peaked at ~₹61,80,000 notional against a
   stated ₹1,00,000 capital, which is correct for notional exposure
   but would look like a broken calculation if mislabeled). An optional
   `marginPercent` (default 12, a rough index-futures SPAN+exposure
   ballpark — **not a real broker calculation**, which varies by
   volatility/broker/day) turns that into `approxMarginRequired`, with
   a `marginExceedsCapital` flag if it would exceed your stated
   capital — confirmed working in testing (2 lots each of NIFTY/
   BANKNIFTY against ₹1,00,000 capital correctly flagged
   `marginExceedsCapital: true`). Check your broker's actual margin
   calculator before trading real money regardless of what this shows.

**Scope: futures only, not options.** Options need a strike, a
premium, and an options-pricing model (time decay, implied
volatility) to backtest meaningfully, and reliable historical NSE
options-chain data isn't available through this app's free data
sources (Yahoo Finance doesn't carry NSE option chains). Modeling
options with made-up premiums would produce numbers that look precise
but aren't trustworthy — futures backtesting (linear payoff, same
directional move as the underlying) on the same EMA-crossover
strategy is the honest version of this that the current data actually
supports.

**Strategy: EMA crossover scalping** (`emaCrossoverScalping.js`) — a
fast EMA (default period 5) crossing above/below a slower EMA (default
20) is the entry signal, with a **fixed-point** stop and target
(`stopLossPoints`/`targetPoints`, default 15/30 — points rather than a
range-width multiple, since that's the more natural unit for index
values). Exits on whichever comes first: stop, target, or an opposite
crossover; forced square-off at session end otherwise. Unlike ORB's
one-trade-per-day rule, this deliberately allows multiple trades per
session (`maxTradesPerDay`, default 5, caps runaway whipsaw trading in
choppy periods) — scalping is about taking several small, quick
opportunities, not one setup a day.

**Every field is self-documented.** `GET /api/index-backtest/defaults`
returns a `fieldInfo` map — a plain-language description for every
field this route's request body takes (`FIELD_INFO` in
`indexBacktest.js`). `Dashboard.vue` reads this at runtime via a small
`fieldHint(key)` helper instead of hardcoding a second copy of the
same text, so the on-screen help and the backend's own understanding
of each field can't drift apart — the same pattern this app already
uses for `/market/intervals` and `/backtest/defaults`.

**Request shape**:
```json
POST /api/index-backtest/run
{
  "indices": ["NIFTY", "BANKNIFTY"],
  "interval": "3minute",
  "strategy": "ema-crossover-scalping",
  "strategyOptions": { "stopLossPoints": 15, "targetPoints": 30, "allowShort": true },
  "numberOfLots": 1,
  "lotSizes": { "NIFTY": 65, "BANKNIFTY": 30 },
  "maxConcurrentPositions": 2,
  "capital": 100000,
  "marginPercent": 12
}
```
`lotSizes` is optional — omit it to use the current defaults above;
include it only to override a value that's gone stale since NSE's
next revision. `GET /api/index-backtest/defaults` also returns
`recommendedInterval: "3minute"` — worth noting Yahoo only keeps
1-minute candles for the trailing 7 days (see `INTERVAL_MAP` in
`openDataSources.js`), so `1minute` will return a much shorter history
than `3minute`/`5minute` will.

## Live signal check: paper trading only, no path to a real order

`POST /api/live-signal/check` (`backend/src/routes/liveSignal.js`) is
where a strategy signal meets an actual order — deliberately stopping
one step short of sending it. This exists because "we don't need to do
actual trade" was explicit: rather than gate this behind
`ENABLE_LIVE_TRADING` the way `POST /api/orders/place` is, this
feature's paper-order path (`backend/src/liveSignal/orderDispatcher.js`)
**never imports or calls `placeOrder()` at all**. There's no setting
that turns this into live trading — only a future code change would,
and that's deliberate: a config flag is something that could be
flipped by accident (a stale `.env`, a copy-pasted deploy); the absence
of a code path can't be.

**What it does**: fetches whatever candles are currently available for
a scrip (via the same `getHistoricalWithFallback`/
`getIndexHistoricalData` used by the backtest routes — stocks and
NIFTY/BANKNIFTY both work here), runs the chosen strategy's
`generateTrades()` against them, and checks whether a signal's
`entryTime` matches the *most recent* candle — i.e. it just fired,
right now, not hours ago. If so, `dispatchPaperOrder()` builds an order
in exactly the shape `placeOrder()` expects (`scripCode`,
`tradingSymbol`, `exchange`, `transactionType: 'B'|'S'` — confirmed
field names from the SDK's own example, same as `placeOrder()` already
uses) and logs it instead of sending it. Confirmed working via a
three-poll test: no signal on the range-forming candles, a fresh
signal exactly on the breakout candle, and correctly *not* re-firing
on a later poll once that same signal was no longer on the latest
candle — the dedup (`lastDispatchedEntryTime` map, keyed by exchange +
scripCode + strategy) prevents the same signal from being logged twice
if you check again before the next candle closes.

**Not a background scheduler.** This is a request-driven check, not a
cron job running inside the server — `Dashboard.vue`'s "Live signal
check" card calls it on a button click, or on a `setInterval` while an
"auto-check" toggle is on and the page stays open (cleaned up via
`onUnmounted` so it doesn't keep polling — and keep logging paper
orders — after you navigate away). A real always-on setup would want a
proper scheduler or websocket feed server-side instead; this fits a
dev server you're actively watching, which is where this app is right
now.

**Request shape**:
```json
POST /api/live-signal/check
{
  "instrumentType": "stock",
  "exchange": "NC",
  "scripCode": "2885",
  "interval": "5minute",
  "strategy": "opening-range-breakout",
  "strategyOptions": {},
  "quantity": 1
}
```
For indices, set `"instrumentType": "index"` and `"scripCode": "NIFTY"`
or `"BANKNIFTY"` (no `exchange` needed). `quantity` is supplied
directly rather than derived from capital/lots — this route checks one
scrip at a time and isn't trying to replicate the backtest routes'
portfolio-level position sizing.

`GET /api/live-signal/paper-trades` returns everything logged so far;
`DELETE /api/live-signal/paper-trades` clears it. The log is in-memory
only — restarting the backend clears it, since this is for watching a
strategy fire in near-real-time, not a durable trading journal.

**When you're ready for this to place real orders** (a deliberate
future step, not a flag flip): `dispatchPaperOrder()`'s job would be
replaced with an actual `await placeOrder(orderIntent)` call, still
behind `ENABLE_LIVE_TRADING` the same way `/api/orders/place` already
is. Until that code change is made, nothing this feature does can
place a real order, however it's configured.
