// Tracks how much of the account's total capital is currently tied up in
// open positions, so the backtest engine can enforce both limits the
// user described: a hard per-trade cap, and never exceeding total
// capital across however many positions are open at once (this is what
// makes "multiple trades at a time" mean something concrete — e.g.
// ₹1,00,000 total / ₹20,000 per trade = up to 5 concurrent positions,
// fewer if some are larger or capital is already partly deployed).

export const DEFAULT_CAPITAL = 100000;
export const DEFAULT_MAX_PER_TRADE = 20000;

export function createCapitalTracker(totalCapital = DEFAULT_CAPITAL, maxPerTrade = DEFAULT_MAX_PER_TRADE) {
  let deployed = 0;
  let peakDeployed = 0;

  return {
    availableCapital: () => totalCapital - deployed,
    maxConcurrentPositions: () => Math.floor(totalCapital / maxPerTrade),
    peakDeployed: () => peakDeployed,

    /** Whole-share quantity affordable within maxPerTrade AND whatever capital remains. */
    sizePosition(price) {
      if (!price || price <= 0) return 0;
      const budget = Math.min(maxPerTrade, totalCapital - deployed);
      return Math.floor(budget / price);
    },

    openPosition(amount) {
      deployed += amount;
      if (deployed > peakDeployed) peakDeployed = deployed;
    },

    closePosition(amount) {
      deployed = Math.max(0, deployed - amount);
    },
  };
}

/**
 * For indices (NIFTY/BANKNIFTY): a single index "point" of exposure is
 * worth thousands of rupees, so sizing a position the same way as a
 * stock (budget / price = whole shares) doesn't work — ₹20,000 doesn't
 * even buy one "unit" of Nifty at ~24,000. Real index exposure is via
 * futures with a fixed lot size (which changes periodically by
 * exchange circular — NIFTY and BANKNIFTY don't even share the same
 * lot size as each other, let alone stay fixed over time) and
 * margin/leverage this backtest approximates rather than models
 * precisely. Rather than fake more precision than that, this tracker
 * takes a quantity-per-trade — either one number (same quantity for
 * every scrip) or a map keyed by scripCode (needed the moment you
 * backtest NIFTY and BANKNIFTY together, since their lot sizes
 * differ) — and a fixed cap on how many positions can be open at
 * once. Same interface shape as createCapitalTracker so the engine
 * doesn't need to know which one it's using, but capacity is decided
 * by position COUNT here, not by rupee budget. `capital` is accepted
 * only so the engine can still report a return-on-capital percentage
 * for context, not because it constrains sizing.
 */
export function createFixedQuantityTracker(quantityConfig, maxConcurrentPositions) {
  let openCount = 0;
  let deployedNotional = 0;
  let peakNotional = 0;

  function resolveQuantity(scripCode) {
    if (typeof quantityConfig === "number") return quantityConfig;
    return quantityConfig?.[scripCode] ?? 0;
  }

  return {
    maxConcurrentPositions: () => maxConcurrentPositions,
    peakDeployed: () => peakNotional,

    sizePosition(price, scripCode) {
      if (openCount >= maxConcurrentPositions) return 0;
      return resolveQuantity(scripCode);
    },

    openPosition(notionalAmount) {
      openCount += 1;
      deployedNotional += notionalAmount;
      if (deployedNotional > peakNotional) peakNotional = deployedNotional;
    },

    closePosition(notionalAmount) {
      openCount = Math.max(0, openCount - 1);
      deployedNotional = Math.max(0, deployedNotional - notionalAmount);
    },
  };
}
