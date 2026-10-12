// EMA crossover scalping — a standard, simple scalping approach: a fast
// EMA crossing above/below a slower EMA is the entry signal, with a
// fixed-point stop and target (points, not a percentage or a range
// width — appropriate for index values like Nifty/BankNifty where a
// "range width" style measure is less standard than a fixed point
// stop). Unlike openingRangeBreakout.js's one-trade-per-day rule,
// scalping is deliberately about taking several small, quick
// opportunities through the session — capped by maxTradesPerDay so a
// choppy, whipsaw session doesn't generate runaway trade counts.
//
// Same contract as every other strategy module: generateTrades(candles,
// options) -> [trade], each trade a COMPLETE resolved outcome
// independent of capital — see openingRangeBreakout.js's header comment
// for why that split exists.

import { groupCandlesByISTDay } from "../sessions.js";

export const SCALPING_DEFAULTS = {
  session: { start: "09:15", end: "15:15" }, // wide by default — narrow this via strategyOptions for a specific scalping window
  fastPeriod: 5,
  slowPeriod: 20,
  stopLossPoints: 15,
  targetPoints: 30, // 1:2 by default — pass a different value for another R:R
  allowShort: true,
  maxTradesPerDay: 5,
};

function computeEMA(values, period) {
  const k = 2 / (period + 1);
  const ema = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null || values[i] === undefined) {
      ema[i] = prev;
      continue;
    }
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
    ema[i] = prev;
  }
  return ema;
}

function finalizeTrade(day, position, exitTime, exitPrice, exitReason) {
  const pnlPerShare = position.side === "LONG" ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
  return {
    day,
    side: position.side,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    exitTime,
    exitPrice,
    exitReason,
    pnlPerShare,
  };
}

export function generateTrades(candles, options = {}) {
  const { session, fastPeriod, slowPeriod, stopLossPoints, targetPoints, allowShort, maxTradesPerDay } = {
    ...SCALPING_DEFAULTS,
    ...options,
  };
  const byDay = groupCandlesByISTDay(candles, session);
  const trades = [];

  for (const [day, dayCandles] of byDay) {
    if (dayCandles.length < slowPeriod + 1) continue; // not enough candles for the slow EMA to mean anything yet
    const closes = dayCandles.map((c) => c.close);
    const fastEMA = computeEMA(closes, fastPeriod);
    const slowEMA = computeEMA(closes, slowPeriod);

    let position = null;
    let tradesToday = 0;

    for (let i = 1; i < dayCandles.length; i++) {
      const candle = dayCandles[i];
      if (fastEMA[i] === null || slowEMA[i] === null || fastEMA[i - 1] === null || slowEMA[i - 1] === null) continue;
      if (candle.high === null || candle.low === null) continue; // can't evaluate SL/target without them

      const crossedUp = fastEMA[i - 1] <= slowEMA[i - 1] && fastEMA[i] > slowEMA[i];
      const crossedDown = fastEMA[i - 1] >= slowEMA[i - 1] && fastEMA[i] < slowEMA[i];

      if (position) {
        const hitStop = position.side === "LONG" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
        const hitTarget = position.side === "LONG" ? candle.high >= position.target : candle.low <= position.target;
        const oppositeSignal = (position.side === "LONG" && crossedDown) || (position.side === "SHORT" && crossedUp);
        if (hitStop || hitTarget || oppositeSignal) {
          // Worse-case assumption if a wide candle could have hit both
          // stop and target: assume stop-loss first, same convention as
          // openingRangeBreakout.js.
          const exitReason = hitStop ? "stop-loss" : hitTarget ? "target" : "opposite-crossover";
          const exitPrice = hitStop ? position.stopLoss : hitTarget ? position.target : candle.close;
          trades.push(finalizeTrade(day, position, candle.date, exitPrice, exitReason));
          position = null;
          tradesToday += 1;
        }
        continue; // one decision per candle — don't also evaluate a fresh entry on the exit candle
      }

      if (tradesToday >= maxTradesPerDay) continue;

      if (crossedUp) {
        position = {
          side: "LONG",
          entryTime: candle.date,
          entryPrice: candle.close,
          stopLoss: candle.close - stopLossPoints,
          target: candle.close + targetPoints,
        };
      } else if (allowShort && crossedDown) {
        position = {
          side: "SHORT",
          entryTime: candle.date,
          entryPrice: candle.close,
          stopLoss: candle.close + stopLossPoints,
          target: candle.close - targetPoints,
        };
      }
    }

    if (position) {
      // Session ended with the position still open — force a square-off
      // at the last available close (intraday, no overnight carry).
      const lastCandle = dayCandles[dayCandles.length - 1];
      trades.push(finalizeTrade(day, position, lastCandle.date, lastCandle.close, "session-end-squareoff"));
    }
  }

  return trades;
}
