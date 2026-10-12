// Time helpers for the backtest engine. Everything here assumes NSE/BSE
// trading hours, which run on IST (UTC+5:30) regardless of what timezone
// the backend server itself is running in (a real gotcha: `date.getHours()`
// on a server running in UTC or PST would silently produce the wrong
// session boundaries) — so every function here derives IST wall-clock
// values explicitly rather than relying on the server's local timezone.

const IST_OFFSET_MINUTES = 5.5 * 60;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Accepts a Date, an ISO string, or a unix timestamp in seconds or ms. */
export function parseCandleDate(rawDate) {
  if (rawDate instanceof Date) return rawDate;
  if (typeof rawDate === "number") {
    // Heuristic: 10-digit-ish numbers are unix seconds, 13-digit are ms.
    return new Date(rawDate < 1e12 ? rawDate * 1000 : rawDate);
  }
  return new Date(rawDate);
}

/**
 * Returns { hhmm, dateKey } for a Date in IST wall-clock terms, without
 * depending on the server's local timezone or a timezone database:
 * shifting the UTC instant by the IST offset and reading fields off the
 * shifted instant as if they were UTC gives the correct IST wall-clock
 * values. `dateKey` (YYYY-MM-DD) is the IST calendar date, used to group
 * candles into trading days.
 */
export function toISTParts(date) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
  const hh = shifted.getUTCHours();
  const mm = shifted.getUTCMinutes();
  return {
    hhmm: `${pad2(hh)}:${pad2(mm)}`,
    dateKey: shifted.toISOString().slice(0, 10),
  };
}

/** "09:15" + 15 -> "09:30". Wraps at 24h (not a concern for trading hours). */
export function addMinutesToHHMM(hhmm, minutesToAdd) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (h * 60 + m + minutesToAdd + 24 * 60) % (24 * 60);
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * Annotates each candle with its IST hhmm/dateKey, filters to those
 * falling within [session.start, session.end] (inclusive), and groups
 * the result by trading day. Candles missing a parseable date or a
 * close price are dropped — a backtest can't use them either way.
 */
export function groupCandlesByISTDay(candles, session) {
  const byDay = new Map();
  for (const raw of candles) {
    if (raw.close === null || raw.close === undefined) continue;
    const date = parseCandleDate(raw.date);
    if (Number.isNaN(date.getTime())) continue;
    const { hhmm, dateKey } = toISTParts(date);
    if (hhmm < session.start || hhmm > session.end) continue;
    const annotated = { ...raw, date, hhmm, dateKey };
    if (!byDay.has(dateKey)) byDay.set(dateKey, []);
    byDay.get(dateKey).push(annotated);
  }
  for (const dayCandles of byDay.values()) {
    dayCandles.sort((a, b) => a.date - b.date);
  }
  return byDay;
}

// The three windows originally discussed for spreading trades across the
// day (avoiding the post-open/pre-lunch/pre-close chop in between).
// Not currently wired to a specific strategy — kept here as a documented
// default for whichever strategy wants a multi-session structure instead
// of the single 9:15-10:15 opening-range window used by default below.
export const THREE_SESSION_WINDOWS = [
  { label: "morning", start: "09:00", end: "10:30" },
  { label: "midday", start: "11:00", end: "13:00" },
  { label: "afternoon", start: "14:00", end: "15:30" },
];

export const DEFAULT_ORB_SESSION = { start: "09:15", end: "10:15" };
