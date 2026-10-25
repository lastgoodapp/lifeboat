import { readFileSync } from "node:fs";
import { keysToDelete, objectsFromList } from "../src/retention.mjs";

const file = process.argv[2];
const days = process.argv[3];
// The backup prefix, so monthly copies under <prefix>/monthly/ are kept for twelve months, not the nightly window.
const prefix = process.argv[4] ?? "";
if (!file || !days) {
  console.error("Usage: node retention.mjs <list-objects.json> <retention-days> [prefix]");
  process.exit(2);
}
const payload = JSON.parse(readFileSync(file, "utf8"));
for (const key of keysToDelete(objectsFromList(payload), days, Date.now(), prefix)) {
  process.stdout.write(`${key}\n`);
}
