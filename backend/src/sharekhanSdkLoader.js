import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function findJsFiles(dir, matches = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findJsFiles(full, matches);
    } else if (entry.name.endsWith(".js")) {
      matches.push(full);
    }
  }
  return matches;
}

/**
 * The published `sharekhan-api` package (installed straight from GitHub,
 * since it's not on the npm registry) has a broken "main" field in its
 * package.json — it points at a root index.js that doesn't exist; the
 * real code lives somewhere under lib/. Rather than hardcode a guessed
 * filename that might not match every checkout, this walks the actually
 * installed package directory at startup and requires whichever .js file
 * really exports a SharekhanApi constructor.
 */
export function loadSharekhanApi() {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve("sharekhan-api/package.json"));
  } catch (err) {
    throw new Error(
      "sharekhan-api isn't installed in backend/node_modules — run `npm install` " +
        "inside backend/ first. (" + err.message + ")"
    );
  }

  const candidates = findJsFiles(pkgDir);

  for (const file of candidates) {
    let mod;
    try {
      mod = require(file);
    } catch {
      continue; // not every .js file in the package is a standalone requireable module
    }
    const Candidate =
      mod?.SharekhanApi || (typeof mod === "function" ? mod : null);
    if (typeof Candidate === "function") {
      console.log(`[sharekhanSdkLoader] Loaded SharekhanApi from ${file}`);
      return Candidate;
    }
  }

  throw new Error(
    "Could not find a file exporting SharekhanApi inside node_modules/sharekhan-api. " +
      "Run `dir node_modules\\sharekhan-api -Recurse -Name` (from backend/, in " +
      "PowerShell) and share the output so the loader can be adjusted to match " +
      "the real package layout."
  );
}
