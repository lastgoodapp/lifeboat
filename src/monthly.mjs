// Monthly copies (B14, D9). The first good backup of each UTC month is copied, inside the bucket, to
// <prefix>/monthly/<YYYYMM>/<part>/<name>, and retention keeps those copies for twelve months instead of thirty days.

export const MONTHLY_FOLDER = "monthly";
export const MONTHS_KEPT = 12;

const MONTH = /^\d{6}$/;

/** The UTC month of a run stamp such as 20261018T161700Z, as 202610. */
export function monthOf(stamp) {
  const month = String(stamp ?? "").slice(0, 6);
  return MONTH.test(month) ? month : null;
}

/**
 * The copies to make this month: one per part that has no copy under <prefix>/monthly/<month>/<part>/ yet. A part
 * a failed copy left out is filled in by the next good backup that month. Keys outside <prefix>/<part>/ are ignored.
 */
export function monthlyCopies(copyKeys, existingKeys, prefix, month) {
  if (!MONTH.test(String(month)) || !prefix) return [];
  const base = `${prefix}/${MONTHLY_FOLDER}/${month}/`;
  const done = new Set();
  for (const key of existingKeys) {
    if (typeof key !== "string" || !key.startsWith(base)) continue;
    const part = key.slice(base.length).split("/")[0];
    if (part) done.add(part);
  }
  const copies = [];
  for (const source of copyKeys) {
    if (typeof source !== "string" || !source.startsWith(`${prefix}/`)) continue;
    const [part, name, ...rest] = source.slice(prefix.length + 1).split("/");
    if (!part || !name || rest.length > 0 || part === MONTHLY_FOLDER || done.has(part)) continue;
    done.add(part);
    copies.push({ source, dest: `${base}${part}/${name}` });
  }
  return copies;
}

/**
 * The months whose monthly copies are kept: this month and the eleven before it, as YYYYMM. A copy from an older
 * month is deleted by retention, whether monthly copies are on or off, so switching them off lets them age out.
 */
export function keptMonths(nowMs = Date.now(), monthsKept = MONTHS_KEPT) {
  const now = new Date(nowMs);
  const months = [];
  for (let back = 0; back < monthsKept; back += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.push(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

/** The YYYYMM folder of a monthly copy's key, or null when the key is not a monthly copy. */
export function monthlyKeyMonth(key, prefix) {
  const base = `${prefix}/${MONTHLY_FOLDER}/`;
  if (typeof key !== "string" || !prefix || !key.startsWith(base)) return null;
  const month = key.slice(base.length).split("/")[0];
  return MONTH.test(month) ? month : null;
}
