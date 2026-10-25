import { keptMonths, monthlyKeyMonth } from "./monthly.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keys whose LastModified is older than the retention window.
 * Unparseable dates are kept. Prefix folders are kept.
 * With the prefix, monthly copies under <prefix>/monthly/<YYYYMM>/ follow their own rule instead: kept while their
 * month is one of the last twelve, deleted after. A monthly folder that is not a month is kept.
 */
export function keysToDelete(objects, retentionDays, nowMs = Date.now(), prefix = "") {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days < 1) {
    throw new Error("Retention days must be a positive number.");
  }
  const cutoff = nowMs - days * DAY_MS;
  const months = new Set(keptMonths(nowMs));
  const keys = [];
  for (const object of objects) {
    if (!object || typeof object.key !== "string" || object.key.endsWith("/")) continue;
    if (prefix && object.key.startsWith(`${prefix}/monthly/`)) {
      const month = monthlyKeyMonth(object.key, prefix);
      if (month && !months.has(month)) keys.push(object.key);
      continue;
    }
    const modified = Date.parse(object.lastModified);
    if (!Number.isFinite(modified) || modified >= cutoff) continue;
    keys.push(object.key);
  }
  return keys;
}

export function objectsFromList(payload) {
  const contents = payload && Array.isArray(payload.Contents) ? payload.Contents : [];
  return contents
    .filter((item) => item && typeof item.Key === "string")
    .map((item) => ({ key: item.Key, lastModified: item.LastModified ?? "" }));
}
