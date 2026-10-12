import { loadSharekhanApi } from "./sharekhanSdkLoader.js";
import "dotenv/config";
import axios from "axios";
import { getToken, saveToken } from "./tokenStore.js";

const SharekhanApi = loadSharekhanApi();

const {
  SHAREKHAN_API_KEY,
  SHAREKHAN_API_SECRET,
  SHAREKHAN_CUSTOMER_ID,
  SHAREKHAN_VENDOR_KEY = "",
  SHAREKHAN_VERSION_ID = "",
  SHAREKHAN_REDIRECT_URL,
} = process.env;

if (!SHAREKHAN_API_KEY || !SHAREKHAN_API_SECRET || !SHAREKHAN_CUSTOMER_ID) {
  console.warn(
    "[CLIENT][WARN] SHAREKHAN_API_KEY / SHAREKHAN_API_SECRET / " +
      "SHAREKHAN_CUSTOMER_ID are not all set. Fill in backend/.env."
  );
}

// Sharekhan's docs state only "" (none), 1005, or 1006 are valid version_id
// values — anything else (e.g. a literal "1") is silently accepted on the
// login-page redirect but then rejected by the token-exchange endpoint as
// a 400 Bad Request, which is exactly the failure mode this caught once.
const ALLOWED_VERSION_IDS = new Set(["", "1005", "1006"]);
if (!ALLOWED_VERSION_IDS.has(SHAREKHAN_VERSION_ID)) {
  console.warn(
    `[CLIENT][WARN] SHAREKHAN_VERSION_ID="${SHAREKHAN_VERSION_ID}" is not ` +
      `a documented valid value (must be blank, 1005, or 1006). This will ` +
      `very likely cause a 400 Bad Request during token exchange.`
  );
}

let client = null;

/**
 * The community Node SDK's README only documents a handful of methods
 * (login, funds, holdings, order placement) and never mentions historical
 * data or scrip master at all — unlike the Java/R/PHP/Python SDKs, which
 * all expose one under a slightly different name each:
 *   Java:   getHistorical(exchange, scripCode, interval)
 *   R:      get_historical(connect, params)
 *   Python: sharekhan.historicaldata(exchange, scripcode, interval)
 * Rather than hardcode one guessed name and break again the moment it's
 * wrong (which is exactly what caused "c.getHistorical is not a function"
 * / "c.getActiveScript is not a function"), these two calls try a list of
 * known candidate names against the *actual* loaded SDK instance and use
 * whichever one really exists. If none match, the resulting error lists
 * every method that genuinely is on the object, so the fix is a one-line
 * addition to the candidate list below instead of another guess.
 */
function resolveMethod(instance, candidates) {
  return candidates.find((name) => typeof instance[name] === "function") || null;
}

function listClientMethods(instance) {
  const own = Object.getOwnPropertyNames(instance).filter((k) => typeof instance[k] === "function");
  const proto = Object.getPrototypeOf(instance);
  const protoMethods = proto
    ? Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor" && typeof instance[k] === "function")
    : [];
  return [...new Set([...own, ...protoMethods])].sort();
}

function getClient() {
  if (!client) {
    console.log(
      `[CLIENT] Creating SharekhanApi instance (customer_id: ${SHAREKHAN_CUSTOMER_ID || "MISSING"})`
    );
    client = new SharekhanApi({
      api_key: SHAREKHAN_API_KEY,
      customer_id: SHAREKHAN_CUSTOMER_ID,
    });
    const stored = getToken();
    if (stored) {
      console.log("[CLIENT] Restoring access token from local store");
      client.setAccessToken(stored.accessToken);
    }
  }
  return client;
}

/**
 * Builds the URL the browser is sent to for login. The official SDK's
 * README doesn't document a helper for this in Node (only Java exposes
 * getLoginURL), so this is built manually against the auth page path
 * Sharekhan documents elsewhere. Confirm this path still matches your
 * developer-portal docs if login itself ever stops redirecting correctly.
 */
export function buildLoginUrl() {
  if (!SHAREKHAN_API_KEY || !SHAREKHAN_REDIRECT_URL) {
    console.error(
      `[CLIENT][FAIL] buildLoginUrl — API_KEY set: ${Boolean(SHAREKHAN_API_KEY)}, ` +
        `REDIRECT_URL set: ${Boolean(SHAREKHAN_REDIRECT_URL)}`
    );
    throw new Error(
      "SHAREKHAN_API_KEY or SHAREKHAN_REDIRECT_URL is missing. " +
        "Check that backend/.env exists (not .env.example), is filled in, " +
        "and that you restarted `npm run dev` after editing it."
    );
  }
  const url = new URL("/skapi/auth/login", "https://api.sharekhan.com");
  url.searchParams.set("api_key", SHAREKHAN_API_KEY);
  url.searchParams.set("redirect_url", SHAREKHAN_REDIRECT_URL);
  if (SHAREKHAN_VENDOR_KEY) url.searchParams.set("vendor_key", SHAREKHAN_VENDOR_KEY);
  if (SHAREKHAN_VERSION_ID) url.searchParams.set("version_id", SHAREKHAN_VERSION_ID);
  return url.toString();
}

/**
 * Exchanges the request_token Sharekhan redirected back with for a real
 * access token, using the official SDK instead of a hand-rolled request.
 */
export async function exchangeRequestToken(requestToken) {
  console.log(
    `[CLIENT] exchangeRequestToken — using ${SHAREKHAN_VERSION_ID ? "WithVersionID" : "WithoutVersionID"} variant`
  );
  const c = getClient();

  let data;
  try {
    data = SHAREKHAN_VERSION_ID
      ? await c.generateSessionWithVersionID(
          requestToken,
          SHAREKHAN_API_SECRET,
          SHAREKHAN_VERSION_ID
        )
      : await c.generateSessionWithoutVersionID(
          requestToken,
          SHAREKHAN_API_SECRET,
          SHAREKHAN_CUSTOMER_ID // some SDK variants (e.g. PHP) require this explicitly
        );
  } catch (err) {
    // The SDK may throw directly (network/axios error) rather than resolving
    // with an error body — log both shapes so nothing gets lost.
    console.error("[CLIENT][FAIL] generateSession* threw:", err.response?.data || err.message);
    throw err;
  }

  console.log("[CLIENT] generateSession* raw response:", JSON.stringify(data));

  // TODO: confirm the exact field name Sharekhan returns the token under —
  // trying the common variants here so a shape change doesn't silently break.
  // Confirmed from a real successful response: it's at data.data.token.
  const accessToken =
    data?.data?.token || data?.accessToken || data?.access_token || data?.data?.accessToken || data?.token;

  if (!accessToken) {
    console.error("[CLIENT][FAIL] No access token field found in response above");
    throw new Error(
      "No access token found in Sharekhan's response: " + JSON.stringify(data)
    );
  }

  console.log("[CLIENT][OK] Access token obtained, saving to local store");
  saveToken({ accessToken, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  c.setAccessToken(accessToken);
  return accessToken;
}

export async function getHoldings() {
  console.log("[CLIENT] getHoldings()");
  const c = getClient();
  try {
    const data = await c.getHoldings();
    console.log("[CLIENT][OK] getHoldings response received");
    return data;
  } catch (err) {
    console.error("[CLIENT][FAIL] getHoldings:", err.response?.data || err.message);
    throw err;
  }
}

export async function getFundsDetails(exchange = "NC") {
  console.log(`[CLIENT] getFundsDetails(exchange=${exchange})`);
  const c = getClient();
  try {
    const data = await c.getFundsDetails(exchange);
    console.log("[CLIENT][OK] getFundsDetails response received");
    return data;
  } catch (err) {
    console.error("[CLIENT][FAIL] getFundsDetails:", err.response?.data || err.message);
    throw err;
  }
}

// Tried in order until one exists on the loaded SDK instance. Add new
// guesses to the front/back as needed — see resolveMethod() above.
//
// Checked against the SDK's own example/test.js (the real usage
// sample, not the trimmed README) — it exercises every other endpoint
// (orders, modify, cancel, holdings, trades, order-history,
// getActiveScriptOfDay, getScriptMasterCSV, websocket) but never once
// mentions a historical/chart-data call. That's strong evidence this
// community Node SDK simply doesn't wrap historical data at all, unlike
// the Java/R/Python SDKs. Left as a candidate list (rather than removed)
// in case a newer package version adds it — but for the currently
// installed build, resolveMethod() will find nothing here, and
// getHistoricalData() below falls back to a direct REST call against
// Sharekhan's documented endpoint (see fetchHistoricalDirect()).
const HISTORICAL_METHOD_CANDIDATES = [
  "getHistorical", // Java/R SDK naming — what this file wrongly called directly before
  "getHistoricalData",
  "getHistoricalChartData",
  "historicalData",
  "historicaldata", // Python SDK naming
  "getHistory",
];

// Tried in order. getScriptMasterCSV is confirmed straight from the SDK's
// own example/test.js ("//script details" / "//return
// sharekhan_api.getScriptMasterCSV('NC')") — it's the real ScripMaster
// call and returns the *whole* exchange's tradable list in one shot (as
// CSV), not something you call per symbol. getActiveScriptOfDay is also
// confirmed in that same file ("//active script details") but is a
// narrower "what traded today" list — kept as a fallback only.
const SCRIP_MASTER_METHOD_CANDIDATES = [
  "getScriptMasterCSV",
  "getScripMasterCSV",
  "getScriptMaster",
  "getScripMaster",
  "getActiveScriptOfDay",
  "getActiveScript",
];

// Master list doesn't change intraday, so fetching it once per exchange
// and reusing it for every search — instead of hitting Sharekhan again
// per keystroke — is both faster and lighter on their API. Keyed by
// exchange; cleared by restarting the backend or passing forceRefresh.
const scripMasterCache = new Map(); // exchange -> { rows, fetchedAt }
const SCRIP_MASTER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimal RFC4180-ish CSV parser (no added dependency) — handles quoted
 * fields containing commas/quotes/newlines. getScriptMasterCSV's real
 * column headers are unverified (unknown until you have a live session
 * to inspect one response), so this parses generically: first row becomes
 * object keys, whatever they turn out to be, rather than assuming names.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.length === headers.length)
    .map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx]])));
}

function normalizeScripMasterResponse(raw) {
  if (typeof raw === "string") return parseCsv(raw);
  if (Array.isArray(raw)) return raw;
  if (typeof raw?.data === "string") return parseCsv(raw.data);
  if (Array.isArray(raw?.data)) return raw.data;
  if (Array.isArray(raw?.scrips)) return raw.scrips;
  return [];
}

// Confirmed by the user directly from Sharekhan's Historical Chart Data
// documentation (the doc page itself renders via JS, so this path isn't
// independently scrapable — taking it as given). Kept as an env override
// in case the base host ever differs from the one used everywhere else
// in this file.
const SHAREKHAN_BASE_URL = process.env.SHAREKHAN_BASE_URL || "https://api.sharekhan.com";
function buildHistoricalUrl(exchange, scripCode, interval) {
  return `${SHAREKHAN_BASE_URL}/skapi/services/historical/${exchange}/${scripCode}/${interval}`;
}

// Confirmed accepted values for the {interval} path segment, straight
// from Sharekhan's Historical Chart Data documentation. Validated
// up front so a typo produces a clear local error instead of an opaque
// 400 from Sharekhan.
export const VALID_HISTORICAL_INTERVALS = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "halfyearly",
  "yearly",
  "1minute",
  "3minute",
  "5minute",
  "10minute",
  "15minute",
  "30minute",
  "60minute",
  "90minute",
];

/**
 * Direct REST fallback for historical data, used only when no SDK method
 * matches (see HISTORICAL_METHOD_CANDIDATES / getHistoricalData below) —
 * confirmed necessary since example/test.js shows the installed SDK never
 * wraps this endpoint at all.
 *
 * Request shape confirmed by the user from Sharekhan's own docs:
 *   GET /services/historical/{exchange}/{scripcode}/{interval}
 *   Headers: Content-Type: application/json, access-token: <token from
 *            /services/access/token>
 * That doc table only listed `access-token`, but a live call came back
 * 401 "Please provide valid api key" — so `api_key` (the same
 * SHAREKHAN_API_KEY used for login/session) is required as a header
 * too, evidently a common header across Sharekhan's REST endpoints
 * rather than something called out per-endpoint in the docs. Sent
 * alongside `access-token` below now.
 */
async function fetchHistoricalDirect(exchange, scripCode, interval) {
  if (!VALID_HISTORICAL_INTERVALS.includes(interval)) {
    throw new Error(
      `interval "${interval}" isn't one of Sharekhan's documented values: ` +
        `${VALID_HISTORICAL_INTERVALS.join(", ")}.`
    );
  }
  const stored = getToken();
  if (!stored?.accessToken) {
    throw new Error(
      "No stored Sharekhan access token — log in via GET /api/auth/login-url first, " +
        "then retry."
    );
  }
  if (!SHAREKHAN_API_KEY) {
    throw new Error("SHAREKHAN_API_KEY is missing from backend/.env — this endpoint requires it as a header.");
  }
  const url = buildHistoricalUrl(exchange, scripCode, interval);
  console.log(`[CLIENT] getHistoricalData() — no SDK method found, falling back to direct REST: GET ${url}`);
  try {
    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        "access-token": stored.accessToken,
        api_key: SHAREKHAN_API_KEY,
      },
    });

    // Observed in practice: Sharekhan sometimes answers with a plain
    // HTTP 200 whose *body* is actually an error —
    // { status: 401, message: "...", errorType: "auth_error" } — rather
    // than a real 4xx/5xx. axios only throws on the latter, so without
    // this check that body was silently treated as valid candle data and
    // handed back to the frontend labeled "source: sharekhan" as if it
    // had succeeded. Normalize it into the same shape axios throws for a
    // real HTTP error, so the catch block below (and everything that
    // reads its message) handles both identically.
    if (response.data && typeof response.data === "object" && response.data.errorType) {
      const embeddedError = new Error(response.data.message || "Sharekhan reported an error");
      embeddedError.response = { status: response.data.status, data: response.data };
      throw embeddedError;
    }

    console.log("[CLIENT][OK] direct historical REST call succeeded");
    return response.data;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.error(`[CLIENT][FAIL] direct historical REST call (status ${status ?? "none"}):`, body || err.message);
    throw new Error(
      `Historical REST call failed${status ? ` with ${status}` : ""}: ${JSON.stringify(body || err.message)}. ` +
        (status === 401 || status === 403
          ? "This is an auth_error — could be a stale/expired access-token (try logging in " +
            "again via GET /api/auth/login-url) or a still-wrong header/value for api_key. If " +
            "it only fails on some scripCodes and not others in the same session, the " +
            "token/key themselves are fine and it's more likely scrip-specific (e.g. no " +
            "historical data entitlement for that instrument) — worth confirming with Sharekhan " +
            "support if it's consistent for a particular scrip."
          : "Check the raw body above for what Sharekhan's API is actually complaining about.")
    );
  }
}

/**
 * exchange: e.g. "NC" (NSE Cash), "MX" (MCX), etc.
 * scripCode: Sharekhan's numeric code for the instrument (not the symbol).
 * interval: one of Sharekhan's documented values — see
 * VALID_HISTORICAL_INTERVALS above ("daily", "weekly", "monthly",
 * "quarterly", "halfyearly", "yearly", or "1minute"…"90minute" in the
 * documented minute steps).
 *
 * Tries the SDK first (in case a future package version adds a real
 * method — see HISTORICAL_METHOD_CANDIDATES), and only falls back to a
 * direct REST call against Sharekhan's documented endpoint when no SDK
 * method exists, which is the confirmed case for the currently installed
 * community package (see comment above HISTORICAL_METHOD_CANDIDATES).
 */
export async function getHistoricalData(exchange, scripCode, interval = "daily") {
  console.log(`[CLIENT] getHistoricalData(exchange=${exchange}, scripCode=${scripCode}, interval=${interval})`);
  const c = getClient();
  const methodName = resolveMethod(c, HISTORICAL_METHOD_CANDIDATES);
  if (!methodName) {
    return fetchHistoricalDirect(exchange, scripCode, interval);
  }
  console.log(`[CLIENT] getHistoricalData() using c.${methodName}(...)`);
  try {
    const data = await c[methodName](exchange, scripCode, interval);
    console.log(`[CLIENT][OK] ${methodName} response received`);
    return data;
  } catch (err) {
    console.error(`[CLIENT][FAIL] ${methodName}:`, err.response?.data || err.message);
    throw err;
  }
}


/**
 * Returns the FULL scrip master for an exchange (every tradable
 * instrument, not just today's active ones) — this is Sharekhan's
 * "ScripMaster" endpoint, confirmed as getScriptMasterCSV(exchange) in
 * the SDK's own example/test.js. Fetched once per exchange and cached
 * in memory for SCRIP_MASTER_CACHE_TTL_MS, since the master list doesn't
 * change intraday — callers should filter/search the returned array
 * themselves rather than re-fetching per search. Pass
 * { forceRefresh: true } to bypass the cache.
 */
export async function getScripMaster(exchange = "NC", { forceRefresh = false } = {}) {
  const cached = scripMasterCache.get(exchange);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < SCRIP_MASTER_CACHE_TTL_MS) {
    console.log(
      `[CLIENT] getScripMaster(${exchange}) — serving ${cached.rows.length} rows from cache ` +
        `(age ${Math.round((Date.now() - cached.fetchedAt) / 1000)}s)`
    );
    return cached.rows;
  }

  console.log(`[CLIENT] getScripMaster(exchange=${exchange}) — fetching fresh${forceRefresh ? " (forced)" : ""}`);
  const c = getClient();
  const methodName = resolveMethod(c, SCRIP_MASTER_METHOD_CANDIDATES);
  if (!methodName) {
    const available = listClientMethods(c);
    const msg =
      `None of the expected scrip-master method names exist on the installed ` +
      `sharekhan-api SDK (tried: ${SCRIP_MASTER_METHOD_CANDIDATES.join(", ")}). ` +
      `Methods actually available on this SDK instance: ${available.join(", ") || "(none found)"}. ` +
      `Run "node backend/scripts/inspect-sdk.js" for the same list, pick the real ` +
      `scrip-master method from it, and add it to SCRIP_MASTER_METHOD_CANDIDATES ` +
      `in sharekhanClient.js.`;
    console.error("[CLIENT][FAIL] getScripMaster:", msg);
    throw new Error(msg);
  }

  console.log(`[CLIENT] getScripMaster() using c.${methodName}(...)`);
  let raw;
  try {
    raw = await c[methodName](exchange);
    console.log(`[CLIENT][OK] ${methodName} response received (${typeof raw})`);
  } catch (err) {
    console.error(`[CLIENT][FAIL] ${methodName}:`, err.response?.data || err.message);
    throw err;
  }

  const rows = normalizeScripMasterResponse(raw);
  scripMasterCache.set(exchange, { rows, fetchedAt: Date.now() });
  console.log(`[CLIENT][OK] getScripMaster(${exchange}) parsed ${rows.length} rows and cached them`);
  return rows;
}

/**
 * Looks up the trading symbol (e.g. "RELIANCE") for a scripCode by
 * searching the cached scrip master — needed for the Yahoo Finance
 * fallback in openDataSources.js, since that provider needs a symbol,
 * not Sharekhan's internal numeric code. The scrip master's real column
 * names are unverified (see parseCsv's comment above), so this checks a
 * few likely key spellings rather than assuming one.
 *
 * Returns null if no row matches or no symbol-shaped column is found —
 * callers should treat that as "can't resolve, fall back to asking the
 * user for the symbol directly" rather than an error.
 */
const SCRIP_CODE_KEY_CANDIDATES = ["scripCode", "ScripCode", "scrip_code", "code", "Code"];
const TRADING_SYMBOL_KEY_CANDIDATES = [
  "tradingSymbol",
  "TradingSymbol",
  "trading_symbol",
  "symbol",
  "Symbol",
  "tradingsymbol",
];

export async function resolveTradingSymbol(exchange, scripCode) {
  const rows = await getScripMaster(exchange);
  const target = String(scripCode);
  const row = rows.find((r) => SCRIP_CODE_KEY_CANDIDATES.some((key) => String(r[key]) === target));
  if (!row) {
    console.warn(`[CLIENT] resolveTradingSymbol(${exchange}, ${scripCode}) — no matching row in scrip master`);
    return null;
  }
  const symbolKey = TRADING_SYMBOL_KEY_CANDIDATES.find((key) => row[key]);
  if (!symbolKey) {
    console.warn(
      `[CLIENT] resolveTradingSymbol(${exchange}, ${scripCode}) — matched a row but no symbol-shaped ` +
        `column among its keys: ${Object.keys(row).join(", ")}`
    );
    return null;
  }
  return row[symbolKey];
}

/**
 * Heuristic check for Sharekhan's "call succeeded but there's genuinely
 * no data" response (a real, observed case — see the "No Historic data
 * available" note in the README) — used by the /historical route to
 * decide whether to try the Yahoo Finance fallback. Sharekhan's exact
 * response shape for this case isn't documented, so this checks for the
 * common ways "empty" tends to show up rather than one exact shape.
 */
export function isEmptyHistoricalResponse(data) {
  if (!data) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (Array.isArray(data?.data)) return data.data.length === 0;
  const text = JSON.stringify(data).toLowerCase();
  return text.includes("no historic") || text.includes("no data") || text.includes("data not available");
}

/**
 * Pure introspection, no API call — lists every callable method the
 * loaded SDK instance actually exposes. Used by the /debug/sdk-methods
 * route and backend/scripts/inspect-sdk.js so "is this method real?"
 * has a definitive one-command answer instead of another guess.
 */
export function getSdkMethodInventory() {
  const c = getClient();
  return {
    allMethods: listClientMethods(c),
    resolvedHistoricalMethod: resolveMethod(c, HISTORICAL_METHOD_CANDIDATES),
    resolvedScripMasterMethod: resolveMethod(c, SCRIP_MASTER_METHOD_CANDIDATES),
  };
}

// Safety switch for the backtest-only phase: refuses to let any
// order-touching call reach Sharekhan's live API unless the operator has
// explicitly opted in via backend/.env. Checked at call time (not once at
// startup) so a restart after flipping the flag is the only requirement.
function assertLiveTradingEnabled(action) {
  if (process.env.ENABLE_LIVE_TRADING !== "true") {
    throw new Error(
      `${action} is blocked — this app is running in backtest-only mode ` +
        `(ENABLE_LIVE_TRADING is not "true" in backend/.env). Historical data ` +
        `and scrip search still work normally; only live order calls are refused. ` +
        `Set ENABLE_LIVE_TRADING=true and restart the backend if you actually ` +
        `intend to touch a live order.`
    );
  }
}

/**
 * order shape per the official SDK example — NOT the generic
 * {symbol, transactionType, quantity} shape from the first draft.
 * Required fields: customerId, scripCode, tradingSymbol, exchange,
 * transactionType ('B'|'S'), quantity, price, orderType, validity,
 * productType, requestType: 'NEW', rmsCode, afterHour, channelUser,
 * disclosedQty, triggerPrice.
 */
export async function placeOrder(order) {
  assertLiveTradingEnabled("placeOrder()");
  console.log("[CLIENT] placeOrder():", JSON.stringify(order));
  const c = getClient();
  try {
    const data = await c.placeNewOrder({
      customerId: SHAREKHAN_CUSTOMER_ID,
      requestType: "NEW",
      afterHour: "N",
      disclosedQty: 0,
      triggerPrice: "0",
      rmsCode: "ANY",
      validity: "GFD",
      orderType: "NORMAL",
      productType: "INVESTMENT",
      ...order,
    });
    console.log("[CLIENT][OK] placeNewOrder response received");
    return data;
  } catch (err) {
    console.error("[CLIENT][FAIL] placeNewOrder:", err.response?.data || err.message);
    throw err;
  }
}
