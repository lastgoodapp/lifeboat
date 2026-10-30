import { readFileSync } from "node:fs";
import { signCheckin } from "../src/sign-checkin.mjs";

const secret = process.env.CHECKIN_SECRET?.trim() ?? "";
const url = (process.env.CHECKIN_URL || "https://lastgood.app/api/checkin").trim();
if (!secret) {
  console.log("Check-in skipped: CHECKIN_SECRET is not set.");
  process.exit(0);
}

const kind = process.env.LIFEBOAT_KIND === "restore-test" ? "restore-test" : "backup";
const ok = process.env.LIFEBOAT_OK === "true";
const body = JSON.stringify({
  version: 1,
  ok,
  kind,
  project: (process.env.LIFEBOAT_PROJECT || "").slice(0, 80),
  startedAt: process.env.LIFEBOAT_STARTED_AT || null,
  // The GitHub Actions run this check-in came from, and which attempt, as GitHub numbers them, so LastGood can ask GitHub
  // about this one run rather than any run in the repository (K9). Null outside Actions.
  runId: runNumberEnv("GITHUB_RUN_ID"),
  runAttempt: runNumberEnv("GITHUB_RUN_ATTEMPT"),
  finishedAt: new Date().toISOString(),
  dumpBytes: numberEnv("LIFEBOAT_DUMP_BYTES"),
  storageObjects: numberEnv("LIFEBOAT_STORAGE_OBJECTS"),
  // How a backup read the files: "login" (the storage login), "s3" (hand-set S3 keys) or "none", so a night without
  // the files never reads as a full backup. Null in a restore test.
  storageSource: ["login", "s3", "none"].includes(process.env.LIFEBOAT_STORAGE_SOURCE) ? process.env.LIFEBOAT_STORAGE_SOURCE : null,
  retentionDays: numberEnv("RETENTION_DAYS"),
  deletedObjects: numberEnv("LIFEBOAT_DELETED_OBJECTS"),
  // Null when the run made no code copy, such as a restore test.
  codeBranches: optionalNumberEnv("LIFEBOAT_CODE_BRANCHES"),
  codeTags: optionalNumberEnv("LIFEBOAT_CODE_TAGS"),
  codeBytes: optionalNumberEnv("LIFEBOAT_CODE_BYTES"),
  githubIssues: optionalNumberEnv("LIFEBOAT_GITHUB_ISSUES"),
  githubPullRequests: optionalNumberEnv("LIFEBOAT_GITHUB_PULLS"),
  githubComments: optionalNumberEnv("LIFEBOAT_GITHUB_COMMENTS"),
  // Null when the database has no Supabase Auth users.
  authUsers: optionalNumberEnv("LIFEBOAT_AUTH_USERS"),
  authUsersWithPassword: optionalNumberEnv("LIFEBOAT_AUTH_PASSWORDS"),
  authIdentities: optionalNumberEnv("LIFEBOAT_AUTH_IDENTITIES"),
  // Null when the run made no Supabase setup copy, such as when LIFEBOAT_SUPABASE_TOKEN is not set.
  setupFunctions: optionalNumberEnv("LIFEBOAT_SETUP_FUNCTIONS"),
  setupCronJobs: optionalNumberEnv("LIFEBOAT_SETUP_CRON_JOBS"),
  setupBytes: optionalNumberEnv("LIFEBOAT_SETUP_BYTES"),
  // Null when the run made no Vercel copy, such as when LIFEBOAT_VERCEL_TOKEN is not set. Counts only, never names.
  vercelEnvVars: optionalNumberEnv("LIFEBOAT_VERCEL_ENV_VARS"),
  vercelEnvValues: optionalNumberEnv("LIFEBOAT_VERCEL_ENV_VALUES"),
  // How a backup copied Vercel: "token" (the customer's own LIFEBOAT_VERCEL_TOKEN) or "none" (no token, so no Vercel
  // copy at all), so a status page can say so. Null in a restore test, or when encryption is off.
  vercelSource: kind === "backup" && ["token", "none"].includes(process.env.LIFEBOAT_VERCEL_SOURCE) ? process.env.LIFEBOAT_VERCEL_SOURCE : null,
  // The project's settings copy (B8): its domains, their DNS records, and domains whose DNS the token could not read.
  // Null when the run made no settings copy. Counts only, never domain names.
  vercelDomains: optionalNumberEnv("LIFEBOAT_VERCEL_DOMAINS"),
  vercelDnsRecords: optionalNumberEnv("LIFEBOAT_VERCEL_DNS_RECORDS"),
  vercelDnsUnreadable: optionalNumberEnv("LIFEBOAT_VERCEL_DNS_UNREADABLE"),
  // Each copy a backup uploaded, with its size and SHA-256, so LastGood keeps a record a restore can check against (D18).
  copies: kind === "backup" ? copiesFile(process.env.LIFEBOAT_COPIES_FILE) : [],
  // What a test restore left out with an extension the throwaway database does not offer, such as Vault's secrets on
  // stock Postgres, so a pass does not read as a full restore. Extension names and counts only, never a table's rows.
  notChecked: kind === "restore-test" ? notChecked(process.env.LIFEBOAT_RESTORE_NOT_CHECKED) : [],
  // Which night's database copy a test restore opened, so a pass on an old copy does not read as a pass on today's
  // data. The time from the copy's name only, never the name. Null in a backup, or when the name has no time.
  restoredCopyAt: kind === "restore-test" ? copyTime(process.env.LIFEBOAT_RESTORE_COPY) : null,
  // Each copy a test restore downloaded, with the SHA-256 of the bytes it downloaded, so LastGood can check them against
  // the records it kept when a backup uploaded them (D18). A backup sends an empty list.
  opened: kind === "restore-test" ? openedFile(process.env.LIFEBOAT_OPENED_FILE) : [],
  error: process.env.LIFEBOAT_ERROR ? process.env.LIFEBOAT_ERROR.slice(0, 300) : null,
});

const response = await sendWithRetries();
console.log(`Check-in accepted (${response.status}).`);
const answer = await response.json().catch(() => null);
const copies = answer && typeof answer === "object" ? answer.copies : null;
if (copies && Number.isInteger(copies.reported) && Number.isInteger(copies.recorded) && copies.recorded < copies.reported) {
  console.log(
    `::warning::LastGood recorded ${copies.recorded} of the ${copies.reported} copies this backup reported. A restore refuses a copy with no record, so check that each copy is named for this run and sits under this app's folder.`,
  );
}

function numberEnv(name) {
  const value = Number(process.env[name] ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function optionalNumberEnv(name) {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** A run ID or attempt as GitHub sets it: a whole number from 1, or null when it is missing or not one. */
function runNumberEnv(name) {
  const raw = (process.env[name] ?? "").trim();
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** The time a copy's name starts with, such as 20261029T161700Z, as 2026-10-29T16:17:00Z. Null when it has none. */
function copyTime(name) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(String(name ?? ""));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  // A name such as 20261340T... is not a time, and Date would roll it into another one.
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso.replace("Z", ".000Z") ? iso : null;
}

/** run.sh's "extension tables rows" entries, separated by semicolons. */
function notChecked(value) {
  return String(value ?? "")
    .split(";")
    .map((entry) => entry.trim().split(/\s+/))
    .filter(([extension, tables, rows]) => /^[a-z_]{1,40}$/.test(extension ?? "") && /^\d+$/.test(tables ?? "") && /^\d+$/.test(rows ?? ""))
    .slice(0, 10)
    .map(([extension, tables, rows]) => ({ extension, tables: Number(tables), rows: Number(rows) }));
}

/** The copies run.sh recorded, one per line: key, bytes, SHA-256, version ID. None when the run uploaded nothing. */
function copiesFile(file) {
  let text = "";
  try {
    text = file ? readFileSync(file, "utf8") : "";
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .slice(0, 12)
    .map((line) => {
      const [key, bytes, sha256, versionId] = line.split("\t");
      return { key, bytes: Number(bytes), sha256, versionId: versionId || null };
    });
}

/** The copies run.sh downloaded, one per line: key and SHA-256. At most four, one per part a test restore opens. */
function openedFile(file) {
  let text = "";
  try {
    text = file ? readFileSync(file, "utf8") : "";
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([key, sha256]) => key && key.length <= 300 && /^[0-9a-f]{64}$/.test(sha256 ?? ""))
    .slice(0, 4)
    .map(([key, sha256]) => ({ key, sha256 }));
}

/**
 * What a run that worked should say when only its check-in failed, so a red run in the middle of a LastGood outage
 * doesn't read as a failed backup. Without the check-in LastGood has no checksum record of tonight's copies (D18).
 */
function afterFailedCheckin(runKind) {
  return runKind === "restore-test"
    ? "The test restore itself passed. LastGood has no record of it, so your login won't show tonight's result."
    : "The backup itself finished and tonight's copies were uploaded. LastGood has no checksum record of them, so your login's Open here won't open tonight's copies (the lastgood CLI can, with --unchecked). Earlier nights aren't affected, and the next run checks in as usual.";
}

/**
 * Posts the check-in, trying twice more when LastGood or the network fails on its side (no answer, 408, 429 or 5xx),
 * so a blip doesn't turn a good backup red or leave its copies unrecorded (D18). A refusal (401, 400) is final. Each
 * try is signed afresh, since the signature carries its time. Under two minutes at most, waits included. Exits 2
 * when the last try still did not get through, and 1 on a refusal, which the next run would meet again.
 */
async function sendWithRetries() {
  const waitMs = Number(process.env.LIFEBOAT_CHECKIN_WAIT_MS ?? "") || 5000;
  const waits = [waitMs, 3 * waitMs];
  for (let attempt = 0; ; attempt += 1) {
    let response = null;
    let problem;
    try {
      const timestamp = String(Math.floor(Date.now() / 1000));
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)",
          "X-LastGood-Timestamp": timestamp,
          "X-LastGood-Signature": signCheckin(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response;
      problem = `(${response.status}). ${(await response.text()).slice(0, 180)}`;
    } catch (error) {
      problem = error?.name === "TimeoutError" ? "(no answer within 30 seconds)." : "(LastGood could not be reached).";
    }
    const notThrough = !response || response.status === 408 || response.status === 429 || response.status >= 500;
    if (!notThrough || attempt >= waits.length) {
      console.error(`Check-in failed ${problem}`.trim());
      if (ok) console.error(afterFailedCheckin(kind));
      // 2 when it never got through, so run.sh can take back what only a recorded check-in makes good; 1 when refused.
      process.exit(notThrough ? 2 : 1);
    }
    console.log(`Check-in failed ${problem.trim()} Trying again in ${Math.round(waits[attempt] / 1000)} s.`);
    await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
  }
}
