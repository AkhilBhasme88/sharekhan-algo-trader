import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Simple local-file token store. This app is meant to run only on your
// own laptop for your own account, so a plaintext JSON file is fine here —
// do not reuse this pattern for anything multi-user or internet-facing.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "..", "data", "token.json");

function read() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function write(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

export function saveToken({ accessToken, expiresAt }) {
  write({ accessToken, expiresAt });
}

export function getToken() {
  const data = read();
  if (!data) return null;
  if (data.expiresAt && Date.now() > data.expiresAt) return null;
  return data;
}

export function clearToken() {
  try {
    fs.rmSync(STORE_PATH, { force: true });
  } catch {
    // ignore
  }
}
