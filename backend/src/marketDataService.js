// Shared by routes/market.js and backtest/engine.js — pulls historical
// candles for one scrip via Sharekhan, automatically falling back to
// Yahoo Finance on any failure (see the README's "When Sharekhan
// doesn't come through" section for why), and normalizes the result to
// a plain array of { date, open, high, low, close, volume } candles
// regardless of which source answered. Extracted out of routes/market.js
// so the backtest engine (which needs this per-scrip, potentially for
// several scrips in one run) doesn't duplicate the fallback logic.

import { getHistoricalData, resolveTradingSymbol, isEmptyHistoricalResponse } from "./sharekhanClient.js";
import { getYahooHistoricalData } from "./openDataSources.js";

// Sharekhan's raw historical payload shape has never been seen
// successfully (every live call so far has come back empty or an
// auth_error — see README) so this is a best-effort, pattern-based
// normalizer rather than a confirmed mapping: it looks for common
// date/OHLCV key spellings rather than assuming exact names, the same
// defensive approach used elsewhere in this codebase (scrip master
// columns, SDK method names). Rows that don't have a recognizable
// close price are dropped rather than included as broken candles.
const DATE_KEY_CANDIDATES = ["date", "Date", "timestamp", "Timestamp", "time", "Time"];
const FIELD_KEY_CANDIDATES = {
  open: ["open", "Open", "o", "O"],
  high: ["high", "High", "h", "H"],
  low: ["low", "Low", "l", "L"],
  close: ["close", "Close", "c", "C", "ltp", "LTP"],
  volume: ["volume", "Volume", "v", "V", "vol", "Vol"],
};

function pick(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
}

function normalizeSharekhanCandles(raw) {
  let rows = raw;
  if (!Array.isArray(rows)) {
    if (Array.isArray(raw?.data)) rows = raw.data;
    else if (Array.isArray(raw?.candles)) rows = raw.candles;
    else if (Array.isArray(raw?.history)) rows = raw.history;
    else return [];
  }
  return rows
    .map((row) => {
      if (Array.isArray(row)) {
        // Some broker APIs return candles as bare [date, o, h, l, c, v]
        // arrays rather than objects — handle that shape too.
        const [date, open, high, low, close, volume] = row;
        return { date, open, high, low, close, volume };
      }
      if (!row || typeof row !== "object") return null;
      const close = pick(row, FIELD_KEY_CANDIDATES.close);
      if (close === null) return null;
      return {
        date: pick(row, DATE_KEY_CANDIDATES),
        open: pick(row, FIELD_KEY_CANDIDATES.open),
        high: pick(row, FIELD_KEY_CANDIDATES.high),
        low: pick(row, FIELD_KEY_CANDIDATES.low),
        close,
        volume: pick(row, FIELD_KEY_CANDIDATES.volume),
      };
    })
    .filter(Boolean);
}

/**
 * Returns { source, sharekhanReason, candles } for one scrip — always
 * a plain candle array regardless of which source answered, so callers
 * (the /market/historical route, the backtest engine) don't need to
 * know or care which one it was. `sharekhanReason` is set (and
 * `source` is "yahoo-finance") whenever Sharekhan itself didn't
 * provide the data, mirroring the same fallback behavior documented in
 * the README.
 */
export async function getHistoricalWithFallback(exchange, scripCode, interval) {
  let sharekhanReason = null;
  try {
    const sharekhanData = await getHistoricalData(exchange, scripCode, interval);
    if (!isEmptyHistoricalResponse(sharekhanData)) {
      const candles = normalizeSharekhanCandles(sharekhanData);
      if (candles.length) {
        return { source: "sharekhan", sharekhanReason: null, candles, raw: sharekhanData };
      }
      sharekhanReason = `Sharekhan returned data but no rows normalized to recognizable candles for ${exchange}/${scripCode}/${interval}.`;
    } else {
      sharekhanReason = `Sharekhan reported no data for ${exchange}/${scripCode}/${interval}.`;
    }
    console.warn(`[MARKETDATA] getHistoricalWithFallback — ${sharekhanReason} Trying Yahoo Finance.`);
  } catch (err) {
    sharekhanReason = `Sharekhan request failed: ${err.message}`;
    console.warn(`[MARKETDATA] getHistoricalWithFallback — ${sharekhanReason} Trying Yahoo Finance.`);
  }

  const tradingSymbol = await resolveTradingSymbol(exchange, scripCode);
  if (!tradingSymbol) {
    throw new Error(
      `${sharekhanReason} Its trading symbol also couldn't be resolved from the scrip master to try ` +
        "the Yahoo Finance fallback."
    );
  }
  const fallback = await getYahooHistoricalData(tradingSymbol, interval, exchange);
  return { source: fallback.source, sharekhanReason, candles: fallback.candles, note: fallback.note };
}
