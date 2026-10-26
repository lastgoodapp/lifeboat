// Edge Functions source and the project's Supabase settings, read through the Management API with the
// customer's scoped token, as files in one folder. Only GET requests, and SQL run as Supabase's read-only user.
// The token goes in a header and is never printed. Secrets in the auth settings are blanked before the file is written.
// Usage: node supabase-setup.mjs <folder>. Prints "<functions> <cron jobs> <database webhooks> <Vault secret names>" on success.
// node supabase-setup.mjs --check <folder> reads a folder this script wrote back, as the test restore does, and prints the same counts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ATTEMPTS = 3;
/**
 * How long one call may take, its body included: two minutes, since an Edge Function's files can run to a few
 * megabytes. Without it a call Supabase never answers waits as long as the job may run, on the repository's Actions
 * minutes; with it the call is tried again like a dropped connection.
 */
export const CALL_TIMEOUT_MS = 120_000;
/** Supabase's rate limit resets each minute. A longer wait than that means something else is wrong. */
const MAX_WAIT_MS = 60_000;
export const PROJECT_REF = /^[a-z]{20}$/;
const SLUG = /^[A-Za-z0-9_-]{1,128}$/;
/** Scoped tokens, limited to the projects and permissions picked when they were made, start with this. */
export const SCOPED_PREFIX = "sbp_fc";

export class SetupError extends Error {}

/**
 * The settings files, and the Read permission the scoped token needs for each. The test restore requires every one of
 * them (checkSetup), so a file added here must be skipped for copies made before it, or every older copy fails its
 * test restore until it ages out. setup.test.mjs pins this list so the change can't happen unnoticed.
 */
export const SETTINGS = [
  { file: "auth-config.json", path: "config/auth", what: "the auth settings", permission: "Auth Config" },
  { file: "auth-third-party.json", path: "config/auth/third-party-auth", what: "the third-party auth settings", permission: "Auth Config" },
  { file: "storage-config.json", path: "config/storage", what: "the storage settings", permission: "Storage Config" },
  { file: "buckets.json", path: "storage/buckets", what: "the bucket settings", permission: "Storage" },
];

/**
 * Auth settings that hold a secret: provider client secrets, the SMTP password, SMS provider keys, hook secrets. The
 * rebuild (cli/lib/rebuild-setup.mjs) never sends one back and lists them for the customer to set by hand.
 */
export const SECRET_FIELD = /(?:_secret|_secrets|_pass|_auth_token|_api_key|_access_key|_api_secret|_private_key)$/;
/** A name that could hold a secret. One that is not a known setting below is treated as a secret. */
export const SOUNDS_SECRET = /secret|pass|token|key|credential|private|cert/i;
/** Auth settings whose names sound like a secret but hold none, read one by one from Supabase's spec. */
export const NOT_SECRET = new Set([
  "external_keycloak_client_id",
  "external_keycloak_email_optional",
  "external_keycloak_enabled",
  "external_keycloak_url",
  "hook_custom_access_token_enabled",
  "hook_custom_access_token_uri",
  "hook_password_verification_attempt_enabled",
  "hook_password_verification_attempt_uri",
  "mailer_notifications_password_changed_enabled",
  "mailer_subjects_password_changed_notification",
  "mailer_templates_password_changed_notification_content",
  "passkey_enabled",
  "password_hibp_enabled",
  "password_min_length",
  "password_required_characters",
  "rate_limit_token_refresh",
  "refresh_token_rotation_enabled",
  "security_refresh_token_reuse_interval",
  "security_update_password_require_current_password",
  "security_update_password_require_reauthentication",
]);
export const REDACTED = "<redacted>";

/**
 * Whether an auth setting is kept out of the copy: a known secret, or a name that sounds like one and is not a known
 * setting, so a secret Supabase adds later is left out before anyone has sorted it.
 */
export function secretAuthField(field) {
  return SECRET_FIELD.test(field) || (SOUNDS_SECRET.test(field) && !NOT_SECRET.has(field));
}

/**
 * The auth settings as the copy keeps them: every secret that has a value becomes "<redacted>", so no provider secret,
 * SMTP password or hook secret reaches the copy, hashed or otherwise. An empty one stays empty, so the rebuild can tell
 * which secrets there are to set again.
 */
export function redactAuthConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new SetupError("Supabase sent something other than settings for the auth settings.");
  }
  return Object.fromEntries(
    Object.entries(config).map(([field, value]) => [field, secretAuthField(field) && value !== null && value !== undefined && value !== "" ? REDACTED : value]),
  );
}

/** Which optional pieces the database has. The read-only query endpoint needs every name schema-qualified. */
export const PRESENT_SQL = "select pg_catalog.to_regclass('cron.job') is not null as cron, pg_catalog.to_regclass('vault.secrets') is not null as vault";

export const QUERIES = {
  cronJobs: "select jobid, jobname, schedule, command, database, username, active from cron.job order by jobid",
  // Database webhooks are triggers that call supabase_functions.http_request.
  databaseWebhooks: [
    "select n.nspname as schema, c.relname as table, t.tgname as trigger, pg_catalog.pg_get_triggerdef(t.oid) as definition",
    "from pg_catalog.pg_trigger t",
    "join pg_catalog.pg_class c on c.oid = t.tgrelid",
    "join pg_catalog.pg_namespace n on n.oid = c.relnamespace",
    "join pg_catalog.pg_proc p on p.oid = t.tgfoid",
    "join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace",
    "where not t.tgisinternal and pn.nspname = 'supabase_functions' and p.proname = 'http_request'",
    "order by 1, 2, 3",
  ].join(" "),
  // Names only. The secret column is never read.
  vaultSecretNames: "select id, name, description, created_at, updated_at from vault.secrets order by name",
};

function explain(status, what, permission) {
  if (status === 401) {
    return "Supabase did not accept LIFEBOAT_SUPABASE_TOKEN. It may have expired: make a new scoped token and replace the secret.";
  }
  if (status === 403) return `LIFEBOAT_SUPABASE_TOKEN cannot read ${what}. Give the token ${permission}: Read, for this project only.`;
  if (status === 429) return `Supabase's rate limit stopped the copy of ${what}. The next run tries again.`;
  return `Supabase answered ${status} when reading ${what}.`;
}

/** How long Supabase asks us to wait, from Retry-After or the rate limit's reset, in milliseconds. */
function waitFor(response, attempt) {
  for (const name of ["retry-after", "x-ratelimit-reset"]) {
    const seconds = Number(response.headers.get(name));
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  }
  return 1000 * 2 ** (attempt - 1);
}

async function call(url, { token, fetchImpl, sleep, what, permission, accept = "application/json", method = "GET", body }) {
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      last = `Supabase could not be reached when reading ${what}.`;
      if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) return response;
    last = explain(response.status, what, permission);
    if (response.status < 500 && response.status !== 429) break;
    if (attempt < ATTEMPTS) await sleep(waitFor(response, attempt));
  }
  throw new SetupError(last ?? `Supabase did not answer when reading ${what}.`);
}

async function json(response, what) {
  try {
    return await response.json();
  } catch {
    throw new SetupError(`Supabase sent something other than JSON for ${what}.`);
  }
}

/** One Content-Disposition parameter, quoted or not. */
export function dispositionParam(value, name) {
  const escaped = name.replace(/[*]/g, "\\*");
  const match = (value ?? "").match(new RegExp(`(?:^|;)\\s*${escaped}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`, "i"));
  if (!match) return undefined;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2].trim();
}

/** filename*=UTF-8''... as RFC 5987 writes it. */
function decodeExtended(value) {
  const match = value.match(/^([^']*)'[^']*'(.*)$/);
  if (!match || !/^utf-8$/i.test(match[1])) throw new SetupError("Supabase sent a file name this copy cannot read.");
  try {
    return decodeURIComponent(match[2]);
  } catch {
    throw new SetupError("Supabase sent a file name this copy cannot read.");
  }
}

/** The parts of a multipart/form-data body, each with its lower-cased headers and its bytes. */
export function parseMultipart(body, boundary) {
  const opening = Buffer.from(`--${boundary}`);
  const between = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
  let start = body.indexOf(opening);
  if (start < 0) throw new SetupError("Supabase's function source is missing its opening boundary.");
  for (;;) {
    let cursor = start + opening.length;
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) throw new SetupError("Supabase's function source has a malformed boundary.");
    cursor += 2;
    const headerEnd = body.indexOf("\r\n\r\n", cursor);
    if (headerEnd < 0) throw new SetupError("A part of Supabase's function source has no end to its headers.");
    const headers = {};
    for (const line of body.subarray(cursor, headerEnd).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const next = body.indexOf(between, headerEnd + 4);
    if (next < 0) throw new SetupError("Supabase's function source is missing its closing boundary.");
    parts.push({ headers, body: body.subarray(headerEnd + 4, next) });
    start = next + 2;
  }
  return parts;
}

/** The file's path inside the function, from Supabase's own header or the part's file name. Empty for a form field. */
function partPath(headers) {
  if (headers["supabase-path"]) return headers["supabase-path"];
  const disposition = headers["content-disposition"] ?? "";
  const extended = dispositionParam(disposition, "filename*");
  if (extended !== undefined) return decodeExtended(extended);
  return dispositionParam(disposition, "filename") ?? "";
}

/** A relative path inside the function's folder, or null for one that would land outside it. */
export function safePath(raw) {
  let value = String(raw ?? "");
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value);
    } catch {
      return null;
    }
  }
  value = value.replaceAll("\\", "/").replace(/^[A-Za-z]:\//, "/");
  if (value.includes("\0")) return null;
  const normal = path.posix.normalize(value.replace(/^\/+/, ""));
  if (!normal || normal === "." || normal === ".." || normal.startsWith("../")) return null;
  return normal;
}

/** Writes one function's source into its own folder: the files as Supabase sent them, or the bundle when it sends one. */
async function copyFunction(base, fn, dir, deps) {
  const slug = fn?.slug;
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new SetupError("Supabase listed an Edge Function with a name this copy cannot use as a folder.");
  const what = `the source of the ${slug} function`;
  const response = await call(`${base}/functions/${slug}/body`, { ...deps, what, permission: "Edge Functions", accept: "multipart/form-data" });
  const contentType = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new SetupError(`Supabase sent an empty body for ${what}.`);
  const fnDir = path.join(dir, "functions", slug);
  mkdirSync(fnDir, { recursive: true });
  const entrypoint = typeof fn.entrypoint_path === "string" ? fn.entrypoint_path : null;
  if (!/^multipart\//i.test(contentType)) {
    // A bundle (eszip), kept as it came. The restore unpacks it with Supabase's edge runtime.
    writeFileSync(path.join(fnDir, "body.eszip"), bytes);
    writeFileSync(path.join(fnDir, "source.json"), JSON.stringify({ slug, format: "eszip", entrypoint_path: entrypoint, bytes: bytes.length }));
    return;
  }
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) throw new SetupError(`Supabase sent ${what} without a multipart boundary.`);
  let metadata = null;
  const files = [];
  const seen = new Set();
  for (const part of parseMultipart(bytes, boundary)) {
    const original = partPath(part.headers);
    if (!original) {
      if (dispositionParam(part.headers["content-disposition"], "name") === "metadata") {
        try {
          metadata = JSON.parse(part.body.toString("utf8"));
        } catch {
          throw new SetupError(`Supabase sent unreadable details with ${what}.`);
        }
      }
      continue;
    }
    const safe = safePath(original);
    if (!safe) throw new SetupError(`${what} names a file outside its folder, so it was not copied.`);
    if (seen.has(safe)) throw new SetupError(`${what} names the same file twice.`);
    seen.add(safe);
    const target = path.join(fnDir, "files", ...safe.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, part.body);
    files.push({ path: original, saved: `files/${safe}`, bytes: part.body.length });
  }
  if (files.length === 0) throw new SetupError(`Supabase sent no files for ${what}.`);
  const fromMetadata = metadata?.deno2_entrypoint_path || metadata?.entrypoint_path;
  writeFileSync(
    path.join(fnDir, "source.json"),
    JSON.stringify({ slug, format: "files", entrypoint_path: typeof fromMetadata === "string" ? fromMetadata : entrypoint, metadata, files }),
  );
}

async function readOnlyQuery(base, sql, what, deps) {
  const response = await call(`${base}/database/query/read-only`, {
    ...deps,
    what,
    permission: "Database",
    method: "POST",
    body: JSON.stringify({ query: sql }),
  });
  const rows = await json(response, what);
  if (!Array.isArray(rows)) throw new SetupError(`Supabase sent something other than rows for ${what}.`);
  return rows;
}

/**
 * Writes the Edge Functions and the settings into `dir`. Returns the counts for the run's report.
 * `note` receives lines for the job log, such as a warning about a token that is not scoped.
 */
export async function exportSetup({ api, ref, token, dir, fetchImpl = fetch, sleep = defaultSleep, note = () => {} }) {
  if (!PROJECT_REF.test(ref ?? "")) throw new SetupError("The Supabase project ref must be 20 lowercase letters.");
  if (!token) throw new SetupError("Set LIFEBOAT_SUPABASE_TOKEN to copy the Edge Functions and Supabase settings.");
  if (!token.startsWith(SCOPED_PREFIX)) {
    note(
      "::warning::LIFEBOAT_SUPABASE_TOKEN is not a scoped token, so it can change your Supabase projects. Replace it with a scoped token for this project with only Read permissions: Edge Functions, Auth Config, Storage, Storage Config and Database.",
    );
  }
  const base = `${(api || "https://api.supabase.com").replace(/\/+$/, "")}/v1/projects/${ref}`;
  const deps = { token, fetchImpl, sleep };
  mkdirSync(dir, { recursive: true });

  const listWhat = "the list of Edge Functions";
  const functions = await json(await call(`${base}/functions`, { ...deps, what: listWhat, permission: "Edge Functions" }), listWhat);
  if (!Array.isArray(functions)) throw new SetupError(`Supabase sent something other than a list for ${listWhat}.`);
  writeFileSync(path.join(dir, "functions.json"), JSON.stringify(functions));
  for (const fn of functions) await copyFunction(base, fn, dir, deps);

  for (const setting of SETTINGS) {
    const body = await json(await call(`${base}/${setting.path}`, { ...deps, what: setting.what, permission: setting.permission }), setting.what);
    writeFileSync(path.join(dir, setting.file), JSON.stringify(setting.file === "auth-config.json" ? redactAuthConfig(body) : body));
  }

  const [present] = await readOnlyQuery(base, PRESENT_SQL, "which database extras are installed", deps);
  const cronJobs = present?.cron ? await readOnlyQuery(base, QUERIES.cronJobs, "the cron jobs", deps) : [];
  const webhooks = await readOnlyQuery(base, QUERIES.databaseWebhooks, "the database webhooks", deps);
  const vault = present?.vault ? await readOnlyQuery(base, QUERIES.vaultSecretNames, "the Vault secret names", deps) : [];
  writeFileSync(path.join(dir, "cron-jobs.json"), JSON.stringify(cronJobs));
  writeFileSync(path.join(dir, "database-webhooks.json"), JSON.stringify(webhooks));
  writeFileSync(path.join(dir, "vault-secret-names.json"), JSON.stringify(vault));

  return { functions: functions.length, cronJobs: cronJobs.length, databaseWebhooks: webhooks.length, vaultSecretNames: vault.length };
}

/**
 * Reads a setup copy's folder back, as the test restore does: the function list, every function's saved source at the
 * size it was saved, and every settings file. Returns the same counts as exportSetup, or throws naming what did not
 * read back.
 */
export function checkSetup(dir) {
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch {
      throw new SetupError(`${file} in the Supabase setup copy did not read back.`);
    }
  };
  const list = (file) => {
    const value = read(file);
    if (!Array.isArray(value)) throw new SetupError(`${file} in the Supabase setup copy is not a list.`);
    return value;
  };
  const functions = list("functions.json");
  for (const fn of functions) checkFunction(dir, fn);
  for (const setting of SETTINGS) {
    const value = read(setting.file);
    if (value === null || typeof value !== "object") throw new SetupError(`${setting.file} in the Supabase setup copy is empty.`);
  }
  return {
    functions: functions.length,
    cronJobs: list("cron-jobs.json").length,
    databaseWebhooks: list("database-webhooks.json").length,
    vaultSecretNames: list("vault-secret-names.json").length,
  };
}

/** One function's folder: the bundle, or every file it lists, each read back at the size it was saved. */
function checkFunction(dir, fn) {
  const slug = fn?.slug;
  if (typeof slug !== "string" || !SLUG.test(slug)) throw new SetupError("functions.json in the Supabase setup copy lists a function with no usable name.");
  const fnDir = path.join(dir, "functions", slug);
  let source;
  try {
    source = JSON.parse(readFileSync(path.join(fnDir, "source.json"), "utf8"));
  } catch {
    throw new SetupError(`The source of the ${slug} function did not read back from the Supabase setup copy.`);
  }
  const readBack = (relative, bytes) => {
    let size = -1;
    try {
      size = readFileSync(path.join(fnDir, ...relative.split("/"))).length;
    } catch {
      // Missing or unreadable: the size check below names it.
    }
    if (!Number.isSafeInteger(bytes) || size !== bytes) {
      throw new SetupError(`${relative} in the ${slug} function did not read back at the size it was saved.`);
    }
  };
  if (source?.format === "eszip") {
    readBack("body.eszip", source.bytes);
    return;
  }
  if (source?.format !== "files" || !Array.isArray(source.files) || source.files.length === 0) {
    throw new SetupError(`The ${slug} function in the Supabase setup copy lists no source files.`);
  }
  for (const file of source.files) {
    const saved = typeof file?.saved === "string" && file.saved.startsWith("files/") ? safePath(file.saved) : null;
    if (!saved || saved !== file.saved) throw new SetupError(`The ${slug} function in the Supabase setup copy names a file outside its folder.`);
    readBack(saved, file.bytes);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const checking = process.argv[2] === "--check";
  const dir = checking ? process.argv[3] : process.argv[2];
  try {
    if (!dir) throw new SetupError("Usage: supabase-setup.mjs [--check] <folder>");
    const counts = checking
      ? checkSetup(dir)
      : await exportSetup({
          api: process.env.SUPABASE_API_URL,
          ref: process.env.SUPABASE_PROJECT_REF,
          token: process.env.LIFEBOAT_SUPABASE_TOKEN?.trim(),
          dir,
          note: (line) => console.error(line),
        });
    process.stdout.write(`${counts.functions} ${counts.cronJobs} ${counts.databaseWebhooks} ${counts.vaultSecretNames}\n`);
  } catch (error) {
    console.error(error instanceof SetupError ? error.message : "The Supabase setup copy failed.");
    process.exit(1);
  }
}
