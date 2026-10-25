// A Vercel project's settings, its domains and their DNS records, read with the customer's own Vercel token inside
// their own GitHub Action (B8). Only GET requests, through the same helper as the environment variable copy. The
// project is kept through a list of the fields a rebuild needs, so deploy hook URLs, protection bypass secrets and the
// environment variables (vercel-env.mjs's job) never enter the file. The file is written for run.sh to encrypt to the
// app's key before anything leaves the runner. The token is never printed.
// Usage: node vercel-settings.mjs <file>. Prints "<domains> <DNS records> <domains whose DNS was not readable>".
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { call, PROJECT, TEAM, VercelEnvError } from "./vercel-env.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_APEXES = 50;
const MAX_TEXT = 4096;
const MAX_LIST = 100;
/** A domain name, as it goes into a request path. Punycode labels pass; anything with a slash or a dot at either end does not. */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;
/** Vercel's own apex for the project's *.vercel.app addresses. Its DNS is Vercel's, not the customer's. */
const VERCEL_APEX = "vercel.app";

/** The project's own fields a rebuild needs. Anything else Vercel sends is dropped. */
const PROJECT_FIELDS = [
  "id",
  "name",
  "framework",
  "nodeVersion",
  "buildCommand",
  "devCommand",
  "installCommand",
  "outputDirectory",
  "rootDirectory",
  "commandForIgnoringBuildStep",
  "serverlessFunctionRegion",
  "sourceFilesOutsideRootDirectory",
  "directoryListing",
  "autoExposeSystemEnvs",
  "autoAssignCustomDomains",
  "gitForkProtection",
  "publicSource",
  "skewProtectionMaxAge",
];
const RESOURCE_FIELDS = ["functionDefaultMemoryType", "functionDefaultTimeout", "functionDefaultRegions", "fluid", "buildMachineType", "elasticConcurrencyEnabled"];
const SSO_FIELDS = ["deploymentType"];
const LINK_FIELDS = ["type", "org", "repo", "repoId", "productionBranch"];
/** A deploy hook's URL works without a token, so it is a secret, and a new project gets new ones: only these are kept. */
const DEPLOY_HOOK_FIELDS = ["name", "ref"];
const CRON_FIELDS = ["path", "schedule"];
const DOMAIN_FIELDS = ["name", "apexName", "redirect", "redirectStatusCode", "gitBranch", "customEnvironmentId", "verified"];
const RECORD_FIELDS = ["name", "type", "value", "ttl", "mxPriority", "priority", "comment"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A value as it is kept: text, a number, true or false, null, or a short list of those. Anything else is dropped. */
function plain(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= MAX_TEXT ? value : undefined;
  if (Array.isArray(value) && value.length <= MAX_LIST) {
    const items = value.map(plain);
    return items.every((item) => item !== undefined && !Array.isArray(item)) ? items : undefined;
  }
  return undefined;
}

function pick(source, fields) {
  const kept = {};
  for (const field of fields) {
    const value = plain(source[field]);
    if (value !== undefined) kept[field] = value;
  }
  return kept;
}

/** The settings a rebuild needs from Vercel's project, and nothing else. */
export function projectSettings(raw) {
  if (!isObject(raw)) throw new VercelEnvError("Vercel sent something other than a project for the project's settings.");
  const settings = pick(raw, PROJECT_FIELDS);
  if (isObject(raw.resourceConfig)) settings.resourceConfig = pick(raw.resourceConfig, RESOURCE_FIELDS);
  if (isObject(raw.ssoProtection)) settings.ssoProtection = pick(raw.ssoProtection, SSO_FIELDS);
  if (isObject(raw.link)) {
    settings.link = pick(raw.link, LINK_FIELDS);
    if (Array.isArray(raw.link.deployHooks)) settings.link.deployHooks = raw.link.deployHooks.filter(isObject).map((hook) => pick(hook, DEPLOY_HOOK_FIELDS));
  }
  if (isObject(raw.crons) && Array.isArray(raw.crons.definitions)) {
    settings.crons = raw.crons.definitions.filter(isObject).map((cron) => pick(cron, CRON_FIELDS));
  }
  return settings;
}

/** Every page of a Vercel list, newest first, following `pagination.next` as `until`. */
async function listAll(base, path, key, what, team, deps) {
  const items = [];
  let until = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (until !== null) query.set("until", String(until));
    if (team) query.set("teamId", team);
    const answer = await call(`${base}${path}?${query}`, { ...deps, what });
    const list = answer?.[key];
    if (!Array.isArray(list)) throw new VercelEnvError(`Vercel sent something other than a list for ${what}.`);
    items.push(...list);
    const next = answer?.pagination?.next;
    if (next === null || next === undefined) return items;
    // A page that points back at itself would loop until the run timed out.
    if (!Number.isFinite(Number(next)) || Number(next) === until) throw new VercelEnvError(`Vercel's pages of ${what} did not move on, so the copy stopped.`);
    until = Number(next);
  }
  throw new VercelEnvError(`Vercel sent ${what} in more than ${MAX_PAGES} pages, which this copy cannot read yet.`);
}

/** One apex domain's DNS records, or a note when this token cannot read them, as when the DNS is kept outside Vercel. */
async function dnsRecords(base, apex, team, deps) {
  try {
    const records = await listAll(base, `/v5/domains/${encodeURIComponent(apex)}/records`, "records", `the DNS records of ${apex}`, team, deps);
    return { domain: apex, records: records.filter(isObject).map((record) => pick(record, RECORD_FIELDS)), note: null };
  } catch (error) {
    if (!(error instanceof VercelEnvError) || (error.status !== 403 && error.status !== 404)) throw error;
    return {
      domain: apex,
      records: null,
      note: "This token cannot read this domain's DNS records, most likely because its DNS is kept outside Vercel. Keep a copy of them where it is kept: LastGood cannot restore them.",
    };
  }
}

/**
 * Writes the project's settings, its domains and their DNS records to `file`. Returns the counts for the run's report.
 */
export async function exportVercelSettings({ api, project, team, token, file, fetchImpl = fetch, sleep = defaultSleep }) {
  if (!token) throw new VercelEnvError("Set LIFEBOAT_VERCEL_TOKEN to copy the Vercel project's settings.");
  if (!PROJECT.test(project ?? "")) throw new VercelEnvError("Set vercel-project-id to the Vercel project's ID (prj_...).");
  if (team && !TEAM.test(team)) throw new VercelEnvError("vercel-team-id must be the team's ID (team_...).");
  const base = `${(api || "https://api.vercel.com").replace(/\/+$/, "")}`;
  const deps = { token, fetchImpl, sleep };
  const path = `/v9/projects/${encodeURIComponent(project)}`;

  const raw = await call(`${base}${path}${team ? `?teamId=${team}` : ""}`, { ...deps, what: "the project's settings" });
  const settings = projectSettings(raw);
  const listed = await listAll(base, `${path}/domains`, "domains", "the project's domains", team, deps);
  const domains = listed.filter(isObject).map((domain) => pick(domain, DOMAIN_FIELDS));

  const apexes = [
    ...new Set(domains.map((domain) => domain.apexName).filter((apex) => typeof apex === "string" && DOMAIN.test(apex)).map((apex) => apex.toLowerCase())),
  ].filter((apex) => apex !== VERCEL_APEX);
  if (apexes.length > MAX_APEXES) throw new VercelEnvError(`The project has domains under more than ${MAX_APEXES} apex domains, which this copy cannot read yet.`);
  const dns = [];
  for (const apex of apexes) dns.push(await dnsRecords(base, apex, team, deps));

  writeFileSync(file, JSON.stringify({ project, teamId: team || null, settings, domains, dns }), { mode: 0o600 });
  const records = dns.reduce((sum, entry) => sum + (entry.records?.length ?? 0), 0);
  return { domains: domains.length, records, unreadable: dns.filter((entry) => entry.records === null).length };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  try {
    if (!file) throw new VercelEnvError("Usage: vercel-settings.mjs <file>");
    const counts = await exportVercelSettings({
      api: process.env.VERCEL_API_URL,
      project: process.env.VERCEL_PROJECT_ID?.trim(),
      team: process.env.VERCEL_TEAM_ID?.trim(),
      token: process.env.LIFEBOAT_VERCEL_TOKEN?.trim(),
      file,
    });
    process.stdout.write(`${counts.domains} ${counts.records} ${counts.unreadable}\n`);
  } catch (error) {
    console.error(error instanceof VercelEnvError ? error.message : "The Vercel settings copy failed.");
    process.exit(1);
  }
}
