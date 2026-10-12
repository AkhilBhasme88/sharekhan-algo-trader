import { Router } from "express";
import "dotenv/config";
import { buildLoginUrl, exchangeRequestToken } from "../sharekhanClient.js";
import { getToken, clearToken } from "../tokenStore.js";

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// Frontend calls this to get the URL it should send the browser to.
router.get("/login-url", (req, res) => {
  console.log("[AUTH] /login-url requested");
  try {
    const url = buildLoginUrl();
    console.log(`[AUTH] Built login URL (redacted): ${url.replace(/api_key=[^&]+/, "api_key=***")}`);
    res.json({ url });
  } catch (err) {
    console.error("[AUTH][FAIL] buildLoginUrl:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sharekhan redirects the browser here after login + OTP succeed.
router.get("/callback", async (req, res) => {
  console.log(`[AUTH] /callback hit — raw query: ${req.originalUrl}`);

  // Express's default query parser treats "+" as a space (form-encoding
  // convention), which silently corrupts Sharekhan's request_token since
  // it contains literal "+" characters. Pull the raw substring from the
  // untouched URL instead so nothing gets mangled before we use it.
  const rawMatch = req.originalUrl.match(/[?&](?:request_token|requestToken)=([^&]*)/);
  const requestToken = rawMatch ? decodeURIComponent(rawMatch[1]) : null;

  if (!requestToken) {
    console.warn("[AUTH][FAIL] No request_token found in callback URL");
    return res.redirect(`${FRONTEND_URL}/login?error=missing_request_token`);
  }

  console.log(`[AUTH] Extracted request_token (length ${requestToken.length}), exchanging…`);
  try {
    await exchangeRequestToken(requestToken);
    console.log("[AUTH][OK] Token exchange succeeded, redirecting to dashboard");
    res.redirect(`${FRONTEND_URL}/dashboard?login=success`);
  } catch (err) {
    console.error("[AUTH][FAIL] Token exchange failed:", err.message);
    res.redirect(`${FRONTEND_URL}/login?error=exchange_failed`);
  }
});

router.get("/status", (req, res) => {
  const token = getToken();
  console.log(`[AUTH] /status check — loggedIn: ${Boolean(token)}`);
  res.json({ loggedIn: Boolean(token), expiresAt: token?.expiresAt ?? null });
});

router.post("/logout", (req, res) => {
  console.log("[AUTH] /logout called");
  clearToken();
  res.json({ ok: true });
});

export default router;
