// Bridges a strategy signal to an order INTENT — built in exactly the
// shape placeOrder() in sharekhanClient.js expects (scripCode,
// tradingSymbol, exchange, transactionType: 'B'|'S', confirmed from the
// SDK's own example — see README), so wiring up real execution later is
// literally swapping the console.log/array-push below for
// `await placeOrder(intent)`. Until that's a deliberate future change,
// this module never imports or calls placeOrder() at all — not gated by
// ENABLE_LIVE_TRADING, not gated by anything toggleable from outside
// this file. That's stronger than a config flag: there's no setting
// that turns this into live trading, only a code change.
//
// Paper trades are kept in memory only (cleared on server restart) —
// this is meant for "does my strategy actually fire, and on what,"
// not a durable trading journal. Point a real database at
// getPaperTradeLog()'s callers if you need persistence.

const paperTradeLog = [];

export function getPaperTradeLog() {
  return paperTradeLog;
}

export function clearPaperTradeLog() {
  paperTradeLog.length = 0;
}

/**
 * signal: a resolved trade signal from a strategy module's
 * generateTrades() (see backtest/strategies/*.js) — needs at minimum
 * scripCode, exchange, side ("LONG"/"SHORT"), entryPrice, entryTime.
 * quantity: resolved separately by the caller (position sizing isn't
 * this module's job — see routes/liveSignal.js).
 */
export function dispatchPaperOrder(signal, quantity, { tradingSymbol } = {}) {
  const orderIntent = {
    scripCode: signal.scripCode,
    tradingSymbol: tradingSymbol || signal.tradingSymbol || signal.scripCode,
    exchange: signal.exchange,
    transactionType: signal.side === "LONG" ? "B" : "S",
    quantity,
    price: signal.entryPrice,
  };
  const record = {
    dispatchedAt: new Date().toISOString(),
    mode: "paper", // always — see this file's header comment
    status: "logged-not-sent",
    signalEntryTime: signal.entryTime,
    strategySide: signal.side,
    order: orderIntent,
  };
  console.log("[PAPER-ORDER] Would place:", JSON.stringify(orderIntent));
  paperTradeLog.push(record);
  return record;
}
