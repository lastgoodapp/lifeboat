import { readFileSync } from "node:fs";
import { signCheckin } from "../src/sign-checkin.mjs";

const secret = process.env.CHECKIN_SECRET?.trim() ?? "";
const url = (process.env.CHECKIN_URL || "https://lastgood.app/api/checkin").trim();
if (!secret) {
  console.log("Check-in skipped: CHECKIN_SECRET is not set.");
  process.exit(0);
}

const kind = process.env.LIFEBOAT_KIND === "restore-test" ? "restore-test" : "backup";
const body = JSON.stringify({
  version: 1,
  ok: process.env.LIFEBOAT_OK === "true",
  kind,
  project: (process.env.LIFEBOAT_PROJECT || "").slice(0, 80),
  startedAt: process.env.LIFEBOAT_STARTED_AT || null,
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
  error: process.env.LIFEBOAT_ERROR ? process.env.LIFEBOAT_ERROR.slice(0, 300) : null,
});

const timestamp = String(Math.floor(Date.now() / 1000));
const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)",
    "X-LastGood-Timestamp": timestamp,
    "X-LastGood-Signature": signCheckin(secret, timestamp, body),
  },
  body,
});

if (!response.ok) {
  const text = (await response.text()).slice(0, 180);
  console.error(`Check-in failed (${response.status}). ${text}`);
  process.exit(1);
}
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
