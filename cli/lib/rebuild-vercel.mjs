import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PROJECT, TEAM } from "./lifeboat/vercel-env.mjs";
import { clean } from "./rebuild-list.mjs";
import { checkArchive, counted, run, StepError } from "./rebuild.mjs";
import { otherRefs } from "./rebuild-setup.mjs";

/**
 * Vercel environment variables back into a new project (R4), from the copy the customer's own workflow made with their
 * Vercel token (B9), on the customer's own computer. It talks to Vercel with the customer's token from
 * LASTGOOD_VERCEL_TOKEN, which never leaves this computer and never appears in a message, and no value is ever printed.
 *
 * The project is one the customer made, most simply by importing the new repository in Vercel. A variable already set
 * there for any of the same environments is kept and never written over, so a rerun carries on and one added by hand
 * or by an integration stays as it is. Values Vercel never returned to the backup (sensitive ones) are named for the
 * customer to add, Vercel's own are left for it to fill in, and values that still point at the old Supabase project
 * are named to change. Nothing is read back from the new project but names and environments.
 */

const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
const DEFAULT_API = "https://api.vercel.com";
const TARGETS = ["production", "preview", "development"];
/** Values shorter than this are not cut out of Vercel's messages: "1" or "true" would mangle them, and say nothing secret. */
const HIDDEN_LENGTH = 6;

/** The token from LASTGOOD_VERCEL_TOKEN, refused when it is plainly another kind of key. */
export function checkVercelToken(value) {
  const token = String(value ?? "").trim();
  if (!token) {
    throw new StepError(
      "Set LASTGOOD_VERCEL_TOKEN to a Vercel token for the team that owns the new project (Account Settings, then Tokens). It stays on this computer.",
    );
  }
  if (/\s/.test(token) || /^(sbp_|sb_(secret|publishable)_|eyJ)/.test(token)) {
    throw new StepError("LASTGOOD_VERCEL_TOKEN does not hold a Vercel token. Make one under Account Settings, then Tokens, in Vercel.");
  }
  return token;
}

/** The new Vercel project and its team, checked before anything runs. */
export function vercelTarget(project, team) {
  if (!project) throw new StepError("Give --vercel-project: the new Vercel project's ID (prj_...) or name. Make it first, by importing the new repository in Vercel.");
  if (!PROJECT.test(project)) throw new StepError("--vercel-project must be the new Vercel project's ID (prj_...) or its name.");
  if (team && !TEAM.test(team)) throw new StepError("--vercel-team must be the team's ID (team_...), from the team's settings in Vercel.");
  return { project, team: team || null };
}

/** Supabase project refs a value names, in an address or a pooler login. */
export function refsIn(value) {
  const text = String(value ?? "");
  const refs = new Set(otherRefs(text, null));
  for (const match of text.matchAll(/\bpostgres\.([a-z]{20})(?=[:@])/g)) refs.add(match[1]);
  return [...refs].sort();
}

/**
 * A Supabase API key from another project than `ref`: a legacy anon or service role key naming another ref, or a
 * publishable or secret key, which names no project, so is always one from the copy.
 */
export function holdsSupabaseKey(value, ref = null) {
  const text = String(value ?? "").trim();
  if (/^sb_(publishable|secret)_/.test(text)) return true;
  const claims = jwtClaims(text);
  return claims?.iss === "supabase" && !(ref && claims.ref === ref);
}

function jwtClaims(text) {
  const parts = text.trim().split(".");
  if (parts.length !== 3 || !parts[0].startsWith("eyJ")) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

function targetsOf(entry) {
  return (Array.isArray(entry?.target) ? entry.target : []).filter((target) => TARGETS.includes(target));
}

function branchOf(entry) {
  return typeof entry?.gitBranch === "string" && entry.gitBranch ? entry.gitBranch : null;
}

function named(entry, targets = targetsOf(entry)) {
  const where = [...targets, ...(branchOf(entry) ? [`branch ${branchOf(entry)}`] : [])];
  return where.length > 0 ? `${entry.key} (${where.join(", ")})` : entry.key;
}

/**
 * What to do with each variable in the copy, against those already in the new project: put back, kept, added by hand
 * (no value, or only for a custom environment), or left for Vercel.
 */
export function plan(variables, existing) {
  const result = { put: [], kept: [], byHand: [], custom: [], system: [], none: [] };
  for (const entry of variables) {
    if (entry.type === "system") {
      result.system.push(entry.key);
      continue;
    }
    const targets = targetsOf(entry);
    const customs = Array.isArray(entry.customEnvironmentIds) ? entry.customEnvironmentIds.filter((id) => typeof id === "string") : [];
    if (customs.length > 0) result.custom.push(entry.key);
    if (targets.length === 0) {
      if (customs.length === 0) result.none.push(entry.key);
      continue;
    }
    if (typeof entry.value !== "string") {
      result.byHand.push(named(entry, targets));
      continue;
    }
    const clash = existing.some((have) => have?.key === entry.key && branchOf(have) === branchOf(entry) && targetsOf(have).some((target) => targets.includes(target)));
    if (clash) {
      result.kept.push(named(entry, targets));
      continue;
    }
    result.put.push({ ...entry, target: targets });
  }
  return result;
}

function waitFor(response, attempt) {
  for (const name of ["retry-after", "x-ratelimit-reset"]) {
    const raw = Number(response?.headers?.get(name));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    // x-ratelimit-reset is a Unix time in seconds; Retry-After is a number of seconds.
    const seconds = name === "x-ratelimit-reset" && raw > 1e9 ? raw - Date.now() / 1000 : raw;
    if (seconds > 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  }
  return 1000 * 2 ** (attempt - 1);
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Vercel API calls for one project: retried on a network error, 429 or 5xx, unless `init.retry` is false, for a write
 * that a retry could make twice; a refused token stops the step.
 */
export function vercelClient({ api, project, team, token, fetchImpl, sleep }) {
  const base = `${(api || DEFAULT_API).replace(/\/+$/, "")}`;
  // A value sent is hidden from the message too, unless it is too short to be a secret. The token always is.
  const hide = (text, values = []) =>
    clean(values.filter((value) => typeof value === "string" && value.length >= HIDDEN_LENGTH).reduce((out, value) => out.split(value).join("…"), String(text).split(token).join("…")));
  const url = (pathname) =>
    `${base}${pathname.replace("{project}", encodeURIComponent(project))}${team ? `${pathname.includes("?") ? "&" : "?"}teamId=${team}` : ""}`;

  async function call(pathname, init, what, values = []) {
    const { retry = true, ...request } = init ?? {};
    const attempts = retry ? ATTEMPTS : 1;
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url(pathname), {
          ...request,
          headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": "lastgood-cli", ...(request.headers ?? {}) },
        });
      } catch {
        last = { status: 0, message: "Vercel could not be reached" };
        if (attempt < attempts) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) {
        try {
          return { body: await response.json() };
        } catch {
          throw new StepError(`Vercel sent something other than JSON when ${what}.`);
        }
      }
      let message = "";
      try {
        const body = await response.json();
        message = typeof body?.error?.message === "string" ? body.error.message : typeof body?.message === "string" ? body.message : "";
      } catch {
        message = "";
      }
      if (response.status === 401) throw new StepError(`Vercel refused the token in LASTGOOD_VERCEL_TOKEN when ${what}. It may have expired: make a new one.`);
      // A 403 on a domain's own path means the domain is not this team's, which the caller handles.
      if (response.status === 403 && pathname.includes("{project}")) throw new StepError(`The token in LASTGOOD_VERCEL_TOKEN cannot reach the new project when ${what}. Make it in the team that owns the project, and give --vercel-team for a team project.`);
      if (response.status === 404 && !request.method && pathname.includes("{project}")) throw new StepError(`Vercel found no project ${project} for this token when ${what}. Check --vercel-project, and --vercel-team for a team project.`);
      const refusal = { status: response.status, message: hide(message || `HTTP ${response.status}`, values) };
      if (response.status < 500 && response.status !== 429) return { refusal };
      last = refusal;
      if (attempt < attempts) await sleep(waitFor(response, attempt));
    }
    return { refusal: last };
  }

  async function json(pathname, what) {
    const { body, refusal } = await call(pathname, undefined, what);
    if (refusal) throw new StepError(`Vercel would not answer when ${what}: ${refusal.message}.`);
    return body;
  }

  return { call, json, hide };
}

async function listEnv(client, what) {
  const listed = await client.json("/v10/projects/{project}/env", what);
  const envs = Array.isArray(listed) ? listed : listed?.envs;
  if (!Array.isArray(envs)) throw new StepError(`Vercel sent something other than a list when ${what}.`);
  // A list that says there is more would hide a variable already there, which this step must never write over.
  if (listed?.pagination?.next) throw new StepError(`Vercel sent the new project's environment variables in more than one page, which this version of rebuild cannot read yet.`);
  return envs;
}

/** The copy's variables, as the backup wrote them (lifeboat/scripts/vercel-env.mjs). */
async function readCopy(archive, work) {
  const dir = path.join(work, "vercel");
  await rm(dir, { recursive: true, force: true });
  await checkArchive(archive, "Vercel", { gzip: true });
  await mkdir(dir, { recursive: true });
  const extract = await run("tar", ["-xzf", archive, "-C", dir, "--no-same-owner"]);
  if (extract.code !== 0) throw new StepError("The Vercel copy did not open.");
  let copy;
  try {
    copy = JSON.parse(await readFile(path.join(dir, "env.json"), "utf8"));
  } catch {
    throw new StepError("env.json in the Vercel copy did not read back.");
  } finally {
    // The values are secrets: the readable copy goes as soon as it is read.
    await rm(dir, { recursive: true, force: true });
  }
  const variables = copy?.variables;
  if (!Array.isArray(variables) || variables.some((entry) => typeof entry?.key !== "string" || !entry.key)) {
    throw new StepError("The Vercel copy's env.json is not a list of variables, so it was not used.");
  }
  return variables;
}

/**
 * Puts the copy's environment variables into the new Vercel project, keeping every one already there, then lists what
 * the customer adds or changes by hand. `ref` is the new Supabase project, when it is known.
 */
export async function rebuildVercel({ archive, project, team, token, ref = null, work, say, todo = say, api, fetchImpl = fetch, sleep = defaultSleep }) {
  const secret = checkVercelToken(token);
  const target = vercelTarget(project, team);
  const client = vercelClient({ api, ...target, token: secret, fetchImpl, sleep });
  const variables = await readCopy(archive, work);

  // The token and the project, before anything is written.
  const info = await client.json("/v9/projects/{project}", "reading the new project");
  const link = info?.link;
  const repo = link?.org && link?.repo ? `${link.org}/${link.repo}` : link?.projectNameWithNamespace || (link?.owner && link?.slug ? `${link.owner}/${link.slug}` : null);
  if (repo) say(`Vercel project ${info?.name ?? target.project}, built from ${repo}.`);
  else todo(`Vercel project ${info?.name ?? target.project}, not connected to a Git repository yet. Connect it to the new repository under Settings, then Git, so it builds from the code.`);

  const before = await listEnv(client, "listing the new project's environment variables");
  const planned = plan(variables, before);
  const put = [];
  const refused = [];
  for (const entry of planned.put) {
    const body = { key: entry.key, value: entry.value, type: entry.type === "plain" ? "plain" : "encrypted", target: entry.target };
    if (branchOf(entry)) body.gitBranch = branchOf(entry);
    if (typeof entry.comment === "string" && entry.comment) body.comment = entry.comment;
    const { body: answer, refusal } = await client.call(
      "/v10/projects/{project}/env",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      `putting back ${entry.key}`,
      [entry.value],
    );
    // A 201 can still carry a refusal, whose error may hold the value: only its message is read, with the value hidden.
    const failed = Array.isArray(answer?.failed) ? answer.failed[0]?.error : null;
    const reason = refusal?.message ?? (failed ? client.hide(failed.message || failed.code || "refused", [entry.value]) : null);
    if (reason) refused.push({ entry, reason });
    else put.push(entry);
  }

  // A POST that reached Vercel before the network dropped is sent again, and the retry is refused because the
  // variable is now there. One the project lists that was not there before is kept, not a failure.
  const listed = (envs, entry) =>
    envs.some((have) => have?.key === entry.key && branchOf(have) === branchOf(entry) && entry.target.every((name) => targetsOf(have).includes(name)));
  if (refused.length > 0) {
    const now = await listEnv(client, "checking the variables Vercel refused");
    for (const item of refused.filter(({ entry }) => listed(now, entry))) {
      planned.kept.push(named(item.entry));
      refused.splice(refused.indexOf(item), 1);
    }
  }

  if (put.length > 0) say(`Put back ${counted(put.length, "environment variable")}: ${put.map((entry) => named(entry)).join(", ")}.`);
  if (planned.kept.length > 0) say(`Already in the new project for the same environment, kept as they are: ${planned.kept.join(", ")}.`);
  if (refused.length > 0) {
    throw new StepError(
      `Vercel did not take ${counted(refused.length, "environment variable")}: ${refused.map(({ entry, reason }) => `${entry.key} (${reason})`).join("; ")}.`,
      "Run this again once the cause is fixed: the variables already put back are kept.",
    );
  }
  if (put.length > 0) {
    const after = await listEnv(client, "checking the new project's environment variables");
    const missing = put.filter((entry) => !listed(after, entry)).map((entry) => entry.key);
    if (missing.length > 0) throw new StepError(`The new project does not list ${missing.join(", ")} for the environments the copy has.`);
    say("The new project lists every variable put back, for the environments it had.");
  }

  // What the customer adds or changes by hand.
  if (planned.byHand.length > 0) {
    todo(`Vercel never returned these values to the backup, so add them by hand under Settings, then Environment Variables: ${planned.byHand.join(", ")}.`);
  }
  if (planned.custom.length > 0) todo(`Also set for a custom environment the new project does not have yet. Add them there once you make it: ${planned.custom.join(", ")}.`);
  if (planned.none.length > 0) say(`Not set for any environment in the copy, so left out: ${planned.none.join(", ")}.`);
  if (planned.system.length > 0) say(`Left for Vercel to fill in: ${counted(planned.system.length, "system variable")}.`);
  const withValue = variables.filter((entry) => typeof entry.value === "string" && entry.type !== "system");
  const stale = withValue
    .map((entry) => [entry.key, refsIn(entry.value).filter((found) => found !== ref)])
    .filter(([, refs]) => refs.length > 0)
    .map(([key, refs]) => `${key} (${refs.join(", ")})`);
  if (stale.length > 0) {
    todo(
      ref
        ? `These values still name another Supabase project, so the app would call it: ${stale.join(", ")}. Change each to the new project's under Settings, then Environment Variables.`
        : `These values name a Supabase project: ${stale.join(", ")}. If the app now uses a new project, change each to its address.`,
    );
  }
  const keys = withValue.filter((entry) => holdsSupabaseKey(entry.value, ref)).map((entry) => entry.key);
  if (keys.length > 0) {
    todo(`These hold a Supabase API key from the copy, which works only with the project it came from. Replace each with the new project's own key (Project Settings, then API Keys, in Supabase): ${keys.join(", ")}.`);
  }
  if (put.length > 0) todo("Deploy the project again in Vercel (Deployments, then Redeploy): a deployment reads its variables when it builds.");

  const toDo = planned.byHand.length + planned.custom.length + stale.length + keys.length;
  return [counted(put.length + planned.kept.length, "variable"), toDo > 0 ? `${toDo} to add or change by hand` : ""].filter(Boolean).join(", ");
}
