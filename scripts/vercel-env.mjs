// A Vercel project's environment variables, read with the customer's own Vercel token inside their own GitHub
// Action: every name, and every value Vercel returns. Vercel never returns a value it marks "sensitive", nor the
// values it supplies itself, so for those only the name, targets and type are kept. Only GET requests. The file
// is written for run.sh to encrypt to the app's key before anything leaves the runner. The token and the values
// are never printed.
// Usage: node vercel-env.mjs <file>. Prints "<variables> <with value> <without value>" on success.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
/** A project ID (prj_...) or a project name. */
export const PROJECT = /^[A-Za-z0-9._-]{1,100}$/;
export const TEAM = /^team_[A-Za-z0-9]{1,64}$/;
const ENV_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Types whose value Vercel never returns to anyone, the token's owner included. */
export const NO_VALUE_TYPES = new Set(["sensitive", "system", "secret"]);

export class VercelEnvError extends Error {
  /** Vercel's HTTP status, when the error is Vercel's answer, so a caller can treat a 404 as "not there". */
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

function explain(status, what) {
  if (status === 401) {
    return "Vercel did not accept LIFEBOAT_VERCEL_TOKEN. It may have expired or been revoked: make a new token and replace the secret.";
  }
  if (status === 403) return `LIFEBOAT_VERCEL_TOKEN cannot read ${what}. Make the token in the Vercel team that owns this project.`;
  if (status === 404) return `Vercel found no such project for this token when reading ${what}. Check vercel-project-id, and vercel-team-id for a team project.`;
  if (status === 429) return `Vercel's rate limit stopped the copy of ${what}. The next run tries again.`;
  return `Vercel answered ${status} when reading ${what}.`;
}

function waitFor(response, attempt) {
  for (const name of ["retry-after", "x-ratelimit-reset"]) {
    const raw = Number(response.headers.get(name));
    if (!Number.isFinite(raw) || raw <= 0) continue;
    // x-ratelimit-reset is a Unix time in seconds; Retry-After is a number of seconds.
    const seconds = name === "x-ratelimit-reset" && raw > 1e9 ? raw - Date.now() / 1000 : raw;
    if (seconds > 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  }
  return 1000 * 2 ** (attempt - 1);
}

/** One GET with the token, retried on a rate limit or Vercel's own errors. The copies make no other kind of request. */
export async function call(url, { token, fetchImpl, sleep, what }) {
  let last = null;
  let status = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)",
        },
      });
    } catch {
      last = `Vercel could not be reached when reading ${what}.`;
      status = null;
      if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new VercelEnvError(`Vercel sent something other than JSON for ${what}.`);
      }
    }
    last = explain(response.status, what);
    status = response.status;
    if (response.status < 500 && response.status !== 429) break;
    if (attempt < ATTEMPTS) await sleep(waitFor(response, attempt));
  }
  throw new VercelEnvError(last ?? `Vercel did not answer when reading ${what}.`, status);
}

function targets(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

/**
 * Writes the project's environment variables to `file`, values included where Vercel returns them.
 * Returns the counts for the run's report.
 */
export async function exportVercelEnv({ api, project, team, token, file, fetchImpl = fetch, sleep = defaultSleep }) {
  if (!token) throw new VercelEnvError("Set LIFEBOAT_VERCEL_TOKEN to copy the Vercel environment variables.");
  if (!PROJECT.test(project ?? "")) throw new VercelEnvError("Set vercel-project-id to the Vercel project's ID (prj_...).");
  if (team && !TEAM.test(team)) throw new VercelEnvError("vercel-team-id must be the team's ID (team_...).");
  const base = `${(api || "https://api.vercel.com").replace(/\/+$/, "")}`;
  const query = team ? `?teamId=${team}` : "";
  const deps = { token, fetchImpl, sleep };

  const listWhat = "the project's environment variables";
  const listed = await call(`${base}/v10/projects/${encodeURIComponent(project)}/env${query}`, { ...deps, what: listWhat });
  const envs = Array.isArray(listed) ? listed : listed?.envs;
  if (!Array.isArray(envs)) throw new VercelEnvError(`Vercel sent something other than a list for ${listWhat}.`);
  // A list that says there is more would leave variables out of the copy without anyone knowing.
  if (listed?.pagination?.next) throw new VercelEnvError(`Vercel sent ${listWhat} in more than one page, which this copy cannot read yet.`);

  const variables = [];
  for (const env of envs) {
    const key = typeof env?.key === "string" ? env.key : "";
    if (!key || key.length > 256) throw new VercelEnvError("Vercel listed an environment variable without a usable name.");
    const type = typeof env.type === "string" ? env.type : "unknown";
    const entry = {
      key,
      type,
      target: targets(env.target),
      gitBranch: typeof env.gitBranch === "string" ? env.gitBranch : null,
      customEnvironmentIds: Array.isArray(env.customEnvironmentIds) ? env.customEnvironmentIds.filter((id) => typeof id === "string") : [],
      comment: typeof env.comment === "string" ? env.comment : null,
      value: null,
      note: null,
    };
    if (NO_VALUE_TYPES.has(type)) {
      entry.note =
        type === "system"
          ? "Set by Vercel itself; it fills this in again on the new project."
          : "Vercel never returns this value. Keep it yourself: LastGood cannot restore it.";
    } else if (type === "plain" && typeof env.value === "string") {
      entry.value = env.value;
    } else {
      if (typeof env.id !== "string" || !ENV_ID.test(env.id)) throw new VercelEnvError(`Vercel listed ${key} without an ID this copy can read.`);
      const what = `the value of ${key}`;
      const one = await call(`${base}/v1/projects/${encodeURIComponent(project)}/env/${env.id}${query}`, { ...deps, what });
      if (typeof one?.value === "string" && (one.decrypted === true || one.type === "plain")) {
        entry.value = one.value;
      } else {
        entry.note = "Vercel did not return a readable value. Keep it yourself: LastGood cannot restore it.";
      }
    }
    variables.push(entry);
  }

  writeFileSync(file, JSON.stringify({ project, teamId: team || null, variables }), { mode: 0o600 });
  const withValue = variables.filter((entry) => entry.value !== null).length;
  return { variables: variables.length, withValue, withoutValue: variables.length - withValue };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  try {
    if (!file) throw new VercelEnvError("Usage: vercel-env.mjs <file>");
    const counts = await exportVercelEnv({
      api: process.env.VERCEL_API_URL,
      project: process.env.VERCEL_PROJECT_ID?.trim(),
      team: process.env.VERCEL_TEAM_ID?.trim(),
      token: process.env.LIFEBOAT_VERCEL_TOKEN?.trim(),
      file,
    });
    process.stdout.write(`${counts.variables} ${counts.withValue} ${counts.withoutValue}\n`);
  } catch (error) {
    console.error(error instanceof VercelEnvError ? error.message : "The Vercel environment variable copy failed.");
    process.exit(1);
  }
}
