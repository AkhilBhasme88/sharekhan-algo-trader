// One-off diagnostic: prints every method the installed sharekhan-api SDK
// actually exposes on a constructed instance. Doesn't call the network or
// require a logged-in session — it only needs SHAREKHAN_API_KEY and
// SHAREKHAN_CUSTOMER_ID from backend/.env to construct the client object.
//
// Run this whenever a Sharekhan SDK call throws "... is not a function" —
// it tells you the real name to use instead of guessing again.
//
// Usage (from the backend/ directory):
//   node scripts/inspect-sdk.js

import "dotenv/config";
import { loadSharekhanApi } from "../src/sharekhanSdkLoader.js";

const { SHAREKHAN_API_KEY, SHAREKHAN_CUSTOMER_ID } = process.env;

if (!SHAREKHAN_API_KEY || !SHAREKHAN_CUSTOMER_ID) {
  console.error(
    "SHAREKHAN_API_KEY and/or SHAREKHAN_CUSTOMER_ID are missing from backend/.env — " +
      "the SDK constructor needs both to build an instance, even just for this inspection."
  );
  process.exit(1);
}

const SharekhanApi = loadSharekhanApi();
const client = new SharekhanApi({
  api_key: SHAREKHAN_API_KEY,
  customer_id: SHAREKHAN_CUSTOMER_ID,
});

const own = Object.getOwnPropertyNames(client).filter((k) => typeof client[k] === "function");
const proto = Object.getPrototypeOf(client);
const protoMethods = proto
  ? Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor" && typeof client[k] === "function")
  : [];
const allMethods = [...new Set([...own, ...protoMethods])].sort();

console.log(`\nLoaded SharekhanApi from: ${SharekhanApi.name || "(anonymous class)"}`);
console.log(`\nMethods available on a constructed instance (${allMethods.length} total):\n`);
allMethods.forEach((name) => console.log(`  - ${name}`));

const historicalGuess = allMethods.find((m) => /histor/i.test(m));
const scripGuess = allMethods.find((m) => /(scrip|script).*(master|active)|active.*(scrip|script)/i.test(m));

console.log("\nBest-guess matches:");
console.log(`  historical data candidate : ${historicalGuess || "(none found — search the list above by eye)"}`);
console.log(`  scrip master candidate    : ${scripGuess || "(none found — search the list above by eye)"}`);
console.log(
  "\nIf either candidate looks right, add it to the matching CANDIDATES array " +
    "in backend/src/sharekhanClient.js (HISTORICAL_METHOD_CANDIDATES or " +
    "SCRIP_MASTER_METHOD_CANDIDATES) — put it first in the list so it's tried first.\n"
);
