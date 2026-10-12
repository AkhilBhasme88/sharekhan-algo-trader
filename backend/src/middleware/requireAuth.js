import { getToken } from "../tokenStore.js";

export function requireAuth(req, res, next) {
  const token = getToken();
  if (!token) {
    console.warn(`[MW][FAIL] requireAuth blocked ${req.method} ${req.originalUrl} — not logged in`);
    return res.status(401).json({ error: "Not logged in to Sharekhan." });
  }
  next();
}
