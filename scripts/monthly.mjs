import { readFileSync } from "node:fs";
import { monthlyCopies } from "../src/monthly.mjs";
import { objectsFromList } from "../src/retention.mjs";

// Prints "source<TAB>dest" for each monthly copy this backup should make: one per part not yet copied this month.
const [list, copiesFile, prefix, month] = process.argv.slice(2);
if (!list || !copiesFile || !prefix || !month) {
  console.error("Usage: node monthly.mjs <list-objects.json> <copies.tsv> <prefix> <YYYYMM>");
  process.exit(2);
}
// An empty folder can come back as no output at all, which means nothing is there yet.
const listed = readFileSync(list, "utf8").trim();
const existing = objectsFromList(listed ? JSON.parse(listed) : {}).map((object) => object.key);
const keys = readFileSync(copiesFile, "utf8")
  .split("\n")
  .map((line) => line.split("\t")[0])
  .filter(Boolean);
for (const copy of monthlyCopies(keys, existing, prefix, month)) {
  process.stdout.write(`${copy.source}\t${copy.dest}\n`);
}
