// Connects a strategy's signal generation to an order INTENT — but only
// ever a PAPER one (see orderDispatcher.js's header comment for why
// that's a hard guarantee, not a togglable setting). This route answers
// "did my strategy just fire, and what would it have ordered" without
// any path to a real order going out.
//
// This is a request-driven check, not a background scheduler — call
// POST /check periodically (the dashboard's "Check now" button, or an
// optional auto-poll toggle) rather than expecting this server to poll
// on its own via a cron/interval. A real always-on paper/live trading
// setup would want a proper scheduler or websocket feed instead; this
// is the honest, simple version that fits a dev server you run
// yourself while watching it.

import { Router } from "express";
import { getHistoricalWithFallback } from "../marketDataService.js";
import { getIndexHistoricalData, INDEX_YAHOO_SYMBOLS } from "../openDataSources.js";
import { resolveTradingSymbol, VALID_HISTORICAL_INTERVALS } from "../sharekhanClient.js";
import { AVAILABLE_STRATEGIES } from "../backtest/engine.js";
import * as openingRangeBreakout from "../backtest/strategies/openingRangeBreakout.js";
import * as emaCrossoverScalping from "../backtest/strategies/emaCrossoverScalping.js";
import { dispatchPaperOrder, getPaperTradeLog, clearPaperTradeLog } from "../liveSignal/orderDispatcher.js";

const router = Router();

const STRATEGY_MODULES = {
  "opening-range-breakout": openingRangeBreakout,
  "ema-crossover-scalping": emaCrossoverScalping,
};

const AVAILABLE_INDICES = Object.keys(INDEX_YAHOO_SYMBOLS);

// Remembers the last signal entryTime dispatched per (exchange,
// scripCode, strategy), so calling /check again before the next candle
// closes doesn't log the same paper order twice. In-memory only — see
// orderDispatcher.js's note on why that's fine for this feature's scope.
const lastDispatchedEntryTime = new Map();
function dedupeKey(exchange, scripCode, strategy) {
  return `${exchange}:${scripCode}:${strategy}`;
}

router.get("/paper-trades", (req, res) => {
  res.json(getPaperTradeLog());
});

router.delete("/paper-trades", (req, res) => {
  clearPaperTradeLog();
  lastDispatchedEntryTime.clear();
  console.log("[LIVESIGNAL] paper trade log cleared");
  res.json({ cleared: true });
});

// POST /api/live-signal/check
// Body: {
//   instrumentType: "stock" | "index",
//   exchange: "NC",       // required for instrumentType "stock"
//   scripCode: "2885",    // stock: Sharekhan's numeric code. index: "NIFTY" or "BANKNIFTY"
//   interval: "5minute",
//   strategy: "opening-range-breakout" | "ema-crossover-scalping",
//   strategyOptions: {},
//   quantity: 1            // size for the paper order if a fresh signal fires — resolved by the caller, not this route
// }
//
// No login required — same reasoning as the backtest routes: the
// underlying fetch already falls back to Yahoo Finance automatically.
router.post("/check", async (req, res) => {
  const {
    instrumentType = "stock",
    exchange = "NC",
    scripCode,
    interval = "5minute",
    strategy = "opening-range-breakout",
    strategyOptions = {},
    quantity,
  } = req.body || {};

  console.log(`[LIVESIGNAL] /check instrumentType=${instrumentType} exchange=${exchange} scripCode=${scripCode} strategy=${strategy}`);

  if (!scripCode) {
    return res.status(400).json({ error: "scripCode is required (Sharekhan code for stocks, or NIFTY/BANKNIFTY for indices)." });
  }
  if (!VALID_HISTORICAL_INTERVALS.includes(interval)) {
    return res.status(400).json({ error: `interval must be one of: ${VALID_HISTORICAL_INTERVALS.join(", ")}` });
  }
  if (!AVAILABLE_STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: `strategy must be one of: ${AVAILABLE_STRATEGIES.join(", ")}` });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "quantity must be a positive number — this route doesn't derive it for you (see the backtest routes' position sizing for that math if you want to reuse it)." });
  }
  if (instrumentType === "index" && !AVAILABLE_INDICES.includes(String(scripCode).toUpperCase())) {
    return res.status(400).json({ error: `For instrumentType "index", scripCode must be one of: ${AVAILABLE_INDICES.join(", ")}` });
  }

  let candles;
  let tradingSymbol;
  try {
    if (instrumentType === "index") {
      const result = await getIndexHistoricalData(scripCode, interval);
      candles = result.candles;
      tradingSymbol = String(scripCode).toUpperCase();
    } else {
      const result = await getHistoricalWithFallback(exchange, scripCode, interval);
      candles = result.candles;
      tradingSymbol = (await resolveTradingSymbol(exchange, scripCode)) || scripCode;
    }
  } catch (err) {
    console.error("[LIVESIGNAL][FAIL] fetching candles:", err.message);
    return res.status(502).json({ error: err.message });
  }

  if (!candles.length) {
    return res.json({ fetchedCandles: 0, latestCandleTime: null, allTodaysSignals: [], freshSignal: null, dispatched: null, duplicate: false });
  }

  const strategyModule = STRATEGY_MODULES[strategy];
  let allSignals;
  try {
    allSignals = strategyModule.generateTrades(candles, strategyOptions);
  } catch (err) {
    console.error("[LIVESIGNAL][FAIL] strategy error:", err.message);
    return res.status(500).json({ error: `Strategy failed: ${err.message}` });
  }

  const latestCandle = candles[candles.length - 1];
  const latestCandleTime = new Date(latestCandle.date).toISOString();

  // "Fresh" = entered on the most recent candle we have — anything
  // earlier already had its chance to fire on a previous /check call.
  const freshSignal = allSignals.find((s) => new Date(s.entryTime).toISOString() === latestCandleTime) || null;

  let dispatched = null;
  let duplicate = false;
  if (freshSignal) {
    const key = dedupeKey(exchange, scripCode, strategy);
    if (lastDispatchedEntryTime.get(key) === latestCandleTime) {
      duplicate = true;
      console.log(`[LIVESIGNAL] /check — fresh signal for ${key} already dispatched, skipping duplicate`);
    } else {
      const signalWithContext = { ...freshSignal, exchange: instrumentType === "index" ? "INDEX-FUT" : exchange, scripCode: String(scripCode).toUpperCase() };
      dispatched = dispatchPaperOrder(signalWithContext, quantity, { tradingSymbol });
      lastDispatchedEntryTime.set(key, latestCandleTime);
    }
  }

  console.log(
    `[LIVESIGNAL][OK] /check — ${allSignals.length} signal(s) today, fresh=${!!freshSignal}, dispatched=${!!dispatched}, duplicate=${duplicate}`
  );
  res.json({
    fetchedCandles: candles.length,
    latestCandleTime,
    allTodaysSignals: allSignals,
    freshSignal,
    dispatched,
    duplicate,
  });
});

export default router;
