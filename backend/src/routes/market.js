import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getScripMaster, getSdkMethodInventory, VALID_HISTORICAL_INTERVALS } from "../sharekhanClient.js";
import { getYahooHistoricalData } from "../openDataSources.js";
import { getHistoricalWithFallback } from "../marketDataService.js";

const router = Router();

// GET /api/market/debug/sdk-methods — no auth required, since this only
// introspects the SDK object's own methods and never calls the network.
// Hit this first whenever getHistoricalData/getScripMaster throw
// "is not a function" — it shows exactly which method names this
// installed sharekhan-api build really exposes.
router.get("/debug/sdk-methods", (req, res) => {
  console.log("[MARKET] /debug/sdk-methods requested");
  try {
    const inventory = getSdkMethodInventory();
    console.log(`[MARKET][OK] /debug/sdk-methods found ${inventory.allMethods.length} methods`);
    res.json(inventory);
  } catch (err) {
    console.error("[MARKET][FAIL] /debug/sdk-methods:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market/intervals — no auth required, static list. Lets the
// frontend build its interval dropdown from the same source of truth
// this route validates against, instead of a second hardcoded copy.
router.get("/intervals", (req, res) => {
  res.json(VALID_HISTORICAL_INTERVALS);
});

// GET /api/market/historical-open?symbol=RELIANCE&exchange=NC&interval=daily
// Pulls straight from Yahoo Finance — no Sharekhan session, api_key, or
// access-token needed at all, since this is a plain public HTTPS call.
// Useful both as a manual alternative when Sharekhan's own historical
// endpoint reports no data for a scrip, and for backtesting scrips you
// don't want to spend a Sharekhan API call on. `symbol` can be a bare
// NSE/BSE trading symbol (paired with `exchange` for the right Yahoo
// suffix) or an already-suffixed Yahoo symbol like "RELIANCE.NS".
router.get("/historical-open", async (req, res) => {
  const { symbol, exchange = "NC", interval = "daily" } = req.query;
  console.log(`[MARKET] /historical-open symbol=${symbol} exchange=${exchange} interval=${interval}`);
  if (!symbol) {
    return res.status(400).json({ error: "symbol query param is required (e.g. RELIANCE)." });
  }
  try {
    const data = await getYahooHistoricalData(symbol, interval, exchange);
    console.log(`[MARKET][OK] /historical-open returning ${data.candles.length} candles from ${data.source}`);
    res.json(data);
  } catch (err) {
    console.error("[MARKET][FAIL] /historical-open:", err.message);
    res.status(502).json({ error: err.message });
  }
});

router.use(requireAuth);

// GET /api/market/scrips?exchange=NC&search=ONGC&refresh=true
// The full scrip master for `exchange` is fetched once (via
// getScripMaster) and cached for 24h — this only ever filters that
// cached list in memory, it does not call Sharekhan per search. Pass
// refresh=true to force a fresh fetch (e.g. after a corporate action
// adds/removes a listing).
router.get("/scrips", async (req, res) => {
  const { exchange = "NC", search = "", refresh } = req.query;
  console.log(`[MARKET] /scrips exchange=${exchange} search="${search}" refresh=${refresh === "true"}`);
  try {
    const list = await getScripMaster(exchange, { forceRefresh: refresh === "true" });
    const filtered = search
      ? list
          .filter((row) => JSON.stringify(row).toLowerCase().includes(String(search).toLowerCase()))
          .slice(0, 50)
      : list.slice(0, 50);
    console.log(`[MARKET][OK] /scrips returning ${filtered.length} of ${list.length} total rows`);
    res.json(filtered);
  } catch (err) {
    console.error("[MARKET][FAIL] /scrips:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/market/historical?exchange=NC&scripCode=XXXX&interval=daily
// Tries Sharekhan first. Falls back to the free Yahoo Finance source
// (see openDataSources.js) whenever Sharekhan doesn't come through —
// whether that's a hard failure (network error, or an auth_error, which
// Sharekhan sometimes returns as an HTTP 200 with an error body — see
// fetchHistoricalDirect() in sharekhanClient.js) or a "succeeded but
// genuinely no data for this scrip" response. The actual fetch+fallback
// logic lives in marketDataService.js (shared with the backtest engine,
// which needs the same thing per-scrip). The response's `source` field
// always says which one actually served it, and `sharekhanReason` is
// included whenever the fallback was used so that context isn't
// silently lost even when the fallback works.
router.get("/historical", async (req, res) => {
  const { exchange, scripCode, interval = "daily" } = req.query;
  console.log(`[MARKET] /historical exchange=${exchange} scripCode=${scripCode} interval=${interval}`);
  if (!exchange || !scripCode) {
    console.warn("[MARKET][FAIL] /historical missing exchange or scripCode");
    return res.status(400).json({ error: "exchange and scripCode query params are required." });
  }
  if (!VALID_HISTORICAL_INTERVALS.includes(interval)) {
    console.warn(`[MARKET][FAIL] /historical invalid interval="${interval}"`);
    return res.status(400).json({
      error: `interval must be one of: ${VALID_HISTORICAL_INTERVALS.join(", ")}`,
    });
  }
  try {
    const { source, sharekhanReason, candles, raw, note } = await getHistoricalWithFallback(
      exchange,
      scripCode,
      interval
    );
    console.log(`[MARKET][OK] /historical returning ${candles.length} candles from ${source}`);
    res.json({
      source,
      sharekhanReason,
      data: source === "sharekhan" ? { candles, raw } : { candles, note },
    });
  } catch (err) {
    console.error("[MARKET][FAIL] /historical:", err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
