<template>
  <div class="page">
    <header>
      <h1>Dashboard</h1>
      <button class="ghost" @click="logout">Logout</button>
    </header>

    <section class="card">
      <h2>Holdings</h2>
      <button class="small" @click="loadHoldings" :disabled="loadingHoldings">
        {{ loadingHoldings ? "Loading…" : "Refresh" }}
      </button>
      <p v-if="holdingsError" class="error">{{ holdingsError }}</p>
      <DataTable v-if="holdings !== null" :rows="holdingsRows" />
    </section>

    <section class="card">
      <h2>Find scrip code</h2>
      <p class="sub">Search by symbol to get the scripCode needed below — or use Sharekhan's <a href="https://www.sharekhan.com/Downloads/Tradable_scrips.xls" target="_blank" rel="noopener">full scrip master download</a> for offline browsing.</p>
      <form @submit.prevent="searchScrips">
        <input v-model="scripSearch.exchange" placeholder="Exchange e.g. NC" required />
        <input v-model="scripSearch.search" placeholder="Symbol e.g. ONGC" required />
        <button type="submit" :disabled="searchingScrips">
          {{ searchingScrips ? "Searching…" : "Search" }}
        </button>
      </form>
      <p v-if="scripSearchError" class="error">{{ scripSearchError }}</p>
      <p v-if="scripResults.length" class="sub">Click a row to fill in the scrip code below.</p>
      <DataTable :rows="scripResults" clickable @row-click="applyScrip" />
    </section>

    <section class="card">
      <h2>Historical data</h2>
      <p class="sub">Fetch OHLC candles for backtesting — this is the connection you'll build strategies against.</p>
      <form @submit.prevent="loadHistorical">
        <input v-model="hist.exchange" placeholder="Exchange e.g. NC" required />
        <input v-model.number="hist.scripCode" type="number" placeholder="Scrip code" required />
        <select v-model="hist.interval">
          <option v-for="opt in intervalOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <button type="submit" :disabled="loadingHistorical">
          {{ loadingHistorical ? "Loading…" : "Fetch" }}
        </button>
      </form>
      <p v-if="historicalError" class="error">{{ historicalError }}</p>
      <p v-if="historicalSource" class="sub">
        Source: <strong>{{ historicalSource }}</strong>
        <span v-if="historicalNote"> — {{ historicalNote }}</span>
      </p>
      <p v-if="historicalSharekhanReason" class="sub">
        (Sharekhan didn't provide this data: {{ historicalSharekhanReason }})
      </p>
      <DataTable v-if="historical !== null" :rows="historicalRows" />
    </section>

    <details class="card">
      <summary>Manual order (blocked — backtest-only mode)</summary>
      <p class="sub">
        The backend refuses this call by default (<code>ENABLE_LIVE_TRADING</code>
        isn't <code>true</code> in <code>backend/.env</code>) so nothing here can
        reach the live market while you're still backtesting. Fields match the
        official SDK's placeNewOrder shape — confirm scripCode/tradingSymbol
        lookups before ever enabling live trading.
      </p>
      <form @submit.prevent="submitOrder">
        <input v-model="order.tradingSymbol" placeholder="Trading symbol e.g. ONGC" required />
        <input v-model.number="order.scripCode" type="number" placeholder="Scrip code" required />
        <input v-model="order.exchange" placeholder="Exchange e.g. NC" required />
        <select v-model="order.transactionType">
          <option value="B">BUY</option>
          <option value="S">SELL</option>
        </select>
        <input v-model.number="order.quantity" type="number" min="1" placeholder="Qty" required />
        <input v-model="order.price" placeholder="Price" required />
        <button type="submit" :disabled="placingOrder">
          {{ placingOrder ? "Placing…" : "Place order" }}
        </button>
      </form>
      <p v-if="orderResult" class="result">{{ orderResult }}</p>
      <p v-if="orderError" class="error">{{ orderError }}</p>
    </details>

    <section class="card">
      <h2>Backtest</h2>
      <p class="sub">
        Runs the <strong>Opening Range Breakout</strong> strategy (default 9:15–10:15 IST) across
        however many scrips you add below, sharing one capital pool across them — so "multiple
        trades at a time" is capital-constrained the same way a real account would be.
      </p>

      <div class="scrip-rows">
        <div v-for="(row, i) in backtestScrips" :key="i" class="scrip-row">
          <input v-model="row.exchange" placeholder="Exchange e.g. NC" title="Sharekhan exchange code — NC = NSE Cash, BC = BSE Cash" />
          <input v-model="row.scripCode" placeholder="Scrip code" title="Sharekhan's numeric code for the instrument (not the trading symbol) — find it via the scrip search above" />
          <button type="button" class="ghost small" @click="backtestScrips.splice(i, 1)">Remove</button>
        </div>
        <button type="button" class="small" @click="backtestScrips.push({ exchange: 'NC', scripCode: '' })">
          + Add scrip
        </button>
      </div>

      <form @submit.prevent="runBacktestNow">
        <div class="field">
          <label>Interval</label>
          <select v-model="backtestForm.interval">
            <option v-for="opt in intervalOptions" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <small>Candle size for the backtest.</small>
        </div>
        <div class="field">
          <label>Capital (₹)</label>
          <input v-model.number="backtestForm.capital" type="number" />
          <small>Total account capital. Directly limits position sizing here (share count = maxPerTrade ÷ price).</small>
        </div>
        <div class="field">
          <label>Max per trade (₹)</label>
          <input v-model.number="backtestForm.maxPerTrade" type="number" />
          <small>Cap on rupees spent per single position. capital ÷ maxPerTrade ≈ max concurrent trades.</small>
        </div>
        <div class="field">
          <label>Session start</label>
          <input v-model="backtestForm.sessionStart" placeholder="09:15" />
          <small>IST time the opening range starts forming.</small>
        </div>
        <div class="field">
          <label>Session end</label>
          <input v-model="backtestForm.sessionEnd" placeholder="10:15" />
          <small>IST time trading stops — open positions are force-closed here.</small>
        </div>
        <div class="field">
          <label>R:R (target multiple)</label>
          <input v-model.number="backtestForm.targetMultiple" type="number" step="0.5" min="0.5" />
          <small>Reward as a multiple of risk — 3 means target = 3x the stop distance (a 1:3 risk:reward).</small>
        </div>
        <label class="checkbox">
          <input type="checkbox" v-model="backtestForm.allowShort" />
          Allow short entries
        </label>
        <button type="submit" :disabled="runningBacktest">
          {{ runningBacktest ? "Running…" : "Run backtest" }}
        </button>
      </form>
      <p v-if="backtestError" class="error">{{ backtestError }}</p>

      <div v-if="backtestSummary" class="summary-grid">
        <div><span class="sub">Trades</span><strong>{{ backtestSummary.totalTrades }}</strong></div>
        <div><span class="sub">Skipped (no capital)</span><strong>{{ backtestSummary.skippedTrades }}</strong></div>
        <div><span class="sub">Win rate</span><strong>{{ backtestSummary.winRate }}%</strong></div>
        <div><span class="sub">Total P&amp;L</span><strong :class="backtestSummary.totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'">₹{{ backtestSummary.totalPnl }}</strong></div>
        <div><span class="sub">Return on capital</span><strong>{{ backtestSummary.returnOnCapitalPct }}%</strong></div>
        <div><span class="sub">Peak capital deployed</span><strong>₹{{ backtestSummary.peakCapitalDeployed }}</strong></div>
      </div>

      <div v-if="backtestFetchErrors.length" class="sub">
        <p>Some scrips couldn't be fetched and were skipped from the run:</p>
        <ul>
          <li v-for="(e, i) in backtestFetchErrors" :key="i">{{ e.exchange }}/{{ e.scripCode }} — {{ e.error }}</li>
        </ul>
      </div>

      <p v-if="backtestTrades.length" class="sub">Executed trades:</p>
      <DataTable v-if="backtestTrades.length" :rows="backtestTrades" />

      <p v-if="backtestSkipped.length" class="sub">Skipped (capital unavailable at signal time):</p>
      <DataTable v-if="backtestSkipped.length" :rows="backtestSkipped" />
    </section>

    <section class="card">
      <h2>Index F&amp;O scalping backtest — NIFTY / BANKNIFTY futures</h2>
      <p class="sub">
        A separate block on purpose: indices aren't scrip-master instruments (data always comes
        from Yahoo, not Sharekhan), and a "share count from capital ÷ price" model breaks down at
        index point values — so position sizing here is lot-based (your lot size x number of lots),
        matching how F&amp;O futures actually trade, with a hard cap on concurrent positions instead
        of a capital pool. Strategy is <strong>EMA crossover scalping</strong>: fast/slow EMA cross
        is the entry, fixed point stop/target, multiple trades per session allowed. Models
        <strong>futures</strong> (linear payoff) only — not options, which need strike/premium/IV
        data this app's free sources don't reliably provide.
      </p>

      <div class="checkbox-row">
        <label class="checkbox" v-for="idx in indexOptions" :key="idx">
          <input type="checkbox" :value="idx" v-model="indexBacktestForm.indices" />
          {{ idx }} <span class="sub">(lot {{ indexDefaults?.lotSizes?.[idx] ?? "?" }})</span>
        </label>
      </div>

      <form @submit.prevent="runIndexBacktestNow">
        <div class="field">
          <label>Interval</label>
          <select v-model="indexBacktestForm.interval">
            <option v-for="opt in intervalOptions" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <small>{{ fieldHint('interval') }}</small>
        </div>
        <div class="field">
          <label>Number of lots</label>
          <input v-model.number="indexBacktestForm.numberOfLots" type="number" min="1" :title="fieldHint('numberOfLots')" />
          <small>{{ fieldHint('numberOfLots') }}</small>
        </div>
        <div class="field">
          <label>Max concurrent positions</label>
          <input v-model.number="indexBacktestForm.maxConcurrentPositions" type="number" min="1" :title="fieldHint('maxConcurrentPositions')" />
          <small>{{ fieldHint('maxConcurrentPositions') }}</small>
        </div>
        <div class="field">
          <label>Capital (₹)</label>
          <input v-model.number="indexBacktestForm.capital" type="number" :title="fieldHint('capital')" />
          <small>Reporting only — doesn't limit sizing here (number of lots does).</small>
        </div>
        <div class="field">
          <label>Margin % (approx.)</label>
          <input v-model.number="indexBacktestForm.marginPercent" type="number" step="0.5" :title="fieldHint('marginPercent')" />
          <small>Rough SPAN+exposure estimate, not a real broker figure.</small>
        </div>
        <div class="field">
          <label>Stop-loss (points)</label>
          <input v-model.number="indexBacktestForm.stopLossPoints" type="number" :title="fieldHint('strategyOptions.stopLossPoints')" />
          <small>Index points from entry, not ₹ or %.</small>
        </div>
        <div class="field">
          <label>Target (points)</label>
          <input v-model.number="indexBacktestForm.targetPoints" type="number" :title="fieldHint('strategyOptions.targetPoints')" />
          <small>targetPoints ÷ stopLossPoints = your risk:reward.</small>
        </div>
        <label class="checkbox">
          <input type="checkbox" v-model="indexBacktestForm.allowShort" />
          Allow short entries
        </label>
        <button type="submit" :disabled="runningIndexBacktest">
          {{ runningIndexBacktest ? "Running…" : "Run index backtest" }}
        </button>
      </form>
      <p v-if="indexBacktestError" class="error">{{ indexBacktestError }}</p>

      <div v-if="indexBacktestSummary" class="summary-grid">
        <div><span class="sub">Trades</span><strong>{{ indexBacktestSummary.totalTrades }}</strong></div>
        <div><span class="sub">Skipped (slots full)</span><strong>{{ indexBacktestSummary.skippedTrades }}</strong></div>
        <div><span class="sub">Win rate</span><strong>{{ indexBacktestSummary.winRate }}%</strong></div>
        <div><span class="sub">Total P&amp;L</span><strong :class="indexBacktestSummary.totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'">₹{{ indexBacktestSummary.totalPnl }}</strong></div>
        <div><span class="sub">Return on capital</span><strong>{{ indexBacktestSummary.returnOnCapitalPct }}%</strong></div>
        <div><span class="sub">Peak notional exposure</span><strong>₹{{ indexBacktestSummary.peakNotionalExposure }}</strong></div>
        <div v-if="indexBacktestSummary.approxMarginRequired !== undefined">
          <span class="sub">Approx. margin required</span>
          <strong :class="indexBacktestSummary.marginExceedsCapital ? 'pnl-neg' : ''">₹{{ indexBacktestSummary.approxMarginRequired }}</strong>
        </div>
      </div>
      <p v-if="indexBacktestSummary?.marginExceedsCapital" class="error">
        Estimated margin (₹{{ indexBacktestSummary.approxMarginRequired }}) exceeds your stated capital
        (₹{{ indexBacktestSummary.capital }}) — reduce number of lots or max concurrent positions.
      </p>
      <p v-if="indexBacktestSummary?.notionalExposureNote" class="sub">{{ indexBacktestSummary.notionalExposureNote }}</p>

      <div v-if="indexBacktestFetchErrors.length" class="sub">
        <p>Some indices couldn't be fetched and were skipped from the run:</p>
        <ul>
          <li v-for="(e, i) in indexBacktestFetchErrors" :key="i">{{ e.index }} — {{ e.error }}</li>
        </ul>
      </div>

      <p v-if="indexBacktestTrades.length" class="sub">Executed trades:</p>
      <DataTable v-if="indexBacktestTrades.length" :rows="indexBacktestTrades" />

      <p v-if="indexBacktestSkipped.length" class="sub">Skipped (all position slots full at signal time):</p>
      <DataTable v-if="indexBacktestSkipped.length" :rows="indexBacktestSkipped" />
    </section>

    <section class="card">
      <h2>Live signal check — paper trading only</h2>
      <p class="sub">
        Checks whether your strategy just fired a signal on the latest available candle, and if
        so, logs what order it <em>would</em> place — it never actually sends an order. This isn't
        gated by a setting you could flip; the code that would place a real order simply isn't
        called anywhere in this feature. Click "Check now" any time, or turn on auto-check to poll
        periodically while this page stays open.
      </p>

      <form @submit.prevent="checkLiveSignalNow">
        <div class="field">
          <label>Instrument type</label>
          <select v-model="liveSignalForm.instrumentType">
            <option value="stock">Stock</option>
            <option value="index">Index (NIFTY/BANKNIFTY)</option>
          </select>
          <small>Stocks use Sharekhan scrip codes; indices use NIFTY/BANKNIFTY directly.</small>
        </div>
        <div class="field" v-if="liveSignalForm.instrumentType === 'stock'">
          <label>Exchange</label>
          <input v-model="liveSignalForm.exchange" placeholder="NC" />
        </div>
        <div class="field">
          <label>{{ liveSignalForm.instrumentType === 'index' ? 'Index' : 'Scrip code' }}</label>
          <input v-if="liveSignalForm.instrumentType === 'stock'" v-model="liveSignalForm.scripCode" placeholder="e.g. 2885" />
          <select v-else v-model="liveSignalForm.scripCode">
            <option value="NIFTY">NIFTY</option>
            <option value="BANKNIFTY">BANKNIFTY</option>
          </select>
        </div>
        <div class="field">
          <label>Strategy</label>
          <select v-model="liveSignalForm.strategy">
            <option value="opening-range-breakout">Opening Range Breakout</option>
            <option value="ema-crossover-scalping">EMA Crossover Scalping</option>
          </select>
        </div>
        <div class="field">
          <label>Interval</label>
          <select v-model="liveSignalForm.interval">
            <option v-for="opt in intervalOptions" :key="opt" :value="opt">{{ opt }}</option>
          </select>
        </div>
        <div class="field">
          <label>Quantity</label>
          <input v-model.number="liveSignalForm.quantity" type="number" min="1" />
          <small>Size for the paper order if a fresh signal fires — not derived from capital here.</small>
        </div>
        <label class="checkbox">
          <input type="checkbox" v-model="autoCheckEnabled" @change="toggleAutoCheck" />
          Auto-check every 60s
        </label>
        <button type="submit" :disabled="checkingLiveSignal">
          {{ checkingLiveSignal ? "Checking…" : "Check now" }}
        </button>
      </form>
      <p v-if="liveSignalError" class="error">{{ liveSignalError }}</p>

      <div v-if="liveSignalResult" class="sub">
        <p>
          Latest candle: {{ liveSignalResult.latestCandleTime }} — {{ liveSignalResult.fetchedCandles }} candles fetched,
          {{ liveSignalResult.allTodaysSignals.length }} signal(s) today.
        </p>
        <p v-if="liveSignalResult.dispatched">
          <strong class="pnl-pos">Paper order logged</strong> — {{ liveSignalResult.dispatched.order.transactionType === 'B' ? 'BUY' : 'SELL' }}
          {{ liveSignalResult.dispatched.order.quantity }} {{ liveSignalResult.dispatched.order.tradingSymbol }}
          @ ₹{{ liveSignalResult.dispatched.order.price }}
        </p>
        <p v-else-if="liveSignalResult.duplicate">Signal already logged on a previous check — not duplicated.</p>
        <p v-else-if="liveSignalResult.freshSignal">Fresh signal found but not dispatched (unexpected — check logs).</p>
        <p v-else>No fresh signal on the latest candle.</p>
      </div>

      <div class="card-row">
        <p class="sub">Paper trade log:</p>
        <button type="button" class="ghost small" @click="loadPaperTrades">Refresh</button>
        <button type="button" class="ghost small" @click="clearPaperTrades">Clear</button>
      </div>
      <DataTable :rows="paperTrades" />
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../lib/api";
import DataTable from "../components/DataTable.vue";

const router = useRouter();

// Every endpoint here wraps its actual row data differently (a bare
// array, { data: [...] }, { candles: [...] }, ...) and some of those
// shapes are still unverified against a real response (Sharekhan's raw
// historical payload, holdings). Rather than assume one shape per
// endpoint and break the table the moment it's wrong, this tries the
// common wrapper keys in order and falls back to an empty table.
function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["candles", "data", "holdings", "history", "result", "records", "scrips"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

const holdings = ref(null);
const holdingsError = ref("");
const loadingHoldings = ref(false);
const holdingsRows = computed(() => extractRows(holdings.value));

const order = ref({
  tradingSymbol: "RELIANCE",
  scripCode: null,
  exchange: "NC",
  transactionType: "B",
  quantity: 1,
  price: "",
});
const orderResult = ref("");
const orderError = ref("");
const placingOrder = ref(false);

const hist = ref({ exchange: "NC", scripCode: null, interval: "daily" });
const historical = ref(null);
const historicalSource = ref("");
const historicalNote = ref("");
const historicalSharekhanReason = ref("");
const historicalError = ref("");
const loadingHistorical = ref(false);
// /market/historical wraps its response as { source, data } — data's
// own shape then varies by source (Yahoo's { candles: [...] } vs
// Sharekhan's still-unverified raw shape), so this unwraps that outer
// layer before handing rows to extractRows/DataTable.
const historicalRows = computed(() => extractRows(historical.value?.data));

// Fallback list matches VALID_HISTORICAL_INTERVALS in
// backend/src/sharekhanClient.js in case /market/intervals hasn't
// loaded yet (e.g. slow network) — kept in sync manually since this is
// a static reference list, not fetched per keystroke.
const intervalOptions = ref([
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
]);

const scripSearch = ref({ exchange: "NC", search: "RELIANCE" });
const scripResults = ref([]);
const scripSearchError = ref("");
const searchingScrips = ref(false);

async function searchScrips() {
  console.log(`[DASHBOARD] searchScrips() exchange=${scripSearch.value.exchange} search="${scripSearch.value.search}"`);
  searchingScrips.value = true;
  scripSearchError.value = "";
  scripResults.value = [];
  try {
    const { data } = await api.get("/market/scrips", { params: scripSearch.value });
    console.log(`[DASHBOARD][OK] searchScrips got ${data.length} results`);
    scripResults.value = data;
  } catch (err) {
    console.error("[DASHBOARD][FAIL] searchScrips", err);
    scripSearchError.value = err.response?.data?.error || "Search failed.";
  } finally {
    searchingScrips.value = false;
  }
}

function applyScrip(row) {
  // Real column headers from getScriptMasterCSV are unverified until a
  // live response is seen, so this scans every key case-insensitively
  // for something scrip-code-shaped rather than assuming an exact name.
  // Preference order: an explicit "scrip code" field, then any generic
  // "code"/"token" field, so e.g. "ExchangeToken" beats an unrelated
  // "Series" column.
  const entries = Object.entries(row);
  const byPattern = (re) => entries.find(([key]) => re.test(key));
  const match =
    byPattern(/^scrip[\s_-]?code$/i) ||
    byPattern(/scrip.*code/i) ||
    byPattern(/^(code|token)$/i) ||
    byPattern(/(code|token)$/i);
  const code = match?.[1];
  console.log(`[DASHBOARD] applyScrip() matched key="${match?.[0]?.[0]}" code=${code} from row`, row);
  if (code) hist.value.scripCode = Number(code) || code;
}

// --- Backtest ---
const backtestScrips = ref([{ exchange: "NC", scripCode: "" }]);
const backtestForm = ref({
  interval: "5minute",
  capital: 100000,
  maxPerTrade: 20000,
  sessionStart: "09:15",
  sessionEnd: "10:15",
  targetMultiple: 3, // R:R of 1:targetMultiple — matches ORB_DEFAULTS in openingRangeBreakout.js
  allowShort: true,
});
const runningBacktest = ref(false);
const backtestError = ref("");
const backtestSummary = ref(null);
const backtestTrades = ref([]);
const backtestSkipped = ref([]);
const backtestFetchErrors = ref([]);

async function runBacktestNow() {
  const scrips = backtestScrips.value
    .filter((r) => r.exchange && r.scripCode)
    .map((r) => ({ exchange: r.exchange, scripCode: r.scripCode }));
  console.log("[DASHBOARD] runBacktestNow()", scrips, backtestForm.value);
  if (!scrips.length) {
    backtestError.value = "Add at least one scrip (exchange + scrip code) above.";
    return;
  }
  runningBacktest.value = true;
  backtestError.value = "";
  backtestSummary.value = null;
  backtestTrades.value = [];
  backtestSkipped.value = [];
  backtestFetchErrors.value = [];
  try {
    const { data } = await api.post("/backtest/run", {
      scrips,
      interval: backtestForm.value.interval,
      capital: backtestForm.value.capital,
      maxPerTrade: backtestForm.value.maxPerTrade,
      strategy: "opening-range-breakout",
      strategyOptions: {
        session: { start: backtestForm.value.sessionStart, end: backtestForm.value.sessionEnd },
        targetMultiple: backtestForm.value.targetMultiple,
        allowShort: backtestForm.value.allowShort,
      },
    });
    console.log("[DASHBOARD][OK] runBacktestNow received result", data.summary);
    backtestSummary.value = data.summary;
    backtestTrades.value = data.trades || [];
    backtestSkipped.value = data.skippedTrades || [];
    backtestFetchErrors.value = data.fetchErrors || [];
  } catch (err) {
    console.error("[DASHBOARD][FAIL] runBacktestNow", err);
    backtestError.value = err.response?.data?.error || "Backtest failed.";
  } finally {
    runningBacktest.value = false;
  }
}

// --- Index F&O scalping backtest (separate block: see the note in the template) ---
const indexOptions = ["NIFTY", "BANKNIFTY"];
const indexDefaults = ref(null); // populated from GET /index-backtest/defaults — lotSizes, fieldInfo, etc.
const indexBacktestForm = ref({
  indices: ["NIFTY"],
  interval: "3minute",
  numberOfLots: 1, // actual quantity = numberOfLots x that index's lot size (see indexDefaults.lotSizes)
  maxConcurrentPositions: 2,
  capital: 100000, // reporting only here — doesn't constrain sizing, see template note
  marginPercent: 12, // overwritten by indexDefaults.defaultMarginPercent once loaded
  stopLossPoints: 15,
  targetPoints: 30,
  allowShort: true,
});
const runningIndexBacktest = ref(false);
const indexBacktestError = ref("");
const indexBacktestSummary = ref(null);
const indexBacktestTrades = ref([]);
const indexBacktestSkipped = ref([]);
const indexBacktestFetchErrors = ref([]);

// Looks up a field's plain-language description from the backend's
// FIELD_INFO map (routes/indexBacktest.js) rather than duplicating that
// text here — matches this app's existing pattern (GET /defaults) of
// keeping the frontend and backend from drifting apart. Falls back to
// empty string before indexDefaults has loaded.
function fieldHint(key) {
  return indexDefaults.value?.fieldInfo?.[key] || "";
}

async function loadIndexBacktestDefaults() {
  try {
    const { data } = await api.get("/index-backtest/defaults");
    indexDefaults.value = data;
    if (data?.defaultMarginPercent) indexBacktestForm.value.marginPercent = data.defaultMarginPercent;
    console.log("[DASHBOARD][OK] loadIndexBacktestDefaults", data);
  } catch (err) {
    console.warn("[DASHBOARD] loadIndexBacktestDefaults failed — field hints/lot sizes won't be shown", err);
  }
}

async function runIndexBacktestNow() {
  console.log("[DASHBOARD] runIndexBacktestNow()", indexBacktestForm.value);
  if (!indexBacktestForm.value.indices.length) {
    indexBacktestError.value = "Select at least one index (NIFTY / BANKNIFTY) above.";
    return;
  }
  runningIndexBacktest.value = true;
  indexBacktestError.value = "";
  indexBacktestSummary.value = null;
  indexBacktestTrades.value = [];
  indexBacktestSkipped.value = [];
  indexBacktestFetchErrors.value = [];
  try {
    const { data } = await api.post("/index-backtest/run", {
      indices: indexBacktestForm.value.indices,
      interval: indexBacktestForm.value.interval,
      strategy: "ema-crossover-scalping",
      strategyOptions: {
        stopLossPoints: indexBacktestForm.value.stopLossPoints,
        targetPoints: indexBacktestForm.value.targetPoints,
        allowShort: indexBacktestForm.value.allowShort,
      },
      numberOfLots: indexBacktestForm.value.numberOfLots,
      maxConcurrentPositions: indexBacktestForm.value.maxConcurrentPositions,
      capital: indexBacktestForm.value.capital,
      marginPercent: indexBacktestForm.value.marginPercent,
    });
    console.log("[DASHBOARD][OK] runIndexBacktestNow received result", data.summary);
    indexBacktestSummary.value = data.summary;
    indexBacktestTrades.value = data.trades || [];
    indexBacktestSkipped.value = data.skippedTrades || [];
    indexBacktestFetchErrors.value = data.fetchErrors || [];
  } catch (err) {
    console.error("[DASHBOARD][FAIL] runIndexBacktestNow", err);
    indexBacktestError.value = err.response?.data?.error || "Index backtest failed.";
  } finally {
    runningIndexBacktest.value = false;
  }
}

// --- Live signal check (paper trading only — see the note in the template) ---
const liveSignalForm = ref({
  instrumentType: "stock",
  exchange: "NC",
  scripCode: "",
  strategy: "opening-range-breakout",
  interval: "5minute",
  quantity: 1,
});
const checkingLiveSignal = ref(false);
const liveSignalError = ref("");
const liveSignalResult = ref(null);
const paperTrades = ref([]);
const autoCheckEnabled = ref(false);
let autoCheckTimer = null;

async function checkLiveSignalNow() {
  console.log("[DASHBOARD] checkLiveSignalNow()", liveSignalForm.value);
  if (!liveSignalForm.value.scripCode) {
    liveSignalError.value = "Enter a scrip code (or pick an index) above.";
    return;
  }
  checkingLiveSignal.value = true;
  liveSignalError.value = "";
  try {
    const { data } = await api.post("/live-signal/check", {
      instrumentType: liveSignalForm.value.instrumentType,
      exchange: liveSignalForm.value.exchange,
      scripCode: liveSignalForm.value.scripCode,
      interval: liveSignalForm.value.interval,
      strategy: liveSignalForm.value.strategy,
      quantity: liveSignalForm.value.quantity,
    });
    console.log("[DASHBOARD][OK] checkLiveSignalNow", data);
    liveSignalResult.value = data;
    if (data.dispatched) await loadPaperTrades();
  } catch (err) {
    console.error("[DASHBOARD][FAIL] checkLiveSignalNow", err);
    liveSignalError.value = err.response?.data?.error || "Signal check failed.";
  } finally {
    checkingLiveSignal.value = false;
  }
}

async function loadPaperTrades() {
  try {
    const { data } = await api.get("/live-signal/paper-trades");
    paperTrades.value = data || [];
  } catch (err) {
    console.warn("[DASHBOARD] loadPaperTrades failed", err);
  }
}

async function clearPaperTrades() {
  try {
    await api.delete("/live-signal/paper-trades");
    paperTrades.value = [];
    console.log("[DASHBOARD][OK] clearPaperTrades");
  } catch (err) {
    console.error("[DASHBOARD][FAIL] clearPaperTrades", err);
  }
}

function toggleAutoCheck() {
  if (autoCheckEnabled.value) {
    console.log("[DASHBOARD] auto-check enabled — polling every 60s");
    autoCheckTimer = setInterval(checkLiveSignalNow, 60000);
  } else {
    console.log("[DASHBOARD] auto-check disabled");
    clearInterval(autoCheckTimer);
    autoCheckTimer = null;
  }
}

onUnmounted(() => {
  // Auto-check uses a plain setInterval tied to this component's
  // lifetime, not a server-side scheduler (see routes/liveSignal.js's
  // header comment) — clearing it here avoids leaking a timer that
  // keeps firing (and logging paper orders) after the page is gone.
  if (autoCheckTimer) clearInterval(autoCheckTimer);
});

onMounted(() => {
  // Reliance is our default backtest target — run the search immediately
  // so its real scripCode is visible without an extra click.
  console.log("[DASHBOARD] Mounted — running default scrip search");
  searchScrips();
  loadIntervalOptions();
  loadIndexBacktestDefaults();
  loadPaperTrades();
});

async function loadIntervalOptions() {
  // Pulls the authoritative list from the backend (VALID_HISTORICAL_INTERVALS
  // in sharekhanClient.js) so the dropdown can't drift out of sync with what
  // the server actually validates against. Silently keeps the static
  // fallback list above if this fails — not worth surfacing an error for.
  try {
    const { data } = await api.get("/market/intervals");
    if (Array.isArray(data) && data.length) intervalOptions.value = data;
  } catch (err) {
    console.warn("[DASHBOARD] loadIntervalOptions failed, keeping static fallback list", err);
  }
}

async function loadHistorical() {
  console.log(`[DASHBOARD] loadHistorical()`, hist.value);
  loadingHistorical.value = true;
  historicalError.value = "";
  historicalSource.value = "";
  historicalNote.value = "";
  historicalSharekhanReason.value = "";
  try {
    const { data } = await api.get("/market/historical", { params: hist.value });
    console.log("[DASHBOARD][OK] loadHistorical received data, source:", data?.source);
    // /market/historical always wraps its response as { source, data } —
    // source is "sharekhan" or "yahoo-finance" (the latter when Sharekhan
    // itself had no data, or failed outright — auth error, network error,
    // etc — and the backend fell back automatically). When the fallback
    // was used, `sharekhanReason` explains why Sharekhan didn't provide
    // it, and the fallback case also carries an optional `note` about
    // interval approximation (e.g. "quarterly" -> Yahoo's nearest monthly
    // bucket). Kept as the raw object (not stringified) so historicalRows
    // can extract a table from it.
    historical.value = data;
    historicalSource.value = data?.source || "";
    historicalNote.value = data?.data?.note || "";
    historicalSharekhanReason.value = data?.sharekhanReason || "";
  } catch (err) {
    console.error("[DASHBOARD][FAIL] loadHistorical", err);
    historicalError.value = err.response?.data?.error || "Failed to load historical data.";
  } finally {
    loadingHistorical.value = false;
  }
}

async function loadHoldings() {
  console.log("[DASHBOARD] loadHoldings()");
  loadingHoldings.value = true;
  holdingsError.value = "";
  try {
    const { data } = await api.get("/orders/holdings");
    console.log("[DASHBOARD][OK] loadHoldings received data");
    holdings.value = data;
  } catch (err) {
    console.error("[DASHBOARD][FAIL] loadHoldings", err);
    holdingsError.value = err.response?.data?.error || "Failed to load holdings.";
  } finally {
    loadingHoldings.value = false;
  }
}

async function submitOrder() {
  console.log("[DASHBOARD] submitOrder()", order.value);
  placingOrder.value = true;
  orderResult.value = "";
  orderError.value = "";
  try {
    const { data } = await api.post("/orders/place", order.value);
    console.log("[DASHBOARD][OK] submitOrder received response");
    orderResult.value = `Order response: ${JSON.stringify(data)}`;
  } catch (err) {
    console.error("[DASHBOARD][FAIL] submitOrder", err);
    orderError.value = err.response?.data?.error || "Order failed.";
  } finally {
    placingOrder.value = false;
  }
}

async function logout() {
  console.log("[DASHBOARD] logout()");
  await api.post("/auth/logout");
  router.push("/login");
}
</script>

<style scoped>
.page {
  max-width: 860px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}
.card {
  background: #171a21;
  border: 1px solid #262a33;
  border-radius: 12px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 1.25rem;
}
h2 {
  font-size: 1rem;
  margin-top: 0;
}
form {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.field label {
  font-size: 0.72rem;
  color: #9aa0aa;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.field small {
  font-size: 0.7rem;
  color: #6b7280;
  max-width: 160px;
  line-height: 1.3;
}
input, select {
  background: #0f1115;
  border: 1px solid #262a33;
  color: #e6e6e6;
  padding: 0.5rem;
  border-radius: 6px;
}
button {
  background: #4f8cff;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
}
button.ghost {
  background: transparent;
  border: 1px solid #262a33;
}
button.small {
  padding: 0.3rem 0.7rem;
  font-size: 0.8rem;
  margin-bottom: 0.75rem;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.sub {
  color: #9aa0aa;
  font-size: 0.85rem;
  line-height: 1.5;
  margin-top: 0.5rem;
}
.error {
  color: #ff6b6b;
  font-size: 0.85rem;
}
.result {
  color: #6bffa0;
  font-size: 0.85rem;
}
code {
  background: #0f1115;
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
}
summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
a {
  color: #4f8cff;
}
.scrip-rows {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
}
.scrip-row {
  display: flex;
  gap: 0.5rem;
}
.scrip-row input {
  flex: 1;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: #9aa0aa;
  font-size: 0.85rem;
}
.checkbox input {
  width: auto;
}
.checkbox-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.card-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0.75rem 0 0.4rem;
}
.card-row p {
  margin: 0;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.75rem;
  margin: 1rem 0;
}
.summary-grid > div {
  background: #0f1115;
  border: 1px solid #262a33;
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
}
.summary-grid strong {
  display: block;
  font-size: 1.1rem;
  margin-top: 0.15rem;
}
.pnl-pos {
  color: #6bffa0;
}
.pnl-neg {
  color: #ff6b6b;
}
</style>
