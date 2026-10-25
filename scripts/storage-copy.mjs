// A Supabase project's Storage files, read inside the customer's own GitHub Action with the storage login setup made
// (D4): sign in with LIFEBOAT_STORAGE_LOGIN and the project's publishable key, list every bucket and every file, and
// download each to <dir>/<bucket>/<path> for run.sh to encrypt before anything leaves the runner. It only reads, and
// the login's own policies refuse any add, change or delete. The session is refreshed before it runs out, so a long
// copy keeps going. The password and the session tokens are never printed.
// Usage: node storage-copy.mjs <dir>. Prints "<buckets> <files> <bytes>" on success.
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
/** Refresh this long before the session runs out, so no request goes out with a token about to expire. */
const REFRESH_EARLY_MS = 120_000;
const PAGE = 1000;
const DOWNLOADS_AT_ONCE = 4;
export const REF = /^[a-z]{20}$/;

export class StorageCopyError extends Error {}

const LOGIN_REFUSED =
  "Supabase did not accept the storage login in LIFEBOAT_STORAGE_LOGIN. If email sign-in is turned off for this project, that is the likely cause: turn on the Email provider in Supabase (new sign-ups can stay off). Otherwise connect again in LastGood to make a new login.";
const EMAIL_OFF =
  "Supabase refused the storage login because email sign-in is turned off for this project. Turn on the Email provider in Supabase, under Authentication (new sign-ups can stay off), and the next run copies the files.";
const KEY_REFUSED =
  "Supabase did not accept the publishable key in LIFEBOAT_SUPABASE_PUBLISHABLE_KEY. Paste the project's current publishable key into that variable.";

/** The secret is "<email>:<password>", split at the last colon. */
export function parseLogin(value) {
  const text = (value ?? "").trim();
  const at = text.lastIndexOf(":");
  const email = at > 0 ? text.slice(0, at) : "";
  const password = at > 0 ? text.slice(at + 1) : "";
  if (!email.includes("@") || !password) throw new StorageCopyError("LIFEBOAT_STORAGE_LOGIN is not a storage login. Connect again in LastGood to write it.");
  return { email, password };
}

/**
 * A refusal's status and error code. Storage answers some refusals with HTTP 400 and the real status in the body;
 * Supabase Auth gives its reason as error_code whatever the status (422 when email sign-in is off).
 */
async function statusOf(response) {
  let body;
  try {
    body = await response.clone().json();
  } catch {
    return { status: response.status, code: "" };
  }
  const code = typeof body?.error_code === "string" ? body.error_code : typeof body?.error === "string" ? body.error : "";
  if (response.status !== 400) return { status: response.status, code };
  const inner = Number(body?.statusCode);
  return { status: Number.isInteger(inner) && inner >= 400 ? inner : 400, code };
}

function waitFor(response, attempt) {
  const raw = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw * 1000, MAX_WAIT_MS);
  return 1000 * 2 ** (attempt - 1);
}

/**
 * Copies every file in every bucket to `dir`. Returns the counts for the run's report.
 */
export async function copyStorage({
  ref,
  login,
  apikey,
  dir,
  api,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = Date.now,
  pageSize = PAGE,
}) {
  if (!REF.test(ref ?? "")) throw new StorageCopyError("Set supabase-project-ref to the project's 20-letter ref, so the workflow knows whose files to copy.");
  if (!apikey) throw new StorageCopyError("Set LIFEBOAT_SUPABASE_PUBLISHABLE_KEY to the project's publishable key, so the storage login can sign in.");
  if (apikey.startsWith("sb_secret_")) throw new StorageCopyError("LIFEBOAT_SUPABASE_PUBLISHABLE_KEY holds a secret key. Replace it with the publishable key.");
  const { email, password } = parseLogin(login);
  const base = (api || `https://${ref}.supabase.co`).replace(/\/+$/, "");
  const session = { access: "", refresh: "", expiresAt: 0 };

  async function call(url, init, what, { auth = true } = {}) {
    let last = null;
    let renewed = false;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (auth) await fresh();
      const used = session.access;
      const headers = { apikey, "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)", ...(init.headers ?? {}) };
      if (auth) headers.Authorization = `Bearer ${used}`;
      let response;
      try {
        response = await fetchImpl(url, { ...init, headers });
      } catch {
        last = `Supabase could not be reached when reading ${what}.`;
        if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) return response;
      const { status, code } = await statusOf(response);
      await response.text().catch(() => "");
      if ((status === 401 || status === 403) && auth && !renewed) {
        // Storage reports a session that ended sooner than it said as 401 or 403. Renew it once and ask again;
        // a second refusal is a real one.
        renewed = true;
        attempt -= 1;
        await fresh(used);
        continue;
      }
      last = explain(status, code, what);
      if (status < 500 && status !== 429) break;
      if (attempt < ATTEMPTS) await sleep(waitFor(response, attempt));
    }
    throw new StorageCopyError(last ?? `Supabase did not answer when reading ${what}.`);
  }

  async function token(grant, body) {
    const response = await call(
      `${base}/auth/v1/token?grant_type=${grant}`,
      { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) },
      "the storage login",
      { auth: false },
    );
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new StorageCopyError("Supabase sent something other than JSON when the storage login signed in.");
    }
    if (typeof parsed?.access_token !== "string" || typeof parsed?.refresh_token !== "string") {
      throw new StorageCopyError("Supabase did not hand over a session for the storage login.");
    }
    session.access = parsed.access_token;
    session.refresh = parsed.refresh_token;
    const seconds = Number(parsed.expires_in);
    session.expiresAt = now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
  }

  /**
   * Makes sure the session has time left. With `ended`, the token a refused request used: renew unless another
   * download already has. The downloads run side by side, so they share one renewal rather than each spending the
   * refresh token.
   */
  let renewing = null;
  async function fresh(ended = "") {
    if (ended ? session.access !== ended : session.access && now() < session.expiresAt - REFRESH_EARLY_MS) return;
    renewing ??= renew().finally(() => {
      renewing = null;
    });
    await renewing;
  }

  async function renew() {
    if (session.refresh) {
      try {
        await token("refresh_token", { refresh_token: session.refresh });
        return;
      } catch {
        // A refresh token can be revoked or reused; signing in again starts a new session.
      }
    }
    await token("password", { email, password });
  }

  function explain(status, code, what) {
    if (what === "the storage login") {
      if (status === 401 || code === "invalid_api_key" || code === "no_api_key") return KEY_REFUSED;
      if (code === "email_provider_disabled") return EMAIL_OFF;
      if (status === 400 || status === 403) return LOGIN_REFUSED;
    }
    if (status === 401) return KEY_REFUSED;
    if (status === 403) {
      return `Supabase refused to let the storage login read ${what}. Connect again in LastGood to set its policies again. A storage policy that needs two-factor sign-in (aal2) can also cause this.`;
    }
    if (status === 404) return `Supabase found no ${what}. It may have been deleted during the copy; the next run tries again.`;
    if (status === 429) return `Supabase's rate limit stopped the copy of ${what}. The next run tries again.`;
    return `Supabase answered ${status} when reading ${what}.`;
  }

  async function json(url, init, what) {
    const response = await call(url, init, what);
    try {
      return await response.json();
    } catch {
      throw new StorageCopyError(`Supabase sent something other than JSON for ${what}.`);
    }
  }

  await fresh();
  const listed = await json(`${base}/storage/v1/bucket`, { headers: { Accept: "application/json" } }, "the list of buckets");
  if (!Array.isArray(listed)) throw new StorageCopyError("Supabase sent something other than a list for the buckets.");
  const buckets = listed.map((bucket) => (typeof bucket?.id === "string" ? bucket.id : ""));
  for (const bucket of buckets) {
    if (!safeSegment(bucket)) throw new StorageCopyError("Supabase listed a bucket whose name cannot be saved as a folder.");
  }

  const root = path.resolve(dir);
  let files = 0;
  let bytes = 0;
  for (const bucket of buckets) {
    const bucketDir = path.join(root, bucket);
    mkdirSync(bucketDir, { recursive: true });
    const names = await listFiles(bucket);
    let next = 0;
    async function worker() {
      while (next < names.length) {
        const name = names[next];
        next += 1;
        const size = await download(bucket, name, bucketDir);
        bytes += size;
        files += 1;
      }
    }
    await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, names.length) }, worker));
  }
  return { buckets: buckets.length, files, bytes };

  /** Every file name in a bucket, folders walked one level at a time. */
  async function listFiles(bucket) {
    const names = [];
    const folders = [""];
    while (folders.length > 0) {
      const prefix = folders.shift();
      for (let offset = 0; ; offset += pageSize) {
        const page = await json(
          `${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
          {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: "name", order: "asc" } }),
          },
          `the files in ${bucket}`,
        );
        if (!Array.isArray(page)) throw new StorageCopyError(`Supabase sent something other than a list for the files in ${bucket}.`);
        for (const entry of page) {
          const name = typeof entry?.name === "string" ? entry.name : "";
          if (!safeSegment(name)) throw new StorageCopyError(`Supabase listed a file in ${bucket} whose name cannot be saved safely.`);
          // A folder has no id; a file always has one.
          if (entry.id === null || entry.id === undefined) folders.push(`${prefix}${name}/`);
          else names.push(`${prefix}${name}`);
        }
        if (page.length < pageSize) break;
      }
    }
    return names;
  }

  async function download(bucket, name, bucketDir) {
    const file = path.join(bucketDir, ...name.split("/"));
    // safeSegment already refuses "..", so this only guards against a change to it.
    if (!file.startsWith(`${bucketDir}${path.sep}`)) throw new StorageCopyError(`A file in ${bucket} would be saved outside its folder.`);
    mkdirSync(path.dirname(file), { recursive: true });
    const url = `${base}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`;
    let last = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const response = await call(url, { headers: { Accept: "*/*" } }, `a file in ${bucket}`);
      try {
        const body = response.body ?? Readable.toWeb(Readable.from([]));
        await pipeline(Readable.fromWeb(body), createWriteStream(file, { mode: 0o600 }));
        return statSync(file).size;
      } catch {
        last = `The download of a file in ${bucket} was cut off.`;
        if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw new StorageCopyError(last ?? `A file in ${bucket} could not be downloaded.`);
  }
}

/** One path segment that is safe as a file or folder name: not empty, not "." or "..", no slash or NUL. */
export function safeSegment(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 1024 && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  try {
    if (!dir) throw new StorageCopyError("Usage: storage-copy.mjs <dir>");
    const counts = await copyStorage({
      ref: process.env.SUPABASE_PROJECT_REF?.trim(),
      login: process.env.LIFEBOAT_STORAGE_LOGIN,
      apikey: process.env.SUPABASE_PUBLISHABLE_KEY?.trim(),
      api: process.env.SUPABASE_URL,
      dir,
    });
    process.stdout.write(`${counts.buckets} ${counts.files} ${counts.bytes}\n`);
  } catch (error) {
    console.error(error instanceof StorageCopyError ? error.message : "The storage copy failed.");
    process.exit(1);
  }
}
