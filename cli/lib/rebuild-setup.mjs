import { isDeepStrictEqual } from "node:util";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { checkSetup, PROJECT_REF, SECRET_FIELD, secretAuthField, SetupError } from "./lifeboat/supabase-setup.mjs";
import { clean } from "./rebuild-list.mjs";
import { checkArchive, counted, run, StepError } from "./rebuild.mjs";

/**
 * Edge Functions and Supabase settings back into a new project (R4), from the setup copy (B7), on the customer's own
 * computer. It talks to the Management API with the customer's access token from LASTGOOD_SUPABASE_TOKEN, which never
 * leaves this computer and never appears in a message.
 *
 * A function already in the new project is kept and not deployed again, so a rerun carries on and a function made by
 * hand is never replaced. Only the settings that differ from the new project's are sent. A setting that holds a secret
 * is never sent: the backup blanks it in the copy as "<redacted>", and sending that would break sign-in without a
 * word. Those, the functions' secrets, the cron jobs and the API keys are listed for the customer instead.
 */

const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
const DEFAULT_API = "https://api.supabase.com";

/** Auth settings that hold a secret, the same rule the backup uses to blank them in the copy. */
export { SECRET_FIELD };
/** Auth settings Supabase reports but does not take back. */
const READ_ONLY_AUTH = new Set(["custom_oauth_max_providers", "nimbus_oauth_email_optional", "saml_allow_encrypted_assertions"]);
/** The settings that say where the app lives, printed as applied so a customer on a new domain sees what to change. */
const ADDRESS_FIELDS = ["site_url", "uri_allow_list"];
/** The storage features the Management API takes back. */
const STORAGE_FEATURES = ["imageTransformation", "s3Protocol", "purgeCache", "icebergCatalog", "vectorBuckets"];

/** A value Supabase sent masked, such as "********". */
export function looksMasked(value) {
  return typeof value === "string" && (/\*{3,}/.test(value) || /^<?redacted>?$/i.test(value));
}

/**
 * Which auth settings to send: those that differ from the new project's, leaving out secrets and masked values, which
 * are returned by name for the customer to set by hand (only when the copy has a value for them).
 */
export function authChanges(copy, current) {
  const change = {};
  const byHand = [];
  for (const [field, value] of Object.entries(copy ?? {})) {
    if (READ_ONLY_AUTH.has(field)) continue;
    const empty = value === null || value === undefined || value === "";
    if (secretAuthField(field) || looksMasked(value)) {
      if (!empty) byHand.push(field);
      continue;
    }
    const now = current?.[field];
    if (empty && (now === null || now === undefined || now === "")) continue;
    if (!isDeepStrictEqual(value, now)) change[field] = value;
  }
  return { change, byHand: byHand.sort() };
}

/** Which storage settings to send: the file size limit and the features that differ, in the shape the API takes. */
export function storageChanges(copy, current) {
  const change = {};
  if (Number.isSafeInteger(copy?.fileSizeLimit) && copy.fileSizeLimit !== current?.fileSizeLimit) change.fileSizeLimit = copy.fileSizeLimit;
  for (const name of STORAGE_FEATURES) {
    const wanted = copy?.features?.[name];
    if (wanted && typeof wanted === "object" && !isDeepStrictEqual(wanted, current?.features?.[name])) {
      change.features = { ...change.features, [name]: wanted };
    }
  }
  return change;
}

/** Secret names a function's source reads, other than the ones Supabase sets for every function. */
export function envNames(text) {
  const names = new Set();
  for (const match of String(text).matchAll(/Deno\.env\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)|process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1] ?? match[2];
    if (!/^(SUPABASE_|SB_|DENO_)/.test(name)) names.add(name);
  }
  return names;
}

/** Other Supabase projects a piece of text calls, by ref: a cron job or webhook that still points at the old project. */
export function otherRefs(text, ref) {
  const refs = new Set();
  for (const match of String(text).matchAll(/\b([a-z]{20})\.supabase\.(?:co|in)\b/g)) if (match[1] !== ref) refs.add(match[1]);
  return [...refs].sort();
}

/**
 * Auth hooks that call one of the old project's Edge Functions, pointed at the new project instead, but only for a
 * function this run deployed there, so a hook never ends up calling a function someone else made. A hook already
 * pointed at the new project by an earlier run is left as the new project has it. Returns the settings to compare and
 * the hooks changed, each as `field (old ref to new ref)`.
 */
export function rewriteHooks(copy, current, ref, deployed) {
  const auth = { ...copy };
  const rewritten = [];
  for (const [field, value] of Object.entries(copy ?? {})) {
    if (!/^hook_[a-z_]+_uri$/.test(field) || typeof value !== "string") continue;
    const match = /^https:\/\/([a-z]{20})\.supabase\.co\/functions\/v1\/([A-Za-z0-9_-]+)([/?#].*)?$/.exec(value);
    if (!match || match[1] === ref) continue;
    const target = `https://${ref}.supabase.co/functions/v1/${match[2]}${match[3] ?? ""}`;
    if (deployed.includes(match[2])) {
      auth[field] = target;
      rewritten.push(`${field} (${match[1]} to ${ref})`);
    } else if (current?.[field] === target) {
      auth[field] = target;
    }
  }
  return { auth, rewritten: rewritten.sort() };
}

/** The access token from LASTGOOD_SUPABASE_TOKEN, refused when it is plainly another kind of key. */
export function checkToken(value) {
  const token = String(value ?? "").trim();
  if (!token) {
    throw new StepError(
      "Set LASTGOOD_SUPABASE_TOKEN to an access token for the new project, with write access to Edge Functions, Auth Config and Storage Config (Account, then Access Tokens). It stays on this computer.",
    );
  }
  if (/^sb_(secret|publishable)_/.test(token) || token.startsWith("eyJ")) {
    throw new StepError("LASTGOOD_SUPABASE_TOKEN holds a project API key. The Management API takes an access token, which starts sbp_ (Account, then Access Tokens).");
  }
  return token;
}

/** The new project's ref: --project-ref, or the one in the connection string. */
export function setupRef(given, ref) {
  const value = given ?? ref;
  if (!value) throw new StepError("Give --project-ref, the new project's 20-letter ref: it could not be read from the database connection string.");
  if (!PROJECT_REF.test(value)) throw new StepError("--project-ref must be the new project's 20-letter ref, from its URL in Supabase.");
  if (given && ref && given !== ref) throw new StepError(`--project-ref is ${given}, but the database connection string is project ${ref}. Give the same project for both.`);
  return value;
}

function waitFor(response, attempt) {
  const raw = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw * 1000, MAX_WAIT_MS);
  return 1000 * 2 ** (attempt - 1);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Management API calls for one project: retried on a network error, 429 or 5xx; a refused token stops the step. */
function managementClient({ api, ref, token, fetchImpl, sleep }) {
  const base = `${(api || DEFAULT_API).replace(/\/+$/, "")}/v1/projects/${ref}`;
  const hide = (text) => clean(String(text).split(token).join("…"));

  async function call(pathname, init, what) {
    let last = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`${base}${pathname}`, { ...init, headers: { Authorization: `Bearer ${token}`, "User-Agent": "lastgood-cli", ...(init?.headers ?? {}) } });
      } catch {
        last = { status: 0, message: "Supabase could not be reached" };
        if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) return { response };
      let message = "";
      try {
        const body = await response.json();
        message = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : "";
      } catch {
        message = "";
      }
      const refusal = { status: response.status, message: hide(message || `HTTP ${response.status}`) };
      if (response.status === 401) throw new StepError(`Supabase refused the token in LASTGOOD_SUPABASE_TOKEN when ${what}. Make an access token with write access to the new project.`);
      if (response.status < 500 && response.status !== 429) return { refusal };
      last = refusal;
      if (attempt < ATTEMPTS) await sleep(waitFor(response, attempt));
    }
    return { refusal: last };
  }

  async function json(pathname, init, what) {
    const { response, refusal } = await call(pathname, init, what);
    if (refusal) throw new StepError(`Supabase would not answer when ${what}: ${refusal.message}.`);
    try {
      return await response.json();
    } catch {
      throw new StepError(`Supabase sent something other than JSON when ${what}.`);
    }
  }

  return { call, json };
}

async function readJson(file, what) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new StepError(`${what} in the setup copy did not read back.`);
  }
}

/** A file:// entrypoint as a path, as the deploy endpoint names files. */
function entrypointPath(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return value.startsWith("file://") ? decodeURIComponent(new URL(value).pathname) : value;
  } catch {
    return value;
  }
}

/** Deploys one function from the copy. Null when it went in, else the refusal. */
async function deploy(client, dir, fn) {
  const slug = fn.slug;
  const fnDir = path.join(dir, "functions", slug);
  const source = await readJson(path.join(fnDir, "source.json"), `The source of the ${slug} function`);
  const fromSource = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const entrypoint = entrypointPath(source.entrypoint_path) ?? entrypointPath(fn.entrypoint_path);
  const importMap = entrypointPath(fromSource.import_map_path ?? fn.import_map_path);
  const verifyJwt = fn.verify_jwt !== false;
  const name = typeof fn.name === "string" && fn.name ? fn.name : slug;
  if (source.format === "eszip") {
    // The only endpoint that takes a bundle is the older create one, deprecated but still served.
    const params = new URLSearchParams({ slug, name, verify_jwt: String(verifyJwt) });
    if (entrypoint) params.set("entrypoint_path", entrypoint);
    if (importMap) params.set("import_map_path", importMap);
    const body = await readFile(path.join(fnDir, "body.eszip"));
    const { refusal } = await client.call(`/functions?${params}`, { method: "POST", headers: { "Content-Type": "application/vnd.denoland.eszip" }, body }, `deploying the ${slug} function`);
    return refusal ?? null;
  }
  const metadata = { entrypoint_path: entrypoint, name, verify_jwt: verifyJwt };
  if (importMap) metadata.import_map_path = importMap;
  if (Array.isArray(fromSource.static_patterns)) metadata.static_patterns = fromSource.static_patterns;
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  for (const file of source.files) {
    form.append("file", new Blob([await readFile(path.join(fnDir, ...file.saved.split("/")))]), file.path);
  }
  const { refusal } = await client.call(`/functions/deploy?${new URLSearchParams({ slug })}`, { method: "POST", body: form }, `deploying the ${slug} function`);
  return refusal ?? null;
}

/** Every file of the copy's functions as text, for the secret names they read. */
async function functionText(dir) {
  const texts = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name !== "source.json") texts.push((await readFile(full)).toString("latin1"));
    }
  }
  await walk(path.join(dir, "functions")).catch(() => {});
  return texts.join("\n");
}

/** Sends a settings change, and when Supabase refuses it whole, each part alone, so one refused part names itself. */
async function patchEach(client, pathname, change, what) {
  const refused = [];
  if (Object.keys(change).length === 0) return { applied: [], refused };
  const whole = await client.call(pathname, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) }, `changing ${what}`);
  if (!whole.refusal) return { applied: Object.keys(change), refused };
  const applied = [];
  for (const [field, value] of Object.entries(change)) {
    const parts = field === "features" ? Object.entries(value).map(([name, feature]) => [`features.${name}`, { features: { [name]: feature } }]) : [[field, { [field]: value }]];
    for (const [label, body] of parts) {
      const one = await client.call(pathname, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, `changing ${what}`);
      if (one.refusal) refused.push(`${label} (${one.refusal.message})`);
      else applied.push(label);
    }
  }
  return { applied, refused };
}

/**
 * Deploys the setup copy's Edge Functions into a new project and applies its auth, third-party auth and storage
 * settings, then lists what the customer sets by hand.
 */
export async function rebuildSetup({ archive, ref, token, work, say, todo = say, api, fetchImpl = fetch, sleep = defaultSleep }) {
  const secret = checkToken(token);
  const client = managementClient({ api, ref, token: secret, fetchImpl, sleep });

  const dir = path.join(work, "setup");
  await rm(dir, { recursive: true, force: true });
  await checkArchive(archive, "setup", { gzip: true });
  await mkdir(dir, { recursive: true });
  const extract = await run("tar", ["-xzf", archive, "-C", dir, "--no-same-owner"]);
  if (extract.code !== 0) throw new StepError("The setup copy did not open.");
  try {
    checkSetup(dir);
  } catch (error) {
    if (error instanceof SetupError) throw new StepError(error.message);
    throw error;
  }
  const functions = await readJson(path.join(dir, "functions.json"), "functions.json");

  // The token and the project, before anything is written.
  await client.json("", { headers: { Accept: "application/json" } }, "reading the new project");

  // Edge Functions.
  const listed = await client.json("/functions", { headers: { Accept: "application/json" } }, "listing the new project's Edge Functions");
  const existing = new Set((Array.isArray(listed) ? listed : []).map((fn) => fn?.slug).filter(Boolean));
  const kept = [];
  const deployed = [];
  const failed = [];
  for (const fn of functions) {
    if (existing.has(fn.slug)) {
      kept.push(fn.slug);
      continue;
    }
    const refusal = await deploy(client, dir, fn);
    if (!refusal) deployed.push(fn.slug);
    else {
      const source = await readJson(path.join(dir, "functions", fn.slug, "source.json"), `The source of the ${fn.slug} function`);
      failed.push({ slug: fn.slug, message: refusal.message, eszip: source.format === "eszip" });
    }
  }
  if (kept.length > 0) say(`Already in the new project, kept and not deployed again: ${kept.join(", ")}.`);
  if (deployed.length > 0) say(`Deployed ${counted(deployed.length, "Edge Function")}: ${deployed.join(", ")}.`);
  if (failed.length > 0) {
    const eszip = failed.filter((item) => item.eszip).map((item) => item.slug);
    throw new StepError(
      `Supabase did not take ${counted(failed.length, "Edge Function")}: ${failed.map((item) => `${item.slug} (${item.message})`).join("; ")}.`,
      eszip.length > 0
        ? `The copy holds ${eszip.join(", ")} as a bundle, which only Supabase's older deploy endpoint takes. Deploy ${eszip.length === 1 ? "it" : "them"} by hand from the code copy's supabase/functions folder with supabase functions deploy, then run this again: the functions already deployed are kept.`
        : "Run this again once the cause is fixed: the functions already deployed are kept.",
    );
  }
  if (deployed.length > 0) {
    // Only the functions this run deployed: one already there is left as it was, whatever its JWT check.
    const after = await client.json("/functions", { headers: { Accept: "application/json" } }, "checking the new project's Edge Functions");
    const bySlug = new Map((Array.isArray(after) ? after : []).map((fn) => [fn?.slug, fn]));
    const wrong = functions
      .filter((fn) => deployed.includes(fn.slug))
      .filter((fn) => !bySlug.has(fn.slug) || (fn.verify_jwt !== undefined && bySlug.get(fn.slug).verify_jwt !== fn.verify_jwt))
      .map((fn) => fn.slug);
    if (wrong.length > 0) throw new StepError(`The new project does not list ${wrong.join(", ")} as the copy has ${wrong.length === 1 ? "it" : "them"}, with the same JWT check.`);
    say(`The new project lists every Edge Function deployed, each with the JWT check it had.`);
  }

  // Auth settings: only what differs, never a secret.
  const byHand = [];
  const notApplied = [];
  const authNow = await client.json("/config/auth", { headers: { Accept: "application/json" } }, "reading the new project's auth settings");
  const hooks = rewriteHooks(await readJson(path.join(dir, "auth-config.json"), "auth-config.json"), authNow, ref, deployed);
  const authCopy = hooks.auth;
  if (hooks.rewritten.length > 0) {
    say(`Pointed these hooks at the new project, since this run deployed the function each calls: ${hooks.rewritten.join(", ")}.`);
  }
  const auth = authChanges(authCopy, authNow);
  byHand.push(...auth.byHand);
  const authResult = await patchEach(client, "/config/auth", auth.change, "the auth settings");
  notApplied.push(...authResult.refused.map((item) => `auth ${item}`));
  if (authResult.applied.length > 0) say(`Auth settings set as they were: ${authResult.applied.join(", ")}.`);
  else if (authResult.refused.length === 0) say("The new project's auth settings already match the copy's.");
  for (const field of ADDRESS_FIELDS) {
    if (authResult.applied.includes(field) || authCopy?.[field]) {
      say(`${field}: ${authCopy?.[field] || "(empty)"}. If the app moves to a new domain, change it in Supabase under Authentication, then URL Configuration.`);
    }
  }
  // A hook or any other auth setting that still names the old project would make the new one call it, or fail when
  // it is gone. Copied as it was, and named for the customer to point at the new project.
  const staleAuth = Object.entries(authCopy ?? {})
    .map(([field, value]) => [field, otherRefs(typeof value === "string" ? value : JSON.stringify(value), ref)])
    .filter(([, refs]) => refs.length > 0)
    .map(([field, refs]) => `${field} (${refs.join(", ")})`)
    .sort();
  if (staleAuth.length > 0) {
    todo(`These auth settings still name another Supabase project, so the new one would call it: ${staleAuth.join(", ")}. Point each at the new project in Supabase, under Authentication.`);
  }

  // Third-party auth: each integration the new project lacks.
  const thirdCopy = await readJson(path.join(dir, "auth-third-party.json"), "auth-third-party.json");
  const thirdNow = await client.json("/config/auth/third-party-auth", { headers: { Accept: "application/json" } }, "reading the new project's third-party auth");
  // An integration is the issuer or keys address it trusts, or its own keys when it has neither.
  const identity = (item) => item?.oidc_issuer_url || item?.jwks_url || (item?.custom_jwks ? JSON.stringify(item.custom_jwks) : null);
  const known = new Set((Array.isArray(thirdNow) ? thirdNow : []).map(identity).filter(Boolean));
  let added = 0;
  for (const item of Array.isArray(thirdCopy) ? thirdCopy : []) {
    const id = identity(item);
    if (id && known.has(id)) continue;
    const body = {};
    for (const field of ["oidc_issuer_url", "jwks_url", "custom_jwks"]) if (item?.[field]) body[field] = item[field];
    if (Object.keys(body).length === 0) continue;
    const { refusal } = await client.call("/config/auth/third-party-auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, "adding third-party auth");
    if (refusal) notApplied.push(`third-party auth ${item?.oidc_issuer_url || item?.jwks_url || "with its own keys"} (${refusal.message})`);
    else added += 1;
  }
  if (added > 0) say(`Added ${counted(added, "third-party auth integration")}.`);

  // Storage settings: the file size limit and features. A feature the plan does not have is named, not fatal.
  const storageCopy = await readJson(path.join(dir, "storage-config.json"), "storage-config.json");
  const storageNow = await client.json("/config/storage", { headers: { Accept: "application/json" } }, "reading the new project's storage settings");
  const storageResult = await patchEach(client, "/config/storage", storageChanges(storageCopy, storageNow), "the storage settings");
  notApplied.push(...storageResult.refused.map((item) => `storage ${item}`));
  if (storageResult.applied.length > 0) say(`Storage settings set as they were: ${storageResult.applied.join(", ")}.`);

  // What the customer sets by hand.
  if (byHand.length > 0) {
    todo(`Set these auth settings by hand, since the copy never sends a secret: ${byHand.join(", ")}. They are under Authentication in Supabase.`);
  }
  if (notApplied.length > 0) todo(`Supabase did not take these, most likely because of the new project's plan. Set them by hand: ${notApplied.join("; ")}.`);
  const reads = envNames(await functionText(dir));
  if (reads.size > 0) {
    const secrets = await client.json("/secrets", { headers: { Accept: "application/json" } }, "listing the new project's function secrets");
    const have = new Set((Array.isArray(secrets) ? secrets : []).map((item) => item?.name));
    const missing = [...reads].filter((name) => !have.has(name)).sort();
    if (missing.length > 0) todo(`The functions read secrets the new project does not have yet. Set them under Edge Functions, then Secrets: ${missing.join(", ")}.`);
  }
  const cron = await readJson(path.join(dir, "cron-jobs.json"), "cron-jobs.json");
  if (Array.isArray(cron) && cron.length > 0) {
    const lines = cron.map((job) => {
      const others = otherRefs(job?.command, ref);
      return `${job?.jobname ?? `job ${job?.jobid}`} (${job?.schedule})${others.length > 0 ? `, which calls the old project ${others.join(", ")}` : ""}`;
    });
    todo(`Scheduled jobs are not recreated, so none calls the old project by mistake. Add them again with pg_cron: ${lines.join("; ")}.`);
  }
  const webhooks = await readJson(path.join(dir, "database-webhooks.json"), "database-webhooks.json");
  const stale = (Array.isArray(webhooks) ? webhooks : []).filter((hook) => otherRefs(hook?.definition, ref).length > 0);
  if (stale.length > 0) {
    todo(`Database webhooks that came back with the database still call the old project. Point them at the new one: ${stale.map((hook) => `${hook.trigger} on ${hook.schema}.${hook.table}`).join(", ")}.`);
  }
  const vault = await readJson(path.join(dir, "vault-secret-names.json"), "vault-secret-names.json");
  if (Array.isArray(vault) && vault.length > 0) todo(`Add these Vault secrets again: ${vault.map((item) => item?.name).filter(Boolean).join(", ")}.`);
  todo("The new project has its own API keys (Project Settings, then API Keys). The app's environment variables need them, which is the Vercel step.");

  const toDo = byHand.length + notApplied.length + staleAuth.length;
  return [counted(deployed.length + kept.length, "function"), counted(authResult.applied.length + storageResult.applied.length + added, "setting"), toDo > 0 ? `${toDo} to set by hand` : ""]
    .filter(Boolean)
    .join(", ");
}
