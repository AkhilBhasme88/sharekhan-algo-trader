import { Router } from "express";
import "dotenv/config";
import { requireAuth } from "../middleware/requireAuth.js";
import { getHoldings, getFundsDetails, placeOrder } from "../sharekhanClient.js";

const router = Router();
router.use(requireAuth);

router.get("/holdings", async (req, res) => {
  console.log("[ORDERS] /holdings requested");
  try {
    const data = await getHoldings();
    console.log("[ORDERS][OK] /holdings returning data");
    res.json(data);
  } catch (err) {
    console.error("[ORDERS][FAIL] /holdings:", err.message);
    res.status(502).json({ error: err.message });
  }
});

router.get("/funds/:exchange?", async (req, res) => {
  const exchange = req.params.exchange || "NC";
  console.log(`[ORDERS] /funds exchange=${exchange}`);
  try {
    const data = await getFundsDetails(exchange);
    console.log("[ORDERS][OK] /funds returning data");
    res.json(data);
  } catch (err) {
    console.error("[ORDERS][FAIL] /funds:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Backtest-only phase: refuse this before it ever reaches placeOrder() /
// the Sharekhan SDK / the network. placeOrder() itself carries the same
// check (see assertLiveTradingEnabled in sharekhanClient.js) — duplicated
// on purpose so a live order can't slip through if this route is ever
// called from somewhere other than this handler.
router.post("/place", async (req, res) => {
  console.log("[ORDERS] /place requested:", JSON.stringify(req.body));
  if (process.env.ENABLE_LIVE_TRADING !== "true") {
    console.warn('[ORDERS][BLOCKED] /place refused — ENABLE_LIVE_TRADING is not "true" (backtest-only mode)');
    return res.status(403).json({
      error:
        "Live order placement is disabled — this app is running in backtest-only mode. " +
        "Set ENABLE_LIVE_TRADING=true in backend/.env and restart the backend if you " +
        "actually intend to place a real order.",
    });
  }
  try {
    const data = await placeOrder(req.body);
    console.log("[ORDERS][OK] /place returning data");
    res.json(data);
  } catch (err) {
    console.error("[ORDERS][FAIL] /place:", err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
