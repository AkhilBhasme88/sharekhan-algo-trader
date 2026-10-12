// Combines however many scrips are being backtested into one timeline
// and applies ONE shared capital pool across all of them — this is what
// makes "multiple trades at a time" a real constraint rather than each
// scrip pretending it has its own ₹1,00,000. A strategy module (see
// strategies/openingRangeBreakout.js) resolves each scrip's candles into
// complete, independent trade outcomes; this engine's only job is
// deciding which of those the account's capital can actually afford, in
// what quantity, and in what order.
//
// Simplification worth knowing: capital is freed and re-deployed based
// on each trade's entry/exit *times* processed in chronological order —
// this is accurate for "did this trade have room to open," but doesn't
// model second-order effects like slippage from many trades competing
// for the same capital at the exact same instant. Fine for a backtest,
// not a claim of exact simulation.

import { createCapitalTracker, createFixedQuantityTracker, DEFAULT_CAPITAL, DEFAULT_MAX_PER_TRADE } from "./capitalTracker.js";
import * as openingRangeBreakout from "./strategies/openingRangeBreakout.js";
import * as emaCrossoverScalping from "./strategies/emaCrossoverScalping.js";

const STRATEGIES = {
  "opening-range-breakout": openingRangeBreakout,
  "ema-crossover-scalping": emaCrossoverScalping,
};

export const AVAILABLE_STRATEGIES = Object.keys(STRATEGIES);

/**
 * scripSeries: [{ exchange, scripCode, tradingSymbol, candles, source, sharekhanReason }]
 *   — candles already fetched (e.g. via marketDataService.getHistoricalWithFallback)
 * options: { strategy, strategyOptions, capital, maxPerTrade, positionSizing }
 *   positionSizing (optional) switches to fixed-quantity mode:
 *     { mode: "fixedQuantity", quantityPerTrade, maxConcurrentPositions, capital, marginPercent }
 *     quantityPerTrade is either one number (same for every scrip) or a
 *     map { scripCode: quantity } — needed for F&O, since NIFTY and
 *     BANKNIFTY have different lot sizes (see capitalTracker.js). Without
 *     positionSizing, falls back to stock/capital mode: whole units
 *     affordable within maxPerTrade/capital at the entry price, same as
 *     a real cash purchase. `marginPercent`, if given, adds an
 *     approximate margin-required estimate to the summary (see below).
 */
export function runBacktest(scripSeries, options = {}) {
  const {
    capital = DEFAULT_CAPITAL,
    maxPerTrade = DEFAULT_MAX_PER_TRADE,
    strategy = "opening-range-breakout",
    strategyOptions = {},
    positionSizing,
  } = options;

  const strategyModule = STRATEGIES[strategy];
  if (!strategyModule) {
    throw new Error(`Unknown strategy "${strategy}". Available: ${AVAILABLE_STRATEGIES.join(", ")}`);
  }

  // Step 1: resolve every scrip's candles into complete trade outcomes,
  // independent of capital (see strategy module's own comment on this).
  const allSignals = [];
  for (const scrip of scripSeries) {
    let trades = [];
    try {
      trades = strategyModule.generateTrades(scrip.candles, strategyOptions);
    } catch (err) {
      console.error(`[BACKTEST] strategy failed for ${scrip.exchange}/${scrip.scripCode}:`, err.message);
      continue;
    }
    for (const trade of trades) {
      allSignals.push({ ...trade, exchange: scrip.exchange, scripCode: scrip.scripCode, tradingSymbol: scrip.tradingSymbol, dataSource: scrip.source });
    }
  }
  allSignals.sort((a, b) => new Date(a.entryTime) - new Date(b.entryTime));

  // Step 2: greedily allocate shared capital/position-slots across
  // signals in chronological order, freeing capacity from positions
  // that have already exited by the time a later signal wants to enter.
  const reportingCapital = positionSizing?.capital ?? capital;
  const tracker =
    positionSizing?.mode === "fixedQuantity"
      ? createFixedQuantityTracker(positionSizing.quantityPerTrade, positionSizing.maxConcurrentPositions)
      : createCapitalTracker(capital, maxPerTrade);
  const openPositions = []; // { exitTime, amount }
  const executedTrades = [];
  const skippedTrades = [];

  for (const signal of allSignals) {
    const entryTimeMs = new Date(signal.entryTime).getTime();
    for (let i = openPositions.length - 1; i >= 0; i--) {
      if (new Date(openPositions[i].exitTime).getTime() <= entryTimeMs) {
        tracker.closePosition(openPositions[i].amount);
        openPositions.splice(i, 1);
      }
    }

    const quantity = tracker.sizePosition(signal.entryPrice, signal.scripCode);
    if (quantity <= 0) {
      const reason =
        positionSizing?.mode === "fixedQuantity"
          ? `All ${positionSizing.maxConcurrentPositions} concurrent position slot(s) were already in use at signal time.`
          : "No capital available at signal time (all of it was deployed in other open positions).";
      skippedTrades.push({ ...signal, reason });
      continue;
    }

    const amountDeployed = quantity * signal.entryPrice;
    tracker.openPosition(amountDeployed);
    openPositions.push({ exitTime: signal.exitTime, amount: amountDeployed });

    const pnl = signal.pnlPerShare * quantity;
    executedTrades.push({ ...signal, quantity, amountDeployed, pnl });
  }

  const totalPnl = executedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = executedTrades.filter((t) => t.pnl > 0).length;
  const losses = executedTrades.filter((t) => t.pnl <= 0).length;
  const peakNotionalOrCapital = +tracker.peakDeployed().toFixed(2);

  const summary = {
    capital: reportingCapital,
    maxPerTrade: positionSizing?.mode === "fixedQuantity" ? undefined : maxPerTrade,
    quantityPerTrade: positionSizing?.mode === "fixedQuantity" ? positionSizing.quantityPerTrade : undefined,
    theoreticalMaxConcurrentPositions: tracker.maxConcurrentPositions(), // for capital mode: capital/maxPerTrade, evenly sized; for fixed-quantity mode: the configured cap directly — actual concurrency varies with real trade sizes/timing either way
    // Capital mode: this is real cash spent on shares, so
    // "peakCapitalDeployed" is accurate. Fixed-quantity (F&O) mode:
    // this is the position's NOTIONAL value (quantity x price) — real
    // futures trading only ties up margin, a fraction of notional. If
    // marginPercent was supplied, this also estimates that margin figure
    // (peakNotionalExposure x marginPercent / 100) and flags whether it
    // would exceed the stated capital — an approximation for sanity-
    // checking capital adequacy, not a real broker margin calculation
    // (actual SPAN + exposure margin varies by volatility, broker, and
    // day — check your broker's margin calculator before real trading).
    ...(positionSizing?.mode === "fixedQuantity"
      ? {
          peakNotionalExposure: peakNotionalOrCapital,
          notionalExposureNote:
            "This is notional value (quantity x price), not capital or margin actually required — real F&O trading only ties up a fraction of this as margin.",
          ...(positionSizing.marginPercent
            ? (() => {
                const approxMarginRequired = +((peakNotionalOrCapital * positionSizing.marginPercent) / 100).toFixed(2);
                return {
                  approxMarginRequired,
                  marginPercent: positionSizing.marginPercent,
                  marginExceedsCapital: reportingCapital ? approxMarginRequired > reportingCapital : null,
                };
              })()
            : {}),
        }
      : { peakCapitalDeployed: peakNotionalOrCapital }),
    totalTrades: executedTrades.length,
    skippedTrades: skippedTrades.length,
    wins,
    losses,
    winRate: executedTrades.length ? +((wins / executedTrades.length) * 100).toFixed(1) : 0,
    totalPnl: +totalPnl.toFixed(2),
    returnOnCapitalPct: reportingCapital ? +((totalPnl / reportingCapital) * 100).toFixed(2) : null,
  };

  return { trades: executedTrades, skippedTrades, summary };
}
