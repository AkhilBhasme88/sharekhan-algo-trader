import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import orderRoutes from "./routes/orders.js";
import marketRoutes from "./routes/market.js";
import backtestRoutes from "./routes/backtest.js";
import indexBacktestRoutes from "./routes/indexBacktest.js";
import liveSignalRoutes from "./routes/liveSignal.js";

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// [REQ] every incoming request, so a failure's origin is visible immediately
// in the log without needing to add prints inside each route by hand.
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[REQ] --> ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Date.now() - start;
    const tag = res.statusCode >= 400 ? "[REQ][FAIL]" : "[REQ][OK]";
    console.log(`${tag} <-- ${req.method} ${req.originalUrl} ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/backtest", backtestRoutes);
app.use("/api/index-backtest", indexBacktestRoutes);
app.use("/api/live-signal", liveSignalRoutes);

// Alias in case your Sharekhan app is registered with a callback URL of
// just /callback instead of /api/auth/callback — forwards to the real
// handler either way so a portal-side mismatch doesn't break login.
app.get("/callback", (req, res) => {
  console.log("[AUTH] /callback alias hit, forwarding to /api/auth/callback");
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/api/auth/callback?${qs}`);
});

// [REQ] catch-all — anything that reaches here matched no route at all,
// which is the "Cannot GET /x" case. Logging it beats a silent 404.
app.use((req, res) => {
  console.warn(`[REQ][404] No route matched ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

app.listen(PORT, () => {
  console.log(`[BOOT] Sharekhan backend running at http://localhost:${PORT}`);
  console.log(`[BOOT] Expecting frontend at ${FRONTEND_URL}`);
  console.log(
    `[BOOT] Env check — API_KEY: ${process.env.SHAREKHAN_API_KEY ? "set" : "MISSING"}, ` +
      `API_SECRET: ${process.env.SHAREKHAN_API_SECRET ? "set" : "MISSING"}, ` +
      `CUSTOMER_ID: ${process.env.SHAREKHAN_CUSTOMER_ID ? "set" : "MISSING"}, ` +
      `REDIRECT_URL: ${process.env.SHAREKHAN_REDIRECT_URL || "MISSING"}`
  );
});
