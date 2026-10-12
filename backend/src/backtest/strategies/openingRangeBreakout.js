// Opening Range Breakout (ORB) — a standard, well-understood intraday
// strategy that fits the 9:15-10:15 window directly: the first N minutes
// set a high/low "range", and a close breaking outside it is the entry
// signal, with a stop on the opposite side of the range and a target as
// a multiple of the range's width. Chosen as the default/example
// strategy here since no specific entry/exit logic was given — swap in
// a different strategy by writing another module with the same
// `generateTrades(candles, options) -> [trade]` shape (see the README's
// "Where your strategy goes" section) and passing it to runBacktest()
// in engine.js instead.
//
// Each returned trade is a COMPLETE, resolved outcome (entry price/time,
// exit price/time/reason, P&L per share) — deliberately computed without
// any notion of available capital, since a scrip's own price path
// doesn't depend on what else the account is trading. The portfolio
// engine (engine.js) is what decides which of these resolved trades the
// account's capital can actually afford, and in what quantity.

import { groupCandlesByISTDay, addMinutesToHHMM } from "../sessions.js";

export const ORB_DEFAULTS = {
  session: { start: "09:15", end: "10:15" },
  openingRangeMinutes: 15, // range formed from 09:15-09:30 candles
  // Risk = stop distance = the opening range's width (stop sits on the
  // range's opposite side, so entry-to-stop is exactly one range width
  // — this is the NOMINAL risk, measured from the range boundary, not
  // necessarily from the realized entry price; see note below).
  // Reward = targetMultiple x that same width. targetMultiple=3 means
  // reward is 3x the risk, i.e. an R:R of 1:3 — a single winner covers
  // three losers of the same size, so this only needs a ~25% win rate
  // to break even, in exchange for missing the (frequent) moves that
  // would have hit the old 1:2 target but not this wider one.
  //
  // Note on realized vs nominal R:R: entries trigger on a CLOSE beyond
  // the range, which can land past the range edge rather than exactly
  // on it (breakout slippage) — so the true entry-to-stop distance is
  // often a bit more than one range width, making the realized R:R on
  // any given trade somewhat less than the nominal 1:3 (e.g. 1:2.1 if
  // the close that triggered entry was already 2 points past the
  // range's edge on a 5-point-wide range). This is standard for
  // breakout entries, not a bug — the target/stop levels themselves are
  // still exactly 1x/3x the range width from each other.
  targetMultiple: 3,
  allowShort: true, // intraday (MIS) product allows short-selling in cash equity
  oneTradePerDay: true, // classic ORB rule — don't re-enter after the day's trade is closed
};

function finalizeTrade({ day, position, exitTime, exitPrice, exitReason, rangeHigh, rangeLow }) {
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
    rangeHigh,
    rangeLow,
  };
}

/**
 * candles: plain OHLC array (see marketDataService.js's normalized shape)
 * for ONE scrip, any length/date range — internally grouped by IST
 * trading day, so a multi-day candle series produces one ORB setup per
 * day automatically.
 */
export function generateTrades(candles, options = {}) {
  const { session, openingRangeMinutes, targetMultiple, allowShort, oneTradePerDay } = { ...ORB_DEFAULTS, ...options };
  const rangeEnd = addMinutesToHHMM(session.start, openingRangeMinutes);
  const byDay = groupCandlesByISTDay(candles, session);
  const trades = [];

  for (const [day, dayCandles] of byDay) {
    const rangeCandles = dayCandles.filter((c) => c.hhmm >= session.start && c.hhmm < rangeEnd);
    const postRangeCandles = dayCandles.filter((c) => c.hhmm >= rangeEnd && c.hhmm <= session.end);
    if (!rangeCandles.length || !postRangeCandles.length) continue;

    const highs = rangeCandles.map((c) => c.high).filter((v) => v !== null && v !== undefined);
    const lows = rangeCandles.map((c) => c.low).filter((v) => v !== null && v !== undefined);
    if (!highs.length || !lows.length) continue; // candles without high/low can't form a range
    const rangeHigh = Math.max(...highs);
    const rangeLow = Math.min(...lows);
    const rangeWidth = rangeHigh - rangeLow;
    if (rangeWidth <= 0) continue;

    let position = null;
    for (const candle of postRangeCandles) {
      if (candle.high === null || candle.low === null) continue; // can't evaluate SL/target without them

      if (!position) {
        if (candle.close > rangeHigh) {
          position = { side: "LONG", entryTime: candle.date, entryPrice: candle.close, stopLoss: rangeLow, target: candle.close + targetMultiple * rangeWidth };
        } else if (allowShort && candle.close < rangeLow) {
          position = { side: "SHORT", entryTime: candle.date, entryPrice: candle.close, stopLoss: rangeHigh, target: candle.close - targetMultiple * rangeWidth };
        }
        continue; // don't evaluate an exit on the same candle that opened the position
      }

      const hitStop = position.side === "LONG" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss;
      const hitTarget = position.side === "LONG" ? candle.high >= position.target : candle.low <= position.target;
      if (hitStop || hitTarget) {
        // If a single candle's range could have hit both (a wide/gappy
        // candle), assume the worse outcome for the trade (stop-loss)
        // rather than assuming the best case.
        const exitReason = hitStop ? "stop-loss" : "target";
        const exitPrice = hitStop ? position.stopLoss : position.target;
        trades.push(finalizeTrade({ day, position, exitTime: candle.date, exitPrice, exitReason, rangeHigh, rangeLow }));
        position = null;
        if (oneTradePerDay) break; // classic ORB rule — don't chase a re-breakout the same session
      }
    }

    if (position) {
      // Session ended with the position still open — intraday trades
      // can't carry overnight, so force a square-off at the last
      // available close within the session.
      const lastCandle = postRangeCandles[postRangeCandles.length - 1];
      trades.push(
        finalizeTrade({
          day,
          position,
          exitTime: lastCandle.date,
          exitPrice: lastCandle.close,
          exitReason: "session-end-squareoff",
          rangeHigh,
          rangeLow,
        })
      );
    }
  }

  return trades;
}
