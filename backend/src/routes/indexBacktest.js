// Separate route block from routes/backtest.js on purpose: NIFTY and
// BANKNIFTY aren't Sharekhan scrip-master entries (no exchange/scripCode
// pair to look up), always come from Yahoo's index tickers directly (see
// getIndexHistoricalData in openDataSources.js), and — since this is now
// an F&O (futures) backtest, not a spot-index one — need lot-based
// position sizing (lot size x number of lots) rather than the stock
// routes' capital/price share count. Mixing these into the stock
// backtest route would mean branching on instrument type everywhere; a
// dedicated route keeps both simple.
//
// Scope note: this models FUTURES (linear payoff — P&L moves 1:1 with
// the index, just like the underlying), not OPTIONS. Options need a
// strike, a premium, and an options-pricing model (time decay, implied
// volatility) to backtest meaningfully, and reliable historical NSE
// options-chain data isn't available through this app's free data
// sources (Yahoo Finance doesn't carry NSE option chains) — modeling
// that with made-up premiums would produce numbers that look precise
// but aren't trustworthy. Futures backtesting on the same EMA-crossover
// strategy is the honest version of this that the current data actually
// supports.

import { Router } from "express";
import { getIndexHistoricalData, INDEX_YAHOO_SYMBOLS, INDEX_LOT_SIZES } from "../openDataSources.js";
import { runBacktest, AVAILABLE_STRATEGIES } from "../backtest/engine.js";
import { SCALPING_DEFAULTS } from "../backtest/strategies/emaCrossoverScalping.js";
import { VALID_HISTORICAL_INTERVALS } from "../sharekhanClient.js";

const router = Router();

const AVAILABLE_INDICES = Object.keys(INDEX_YAHOO_SYMBOLS);
const DEFAULT_MARGIN_PERCENT = 12; // rough index-futures SPAN+exposure ballpark — see FIELD_INFO.marginPercent below for the caveat

// Plain-language description of every field this route's request body
// takes, returned by GET /defaults so the frontend can render real
// help text instead of a second, possibly-drifting copy of it, and so
// anyone hitting the API directly has a definition to hand.
const FIELD_INFO = {
  indices: "Which index/indices to backtest: NIFTY, BANKNIFTY, or both. Each is fetched and position-sized independently, then combined into one shared-capital run.",
  interval: "Candle size to backtest on. Shorter intervals (1minute/3minute) suit scalping but Yahoo only keeps 1-minute history for 7 days — 3minute or 5minute give a longer usable history.",
  strategy: "Which strategy module to run. Currently ema-crossover-scalping is the only one built for this scalping-style index block (opening-range-breakout, the stock strategy, is one-trade-per-day and not intended for indices here).",
  "strategyOptions.fastPeriod": "Fast EMA length (in candles). Crossing above/below the slow EMA is the entry signal. Shorter = more, quicker signals; longer = fewer, slower ones.",
  "strategyOptions.slowPeriod": "Slow EMA length (in candles). Must be longer than fastPeriod for crossovers to mean anything.",
  "strategyOptions.stopLossPoints": "Stop-loss distance in index POINTS (not rupees, not %) from entry price. E.g. 15 on Nifty means a 15-point adverse move exits the trade.",
  "strategyOptions.targetPoints": "Target distance in index points from entry. targetPoints / stopLossPoints is your risk:reward — e.g. 30/15 = 1:2.",
  "strategyOptions.allowShort": "Whether a downward crossover can open a SHORT position (profits when the index falls). Futures allow this natively, unlike cash-equity delivery.",
  "strategyOptions.maxTradesPerDay": "Caps how many trades one index can take in a single session — protects against runaway trade counts in a choppy, whipsaw-prone day.",
  numberOfLots: "How many lots to trade per entry, per index. Actual quantity per trade = numberOfLots x that index's lot size (see lotSizes below) — e.g. numberOfLots=2 on NIFTY (lot size 65) trades 130 units per entry.",
  lotSizes: `Units per F&O lot for each index. NSE revises these periodically (current defaults: NIFTY ${INDEX_LOT_SIZES.NIFTY}, BANKNIFTY ${INDEX_LOT_SIZES.BANKNIFTY}, as of the January 2026 revision) — override this field if that's gone stale by the time you're reading this; check the NSE website or your broker's contract specifications for the current value.`,
  maxConcurrentPositions: "Hard cap on how many positions (across all selected indices combined) can be open at the same time — this is what makes 'multiple trades at a time' a real, enforced limit rather than unlimited.",
  capital: "Your account's total capital, in rupees. Used only to report a return-on-capital percentage and to sanity-check estimated margin against it — it does NOT constrain position sizing here (numberOfLots does that directly), unlike the stock backtest where capital directly limits share quantity.",
  marginPercent: `Approximate SPAN + exposure margin as a percentage of notional position value (quantity x price) — a rough planning figure, NOT a real broker margin calculation (actual margin varies by volatility, broker, and day). Default ${DEFAULT_MARGIN_PERCENT}% is a rough index-futures ballpark; check your broker's margin calculator before trading with real money. Used to estimate approxMarginRequired in the result and flag if it would exceed your stated capital.`,
};

// GET /api/index-backtest/defaults — no auth needed, static config.
router.get("/defaults", (req, res) => {
  res.json({
    indices: AVAILABLE_INDICES,
    lotSizes: INDEX_LOT_SIZES,
    strategies: AVAILABLE_STRATEGIES,
    strategyDefaults: { "ema-crossover-scalping": SCALPING_DEFAULTS },
    intervals: VALID_HISTORICAL_INTERVALS,
    defaultMarginPercent: DEFAULT_MARGIN_PERCENT,
    // Yahoo's 1-minute candles only go back 7 days (see INTERVAL_MAP in
    // openDataSources.js) — worth surfacing so the frontend can hint at
    // it rather than the user discovering it from an empty result.
    recommendedInterval: "3minute",
    fieldInfo: FIELD_INFO,
  });
});

// POST /api/index-backtest/run
// Body: {
//   indices: ["NIFTY", "BANKNIFTY"],
//   interval: "3minute",
//   strategy: "ema-crossover-scalping",
//   strategyOptions: { stopLossPoints, targetPoints, allowShort, fastPeriod, slowPeriod, maxTradesPerDay },
//   numberOfLots: 1,
//   lotSizes: { NIFTY: 65, BANKNIFTY: 30 },   // optional override of INDEX_LOT_SIZES
//   maxConcurrentPositions: 2,
//   capital: 100000,
//   marginPercent: 12                          // optional; omit to skip the margin estimate
// }
// See FIELD_INFO above (and GET /defaults) for what each field means.
//
// No login required — same reasoning as /api/backtest/run: the
// underlying fetch is Yahoo-only for indices anyway, so there's no
// Sharekhan session to depend on in the first place.
router.post("/run", async (req, res) => {
  const {
    indices,
    interval = "3minute",
    strategy = "ema-crossover-scalping",
    strategyOptions = {},
    numberOfLots,
    lotSizes = {},
    maxConcurrentPositions,
    capital = 100000,
    marginPercent = DEFAULT_MARGIN_PERCENT,
  } = req.body || {};

  console.log(
    `[INDEXBACKTEST] /run indices=${JSON.stringify(indices)} interval=${interval} strategy=${strategy} ` +
      `numberOfLots=${numberOfLots} maxConcurrentPositions=${maxConcurrentPositions}`
  );

  if (!Array.isArray(indices) || indices.length === 0) {
    return res.status(400).json({ error: `indices must be a non-empty array from: ${AVAILABLE_INDICES.join(", ")}` });
  }
  const normalizedIndices = indices.map((i) => String(i).toUpperCase());
  const unknown = normalizedIndices.filter((i) => !AVAILABLE_INDICES.includes(i));
  if (unknown.length) {
    return res.status(400).json({ error: `Unknown index/indices: ${unknown.join(", ")}. Available: ${AVAILABLE_INDICES.join(", ")}` });
  }
  if (!VALID_HISTORICAL_INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of: ${VALID_HISTORICAL_INTERVALS.join(", ")}` });
  }
  if (!AVAILABLE_STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: `strategy must be one of: ${AVAILABLE_STRATEGIES.join(", ")}` });
  }
  if (!Number.isInteger(numberOfLots) || numberOfLots <= 0) {
    return res.status(400).json({ error: "numberOfLots must be a positive integer — see fieldInfo.numberOfLots from GET /defaults." });
  }
  if (!Number.isInteger(maxConcurrentPositions) || maxConcurrentPositions <= 0) {
    return res.status(400).json({ error: "maxConcurrentPositions must be a positive integer." });
  }

  // quantity per trade differs per index (NIFTY and BANKNIFTY don't
  // share a lot size), so this is a map, not one number — see the
  // per-scripCode lookup in capitalTracker.js's createFixedQuantityTracker.
  const effectiveLotSizes = { ...INDEX_LOT_SIZES, ...lotSizes };
  const quantityByIndex = {};
  for (const indexName of normalizedIndices) {
    quantityByIndex[indexName] = effectiveLotSizes[indexName] * numberOfLots;
  }

  const series = [];
  const fetchErrors = [];
  for (const indexName of normalizedIndices) {
    try {
      const { candles } = await getIndexHistoricalData(indexName, interval);
      console.log(`[INDEXBACKTEST] fetched ${candles.length} candles for ${indexName}`);
      series.push({ exchange: "INDEX-FUT", scripCode: indexName, tradingSymbol: indexName, candles, source: "yahoo-finance" });
    } catch (err) {
      console.error(`[INDEXBACKTEST][FAIL] fetching ${indexName}:`, err.message);
      fetchErrors.push({ index: indexName, error: err.message });
    }
  }

  if (!series.length) {
    return res.status(502).json({ error: "Couldn't fetch candles for any requested index.", fetchErrors });
  }

  try {
    const result = runBacktest(series, {
      strategy,
      strategyOptions,
      positionSizing: {
        mode: "fixedQuantity",
        quantityPerTrade: quantityByIndex,
        maxConcurrentPositions,
        capital,
        marginPercent,
      },
    });
    console.log(
      `[INDEXBACKTEST][OK] /run — ${result.summary.totalTrades} trades, ` +
        `${result.summary.skippedTrades} skipped, P&L ${result.summary.totalPnl}, ` +
        `marginExceedsCapital=${result.summary.marginExceedsCapital}`
    );
    res.json({ ...result, fetchErrors, lotSizesUsed: effectiveLotSizes, quantityByIndex });
  } catch (err) {
    console.error("[INDEXBACKTEST][FAIL] /run engine:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
