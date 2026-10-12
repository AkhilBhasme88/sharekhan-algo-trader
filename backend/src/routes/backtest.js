import { Router } from "express";
import { getHistoricalWithFallback } from "../marketDataService.js";
import { resolveTradingSymbol, VALID_HISTORICAL_INTERVALS } from "../sharekhanClient.js";
import { runBacktest, AVAILABLE_STRATEGIES } from "../backtest/engine.js";
import { DEFAULT_CAPITAL, DEFAULT_MAX_PER_TRADE } from "../backtest/capitalTracker.js";
import { ORB_DEFAULTS } from "../backtest/strategies/openingRangeBreakout.js";

const router = Router();

// GET /api/backtest/defaults — no auth needed, static config. Lets the
// frontend build its form from the same defaults the engine actually
// uses, instead of a second hardcoded copy.
router.get("/defaults", (req, res) => {
  res.json({
    strategies: AVAILABLE_STRATEGIES,
    capital: DEFAULT_CAPITAL,
    maxPerTrade: DEFAULT_MAX_PER_TRADE,
    strategyDefaults: { "opening-range-breakout": ORB_DEFAULTS },
    intervals: VALID_HISTORICAL_INTERVALS,
  });
});

// POST /api/backtest/run
// Body: {
//   scrips: [{ exchange, scripCode }],   // required, 1+
//   interval: "5minute",                 // default; an intraday value makes sense for session-based strategies
//   capital: 100000,
//   maxPerTrade: 20000,
//   strategy: "opening-range-breakout",
//   strategyOptions: { session: { start: "09:15", end: "10:15" }, ... }
// }
//
// No login required here on purpose (unlike /market/historical) — the
// underlying fetch already falls back to Yahoo Finance automatically
// when Sharekhan doesn't come through, and a backtest is exactly the
// case where you want that to just work without needing a live
// Sharekhan session at all.
router.post("/run", async (req, res) => {
  const {
    scrips,
    interval = "5minute",
    capital = DEFAULT_CAPITAL,
    maxPerTrade = DEFAULT_MAX_PER_TRADE,
    strategy = "opening-range-breakout",
    strategyOptions = {},
  } = req.body || {};

  console.log(
    `[BACKTEST] /run scrips=${JSON.stringify(scrips)} interval=${interval} capital=${capital} ` +
      `maxPerTrade=${maxPerTrade} strategy=${strategy}`
  );

  if (!Array.isArray(scrips) || scrips.length === 0) {
    return res.status(400).json({ error: "scrips must be a non-empty array of { exchange, scripCode }." });
  }
  if (!VALID_HISTORICAL_INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of: ${VALID_HISTORICAL_INTERVALS.join(", ")}` });
  }
  if (!AVAILABLE_STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: `strategy must be one of: ${AVAILABLE_STRATEGIES.join(", ")}` });
  }
  if (capital <= 0 || maxPerTrade <= 0 || maxPerTrade > capital) {
    return res.status(400).json({ error: "capital and maxPerTrade must be positive, and maxPerTrade must not exceed capital." });
  }

  // Fetch each scrip's candles independently — one bad/empty scrip
  // shouldn't sink the whole backtest, so failures are collected and
  // reported per-scrip rather than aborting the request.
  const series = [];
  const fetchErrors = [];
  for (const { exchange, scripCode } of scrips) {
    try {
      const { source, sharekhanReason, candles } = await getHistoricalWithFallback(exchange, scripCode, interval);
      const tradingSymbol = (await resolveTradingSymbol(exchange, scripCode)) || `${exchange}:${scripCode}`;
      console.log(`[BACKTEST] fetched ${candles.length} candles for ${exchange}/${scripCode} from ${source}`);
      series.push({ exchange, scripCode, tradingSymbol, candles, source, sharekhanReason });
    } catch (err) {
      console.error(`[BACKTEST][FAIL] fetching ${exchange}/${scripCode}:`, err.message);
      fetchErrors.push({ exchange, scripCode, error: err.message });
    }
  }

  if (!series.length) {
    return res.status(502).json({ error: "Couldn't fetch candles for any requested scrip.", fetchErrors });
  }

  try {
    const result = runBacktest(series, { capital, maxPerTrade, strategy, strategyOptions });
    console.log(
      `[BACKTEST][OK] /run — ${result.summary.totalTrades} trades, ` +
        `${result.summary.skippedTrades} skipped, P&L ${result.summary.totalPnl}`
    );
    res.json({ ...result, fetchErrors, dataSources: series.map((s) => ({ scripCode: s.scripCode, source: s.source, sharekhanReason: s.sharekhanReason })) });
  } catch (err) {
    console.error("[BACKTEST][FAIL] /run engine:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
