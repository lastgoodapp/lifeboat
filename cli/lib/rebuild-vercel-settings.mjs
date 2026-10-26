import { isDeepStrictEqual } from "node:util";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { checkVercelToken, defaultSleep, vercelClient, vercelTarget } from "./rebuild-vercel.mjs";
import { checkArchive, counted, run, StepError } from "./rebuild.mjs";

/**
 * The Vercel project's settings, domains and DNS records back into a new project (R4), from the settings the
 * customer's own workflow copied with their Vercel token (B8), on the customer's own computer, with the token from
 * LASTGOOD_VERCEL_TOKEN.
 *
 * Only the settings that differ from the new project's are sent. A domain already on the new project is kept. DNS
 * records go only into a zone this token can read, and only for a name and type whose records there are all in the
 * copy too, so a record changed since the backup is never doubled up with the copy's older one, and a rerun carries
 * on. What Vercel refuses, a domain still to prove, a zone kept elsewhere and the deploy hooks (which get new URLs) are
 * listed for the customer instead. Nothing is ever deleted.
 */

/** The project settings a rebuild sets, as the backup keeps them (lifeboat/scripts/vercel-settings.mjs). */
export const SETTINGS = [
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
const RESOURCES = ["functionDefaultMemoryType", "functionDefaultTimeout", "functionDefaultRegions", "fluid", "buildMachineType", "elasticConcurrencyEnabled"];
/** Record types Vercel's create call takes as a name, a type and a value. SRV and HTTPS take theirs in parts. */
const RECORD_TYPES = new Set(["A", "AAAA", "ALIAS", "CAA", "CNAME", "MX", "TXT", "NS"]);
/** Types whose value is a host name, compared without case or a final dot. */
const HOST_TYPES = new Set(["ALIAS", "CNAME", "MX", "NS"]);
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const VERCEL_APP = /\.vercel\.app$/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(a, b) {
  return isDeepStrictEqual(a ?? null, b ?? null);
}

/** The settings to send: each one the copy has that differs from the new project's. resourceConfig goes whole. */
export function settingsChange(copy, now) {
  const change = {};
  for (const field of SETTINGS) {
    if (field in copy && !same(copy[field], now?.[field])) change[field] = copy[field];
  }
  const resources = isObject(copy.resourceConfig) ? copy.resourceConfig : {};
  const current = isObject(now?.resourceConfig) ? now.resourceConfig : {};
  const differs = RESOURCES.filter((field) => field in resources && !same(resources[field], current[field]));
  if (differs.length > 0) {
    // Sent with the new project's other resource settings as they are, so a partial object never resets them.
    const kept = {};
    for (const field of RESOURCES) if (field in current) kept[field] = current[field];
    change.resourceConfig = { kept, set: Object.fromEntries(differs.map((field) => [field, resources[field]])) };
  }
  const protection = isObject(copy.ssoProtection) ? copy.ssoProtection.deploymentType : undefined;
  if (typeof protection === "string" && !same(protection, now?.ssoProtection?.deploymentType)) change.ssoProtection = { deploymentType: protection };
  return change;
}

/** The change as Vercel takes it. */
function body(change) {
  const sent = { ...change };
  if (sent.resourceConfig) sent.resourceConfig = { ...sent.resourceConfig.kept, ...sent.resourceConfig.set };
  return sent;
}

/** The change's parts, each named, so one Vercel refuses names itself. */
function parts(change) {
  return Object.entries(change).flatMap(([field, value]) =>
    field === "resourceConfig" ? Object.entries(value.set).map(([name, one]) => ({ label: `resourceConfig.${name}`, resource: name, value: one })) : [{ label: field, field, value }],
  );
}

async function patchSettings(client, change) {
  if (Object.keys(change).length === 0) return { applied: [], refused: [] };
  const patch = (sent) => client.call("/v9/projects/{project}", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent) }, "changing the new project's settings");
  const split = parts(change);
  const whole = await patch(body(change));
  if (!whole.refusal) return { applied: split.map((part) => part.label), refused: [] };
  const applied = [];
  const refused = [];
  // resourceConfig goes whole each time, so it carries the parts already taken as well as the one being sent.
  const resources = { ...change.resourceConfig?.kept };
  for (const part of split) {
    const one = await patch(part.resource ? { resourceConfig: { ...resources, [part.resource]: part.value } } : { [part.field]: part.value });
    if (one.refusal) refused.push(`${part.label} (${one.refusal.message})`);
    else {
      applied.push(part.label);
      if (part.resource) resources[part.resource] = part.value;
    }
  }
  return { applied, refused };
}

/** settings.json from the Vercel copy, or null when the copy has none (made before B8, or that night's read failed). */
async function readSettings(archive, work) {
  await checkArchive(archive, "Vercel", { gzip: true });
  const listed = await run("tar", ["-tzf", archive]);
  if (listed.code !== 0) throw new StepError("The Vercel copy did not open.");
  const member = listed.stdout.split("\n").find((line) => line.replace(/^\.\//, "") === "settings.json");
  if (!member) return null;
  const dir = path.join(work, "vercel-settings");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  let copy;
  try {
    // Only settings.json comes out: env.json beside it holds the variables' values.
    const extract = await run("tar", ["-xzf", archive, "-C", dir, "--no-same-owner", member]);
    if (extract.code !== 0) throw new StepError("The Vercel copy did not open.");
    copy = JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"));
  } catch (error) {
    if (error instanceof StepError) throw error;
    throw new StepError("settings.json in the Vercel copy did not read back.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const shaped =
    isObject(copy?.settings) &&
    Array.isArray(copy.domains) &&
    copy.domains.every((domain) => typeof domain?.name === "string" && domain.name) &&
    Array.isArray(copy.dns) &&
    copy.dns.every((zone) => typeof zone?.domain === "string" && (zone.records === null || (Array.isArray(zone.records) && zone.records.every(isObject))));
  if (!shaped) throw new StepError("The Vercel copy's settings.json is not as the backup writes it, so it was not used.");
  return copy;
}

async function listDomains(client) {
  const listed = await client.json(`/v9/projects/{project}/domains?limit=${PAGE_SIZE}`, "listing the new project's domains");
  const domains = listed?.domains;
  if (!Array.isArray(domains)) throw new StepError("Vercel sent something other than a list when listing the new project's domains.");
  if (listed?.pagination?.next) throw new StepError("Vercel sent the new project's domains in more than one page, which this version of rebuild cannot read yet.");
  return domains.filter(isObject);
}

/** A zone's records, every page, or null when this token cannot reach the zone (its DNS is kept elsewhere). */
async function listRecords(client, apex) {
  const records = [];
  let until = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `limit=${PAGE_SIZE}${until === null ? "" : `&until=${until}`}`;
    const { body: answer, refusal } = await client.call(`/v5/domains/${encodeURIComponent(apex)}/records?${query}`, undefined, `listing the DNS records of ${apex}`);
    if (refusal) {
      if (refusal.status === 403 || refusal.status === 404) return null;
      throw new StepError(`Vercel would not answer when listing the DNS records of ${apex}: ${refusal.message}.`);
    }
    if (!Array.isArray(answer?.records)) throw new StepError(`Vercel sent something other than a list when listing the DNS records of ${apex}.`);
    records.push(...answer.records.filter(isObject));
    const next = answer?.pagination?.next;
    if (next === null || next === undefined) return records;
    if (!Number.isFinite(Number(next)) || Number(next) === until) throw new StepError(`Vercel's pages of the DNS records of ${apex} did not move on.`);
    until = Number(next);
  }
  throw new StepError(`Vercel sent the DNS records of ${apex} in more than ${MAX_PAGES} pages, which this version of rebuild cannot read yet.`);
}

function recordName(record) {
  const name = String(record?.name ?? "").trim().toLowerCase();
  return name === "@" ? "" : name.replace(/\.$/, "");
}

function recordType(record) {
  return String(record?.type ?? "").trim().toUpperCase();
}

function recordValue(record) {
  const value = String(record?.value ?? "").trim();
  return HOST_TYPES.has(recordType(record)) ? value.toLowerCase().replace(/\.$/, "") : value;
}

function sameRecord(a, b) {
  if (recordValue(a) !== recordValue(b)) return false;
  return recordType(a) !== "MX" || Number(a?.mxPriority ?? a?.priority ?? 0) === Number(b?.mxPriority ?? b?.priority ?? 0);
}

function label(apex, record) {
  const where = recordName(record) ? `${recordName(record)}.${apex}` : apex;
  const priority = recordType(record) === "MX" && record.mxPriority !== undefined && record.mxPriority !== null ? ` ${record.mxPriority}` : "";
  return `${where} ${recordType(record)}${priority} ${String(record?.value ?? "").trim()}`;
}

/**
 * What to do with one zone's records from the copy, against the zone now. Records are grouped by name and type: a
 * group whose records in the zone are all in the copy gets the copy's missing ones; a group with a record the copy
 * does not have was changed since the backup, so it is left as it is and named.
 */
export function planRecords(apex, copied, now) {
  const result = { add: [], kept: 0, changed: [], byHand: [] };
  const groups = new Map();
  for (const record of copied) {
    if (!RECORD_TYPES.has(recordType(record))) {
      result.byHand.push(label(apex, record));
      continue;
    }
    const key = `${recordName(record)} ${recordType(record)}`;
    if (!groups.has(key)) groups.set(key, { name: recordName(record), type: recordType(record), records: [] });
    groups.get(key).records.push(record);
  }
  for (const { name, type, records } of groups.values()) {
    const there = now.filter((record) => recordName(record) === name && recordType(record) === type);
    if (there.some((record) => !records.some((copy) => sameRecord(record, copy)))) {
      result.changed.push(`${name ? `${name}.${apex}` : apex} ${type}`);
      continue;
    }
    for (const record of records) {
      if (there.some((have) => sameRecord(have, record))) result.kept += 1;
      else if (!result.add.some((planned) => recordName(planned) === name && recordType(planned) === type && sameRecord(planned, record))) result.add.push(record);
    }
  }
  return result;
}

function recordBody(record) {
  const sent = { name: recordName(record), type: recordType(record), value: String(record.value ?? "").trim() };
  if (Number.isInteger(record.ttl) && record.ttl >= 60) sent.ttl = record.ttl;
  if (sent.type === "MX" && Number.isInteger(record.mxPriority)) sent.mxPriority = record.mxPriority;
  if (typeof record.comment === "string" && record.comment) sent.comment = record.comment.slice(0, 500);
  return sent;
}

/**
 * Sets the copy's project settings on the new Vercel project, adds its domains and their DNS records where this token
 * reaches them, then lists what the customer does by hand.
 */
export async function rebuildVercelSettings({ archive, project, team, token, work, say, todo = say, api, fetchImpl = fetch, sleep = defaultSleep }) {
  const secret = checkVercelToken(token);
  const target = vercelTarget(project, team);
  const client = vercelClient({ api, ...target, token: secret, fetchImpl, sleep });
  const copy = await readSettings(archive, work);
  if (!copy) {
    todo("This Vercel copy has no project settings or domains: it was made before the backup copied them, or that night's settings copy failed. Set them by hand as the old project had them, in the project's settings in Vercel.");
    return "no settings in the copy";
  }
  let toDo = 0;
  const later = (line) => {
    toDo += 1;
    todo(line);
  };

  // Settings: only what differs.
  const info = await client.json("/v9/projects/{project}", "reading the new project");
  const change = settingsChange(copy.settings, info);
  const settings = await patchSettings(client, change);
  if (settings.applied.length > 0) say(`Project settings set as the old project had them: ${settings.applied.join(", ")}.`);
  else if (settings.refused.length === 0) say("The new project's settings already match the copy's.");
  if (settings.refused.length > 0) later(`Vercel did not take these settings, most likely because of the new project's plan. Set them by hand in the project's settings: ${settings.refused.join("; ")}.`);
  const branch = copy.settings.link?.productionBranch;
  if (typeof branch === "string" && branch && branch !== info?.link?.productionBranch) {
    later(`Build production from the ${branch} branch, as the old project did: set it as the production branch in the project's settings in Vercel.`);
  }
  const hooks = Array.isArray(copy.settings.link?.deployHooks) ? copy.settings.link.deployHooks.filter((hook) => typeof hook?.name === "string") : [];
  if (hooks.length > 0) {
    later(`Make these deploy hooks again in the project's Git settings: ${hooks.map((hook) => (hook.ref ? `${hook.name} (${hook.ref})` : hook.name)).join(", ")}. Each gets a new URL, so change anything that called the old one.`);
  }
  const crons = Array.isArray(copy.settings.crons) ? copy.settings.crons.length : 0;
  if (crons > 0) say(`${counted(crons, "cron job")} come back with the code: Vercel reads them from vercel.json when it deploys.`);

  // Domains: each one not on the new project yet, a redirect after the domain it points at.
  const before = await listDomains(client);
  const on = new Set(before.map((domain) => String(domain.name).toLowerCase()));
  const own = copy.domains.filter((domain) => VERCEL_APP.test(domain.name));
  const wanted = copy.domains.filter((domain) => !VERCEL_APP.test(domain.name)).sort((a, b) => Number(Boolean(a.redirect)) - Number(Boolean(b.redirect)));
  const added = [];
  const kept = [];
  const custom = [];
  const refused = [];
  for (const domain of wanted) {
    if (typeof domain.customEnvironmentId === "string" && domain.customEnvironmentId) {
      custom.push(domain.name);
      continue;
    }
    if (on.has(domain.name.toLowerCase())) {
      kept.push(domain.name);
      continue;
    }
    const sent = { name: domain.name };
    if (typeof domain.gitBranch === "string" && domain.gitBranch) sent.gitBranch = domain.gitBranch;
    if (typeof domain.redirect === "string" && domain.redirect) {
      sent.redirect = domain.redirect;
      if (Number.isInteger(domain.redirectStatusCode)) sent.redirectStatusCode = domain.redirectStatusCode;
    }
    const { refusal } = await client.call("/v10/projects/{project}/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sent) }, `adding ${domain.name}`);
    if (refusal) refused.push({ name: domain.name, reason: refusal.message });
    else {
      added.push(domain.name);
      on.add(domain.name.toLowerCase());
    }
  }
  const after = wanted.length > 0 ? await listDomains(client) : before;
  const listedNow = new Map(after.map((domain) => [String(domain.name).toLowerCase(), domain]));
  // A POST that reached Vercel before the network dropped is refused on its retry: one now listed counts as added.
  for (const item of refused.filter(({ name }) => listedNow.has(name.toLowerCase()))) {
    added.push(item.name);
    refused.splice(refused.indexOf(item), 1);
  }
  const missing = added.filter((name) => !listedNow.has(name.toLowerCase()));
  if (missing.length > 0) throw new StepError(`The new project does not list ${missing.join(", ")} after adding ${missing.length === 1 ? "it" : "them"}.`);
  if (added.length > 0) say(`Added ${counted(added.length, "domain")} to the new project: ${added.join(", ")}.`);
  if (kept.length > 0) say(`Already on the new project, kept as ${kept.length === 1 ? "it is" : "they are"}: ${kept.join(", ")}.`);
  if (own.length > 0) say(`Left out ${own.map((domain) => domain.name).join(", ")}: the new project has its own .vercel.app address.`);
  if (custom.length > 0) later(`Add these domains once the new project has the custom environment they were for: ${custom.join(", ")}.`);
  if (refused.length > 0) {
    later(
      `Vercel did not add these domains: ${refused.map(({ name, reason }) => `${name} (${reason})`).join("; ")}. A domain still on the old project has to come off it first. Then run this again: the domains already added are kept.`,
    );
  }
  const unproved = wanted
    .map((domain) => listedNow.get(domain.name.toLowerCase()))
    .filter((domain) => domain && (domain.verified === false || domain.verified === "false"));
  if (unproved.length > 0) {
    const challenges = unproved.map((domain) => {
      const ways = (Array.isArray(domain.verification) ? domain.verification : []).filter(isObject).map((way) => `a ${way.type} record on ${way.domain} with the value ${way.value}`);
      return `${domain.name}: ${ways.length > 0 ? ways.join(", or ") : "see the domain in the project's settings"}`;
    });
    later(`Prove these domains are yours, so the new project can serve them. Add the record where each domain's DNS is kept, then verify it in the project's domain settings: ${challenges.join("; ")}.`);
  }

  // DNS records: into zones this token reaches, never over one changed since the backup.
  let addedRecords = 0;
  let keptRecords = 0;
  for (const zone of copy.dns) {
    if (zone.records === null) {
      later(`The backup could not read the DNS records of ${zone.domain}, most likely because its DNS is kept outside Vercel. Check them where they are kept, and point the domain at the new project there.`);
      continue;
    }
    const now = await listRecords(client, zone.domain);
    if (now === null) {
      if (zone.records.length > 0) later(`The DNS of ${zone.domain} is not in this Vercel team, so add these records where it is kept now: ${zone.records.map((record) => label(zone.domain, record)).join("; ")}.`);
      continue;
    }
    const planned = planRecords(zone.domain, zone.records, now);
    keptRecords += planned.kept;
    const put = [];
    const failed = [];
    for (const record of planned.add) {
      // Not retried: a create that reached Vercel before the network dropped would make the record twice.
      const { refusal } = await client.call(`/v2/domains/${encodeURIComponent(zone.domain)}/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(recordBody(record)), retry: false }, `adding a DNS record to ${zone.domain}`);
      if (refusal) failed.push({ record, reason: refusal.message });
      else put.push(record);
    }
    if (planned.add.length > 0) {
      const listed = await listRecords(client, zone.domain);
      const there = (record) => (listed ?? []).some((have) => recordType(have) === recordType(record) && recordName(have) === recordName(record) && sameRecord(have, record));
      for (const item of failed.filter(({ record }) => there(record))) {
        put.push(item.record);
        failed.splice(failed.indexOf(item), 1);
      }
      const absent = put.filter((record) => !there(record));
      if (absent.length > 0) throw new StepError(`${zone.domain} does not list ${absent.map((record) => label(zone.domain, record)).join("; ")} after adding ${absent.length === 1 ? "it" : "them"}.`);
    }
    addedRecords += put.length;
    if (put.length > 0) say(`Added ${counted(put.length, "DNS record")} to ${zone.domain}: ${put.map((record) => label(zone.domain, record)).join("; ")}.`);
    if (planned.changed.length > 0) {
      later(`These DNS records in ${zone.domain} changed since the backup, so the zone's are kept and the copy's were not added: ${planned.changed.join(", ")}. Check they point at the new project.`);
    }
    if (planned.byHand.length > 0) later(`Add these DNS records to ${zone.domain} by hand, since Vercel takes their parts separately: ${planned.byHand.join("; ")}.`);
    if (failed.length > 0) {
      later(`Vercel did not add these DNS records: ${failed.map(({ record, reason }) => `${label(zone.domain, record)} (${reason})`).join("; ")}. Add them by hand, or run this again: the records already added are kept.`);
    }
  }
  if (keptRecords > 0) say(`Already in the zones as the copy has them: ${counted(keptRecords, "DNS record")}.`);

  return [
    counted(settings.applied.length, "setting"),
    counted(added.length + kept.length, "domain"),
    counted(addedRecords + keptRecords, "DNS record"),
    toDo > 0 ? `${toDo} to do by hand` : "",
  ]
    .filter(Boolean)
    .join(", ");
}
