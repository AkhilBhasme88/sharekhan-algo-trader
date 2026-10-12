// Free/open fallback for OHLC history, used when Sharekhan's own
// historical endpoint comes back empty for a scrip (a real, observed
// case — see the "No Historic data available" note in the README).
//
// Two options exist for this and were weighed:
//   - NSE's own website (nseindia.com) publishes historical data and
//     daily bhavcopy files, but its API sits behind Akamai bot
//     protection that expects browser-like session cookies obtained by
//     first hitting the homepage — workable, but fragile and prone to
//     silently breaking when NSE tweaks that protection.
//   - Yahoo Finance's chart endpoint is unauthenticated, has no cookie
//     dance, and is what most open-source backtesting tooling already
//     relies on for Indian equities (symbol suffixed `.NS` for NSE,
//     `.BO` for BSE). Chosen here for reliability.
//
// This does NOT need a Sharekhan session at all — it's a plain public
// HTTPS call, independent of login state, api_key, or access-token.

import axios from "axios";

const YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

// Sharekhan's exchange codes -> Yahoo's ticker suffix. Extend this if
// you trade other exchanges (e.g. MCX commodities aren't on Yahoo at
// all under a simple suffix — those would need a different provider).
const EXCHANGE_TO_YAHOO_SUFFIX = {
  NC: ".NS", // NSE Cash
  NSE: ".NS",
  BC: ".BO", // BSE Cash
  BSE: ".BO",
};

// Sharekhan's interval vocabulary -> the closest Yahoo (interval, range)
// pair. Yahoo doesn't have quarterly/halfyearly/yearly buckets at all —
// those fall back to monthly candles, which is the closest honest
// approximation (not a resample), flagged in the returned `note` field
// rather than silently pretending it's the same thing. Yahoo also has no
// 10minute/90minute buckets — those fall back to the nearest one it does
// support (5minute/60 minutes -> 15min/60min respectively), also noted.
const INTERVAL_MAP = {
  daily: { interval: "1d", range: "5y" },
  weekly: { interval: "1wk", range: "10y" },
  monthly: { interval: "1mo", range: "max" },
  quarterly: { interval: "1mo", range: "max", note: "Yahoo has no quarterly bucket — returning monthly candles instead." },
  halfyearly: { interval: "1mo", range: "max", note: "Yahoo has no half-yearly bucket — returning monthly candles instead." },
  yearly: { interval: "1mo", range: "max", note: "Yahoo has no yearly bucket — returning monthly candles instead." },
  "1minute": { interval: "1m", range: "7d" }, // Yahoo only keeps 1m candles for the last 7 days
  "3minute": { interval: "2m", range: "60d", note: "Yahoo has no 3-minute bucket — returning 2-minute candles instead." },
  "5minute": { interval: "5m", range: "60d" },
  "10minute": { interval: "15m", range: "60d", note: "Yahoo has no 10-minute bucket — returning 15-minute candles instead." },
  "15minute": { interval: "15m", range: "60d" },
  "30minute": { interval: "30m", range: "60d" },
  "60minute": { interval: "60m", range: "2y" },
  "90minute": { interval: "60m", range: "2y", note: "Yahoo has no 90-minute bucket — returning 60-minute candles instead." },
};

export function buildYahooSymbol(exchange, tradingSymbol) {
  const suffix = EXCHANGE_TO_YAHOO_SUFFIX[String(exchange).toUpperCase()] || ".NS";
  return `${tradingSymbol}${suffix}`;
}

// NIFTY/BANKNIFTY aren't Sharekhan scrip-master entries at all — they're
// indices, not directly tradable instruments (real exposure is via
// futures/options on them, each with their own scripCode and, crucially,
// a fixed lot size that changes periodically by SEBI/exchange circular).
// Rather than guess a scripCode or a lot size that could go stale, this
// pulls the index's own spot value straight from Yahoo's well-known
// index tickers — see resolveIndexYahooSymbol()'s caller in
// marketDataService.js for how the backtest engine handles position
// sizing differently for these (fixed quantity/lots, not a
// capital/price share count, since a single "share" of Nifty at ~24,000
// would exceed most per-trade caps entirely).
export const INDEX_YAHOO_SYMBOLS = {
  NIFTY: "^NSEI",
  BANKNIFTY: "^NSEBANK",
};

// Current NIFTY/BANKNIFTY futures lot sizes, confirmed via multiple
// current sources as of the January 2026 NSE revision (effective for
// weekly contracts from 6 Jan 2026, monthly from the Jan 2026 expiry):
// NIFTY = 65, BANKNIFTY = 30 (down from 75/35 previously — NSE
// periodically rebaselines index lot sizes to keep contract notional
// value within a SEBI-mandated band as index levels move). THESE WILL
// CHANGE AGAIN — NSE has revised both roughly twice a year historically.
// Treat this as a starting default, not a fact to trust indefinitely:
// verify the current value on the NSE website or your broker's contract
// specifications before relying on it for anything beyond a backtest,
// and override it via the `lotSizes` field in a
// POST /api/index-backtest/run request if it's gone stale.
export const INDEX_LOT_SIZES = {
  NIFTY: 65,
  BANKNIFTY: 30,
};

/**
 * tradingSymbolOrYahooSymbol: either a bare NSE/BSE trading symbol
 * (e.g. "RELIANCE") plus `exchange` to pick the right suffix, or a
 * symbol that already has a Yahoo suffix (e.g. "RELIANCE.NS") or is an
 * index ticker starting with "^" (e.g. "^NSEI") — pass exchange as
 * null/undefined for either of the latter two.
 */
export async function getYahooHistoricalData(tradingSymbolOrYahooSymbol, interval, exchange) {
  const yahooSymbol =
    tradingSymbolOrYahooSymbol.includes(".") || tradingSymbolOrYahooSymbol.startsWith("^")
      ? tradingSymbolOrYahooSymbol
      : buildYahooSymbol(exchange, tradingSymbolOrYahooSymbol);

  const mapping = INTERVAL_MAP[interval];
  if (!mapping) {
    throw new Error(
      `No Yahoo Finance interval mapping for "${interval}". Supported: ${Object.keys(INTERVAL_MAP).join(", ")}.`
    );
  }

  const url = `${YAHOO_CHART_BASE_URL}/${encodeURIComponent(yahooSymbol)}`;
  console.log(`[OPENDATA] getYahooHistoricalData(${yahooSymbol}, interval=${mapping.interval}, range=${mapping.range})`);
  try {
    const { data } = await axios.get(url, {
      params: { interval: mapping.interval, range: mapping.range },
      headers: { "User-Agent": "Mozilla/5.0 (compatible; sharekhan-algo-trader/1.0)" },
    });

    const result = data?.chart?.result?.[0];
    if (!result) {
      const yahooError = data?.chart?.error?.description || "Yahoo Finance returned no result for this symbol.";
      throw new Error(`${yahooError} (symbol tried: ${yahooSymbol})`);
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const candles = timestamps.map((ts, i) => ({
      date: new Date(ts * 1000).toISOString(),
      open: quote.open?.[i] ?? null,
      high: quote.high?.[i] ?? null,
      low: quote.low?.[i] ?? null,
      close: quote.close?.[i] ?? null,
      volume: quote.volume?.[i] ?? null,
    })).filter((c) => c.close !== null); // Yahoo pads gaps (holidays/pre-market) with nulls

    console.log(`[OPENDATA][OK] getYahooHistoricalData(${yahooSymbol}) parsed ${candles.length} candles`);
    return {
      source: "yahoo-finance",
      symbol: yahooSymbol,
      interval,
      note: mapping.note,
      candles,
    };
  } catch (err) {
    console.error(`[OPENDATA][FAIL] getYahooHistoricalData(${yahooSymbol}):`, err.response?.data || err.message);
    throw new Error(`Yahoo Finance fallback failed for ${yahooSymbol}: ${err.message}`);
  }
}

/**
 * indexName: "NIFTY" or "BANKNIFTY" (case-insensitive). Always pulls
 * from Yahoo — these aren't Sharekhan scrip-master entries, so there's
 * no "fallback from Sharekhan" step the way there is for stocks.
 */
export async function getIndexHistoricalData(indexName, interval) {
  const symbol = INDEX_YAHOO_SYMBOLS[String(indexName).toUpperCase()];
  if (!symbol) {
    throw new Error(`Unknown index "${indexName}". Supported: ${Object.keys(INDEX_YAHOO_SYMBOLS).join(", ")}.`);
  }
  return getYahooHistoricalData(symbol, interval);
}
