import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CALL_TIMEOUT_MS, exportVercelEnv } from "../scripts/vercel-env.mjs";
import { exportVercelSettings, projectSettings } from "../scripts/vercel-settings.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const PROJECT = "prj_unitTestProject01";
const TEAM = "team_unitTestTeam01";
const TOKEN = "vercel-unit-test-token-must-stay-hidden";
const API = "https://api.example.invalid";

// Made-up values. None of them is a real secret.
const PLAIN_VALUE = "https://notes.example";
const ENCRYPTED_VALUE = "unit-test-encrypted-value-must-stay-hidden";
// Secrets Vercel's project answer carries that the settings copy must leave out.
const HOOK_SECRET = "unitTestDeployHookSecretMustStayOut";
const BYPASS_SECRET = "unitTestBypassSecretMustStayOut01";

const ENVS = [
  { id: "env_plain1", key: "NEXT_PUBLIC_SITE_URL", type: "plain", value: PLAIN_VALUE, target: ["production", "preview"] },
  { id: "env_enc1", key: "STRIPE_WEBHOOK_SECRET", type: "encrypted", value: "eyJ2IjoiZW5jcnlwdGVkIn0", target: ["production"], comment: "from Stripe" },
  { id: "env_sens1", key: "SUPABASE_SERVICE_ROLE_KEY", type: "sensitive", value: "", target: ["production"] },
  { id: "env_sys1", key: "VERCEL_URL", type: "system", value: "", target: ["production", "preview", "development"] },
  { id: "env_pre1", key: "PREVIEW_ONLY_FLAG", type: "encrypted", value: "eyJ2Ijoib3RoZXIifQ", target: "preview", gitBranch: "staging" },
];

/** Vercel's project answer, cut down: what a rebuild needs, beside things the copy must drop. */
const PROJECT_JSON = {
  id: PROJECT,
  name: "notes",
  framework: "nextjs",
  nodeVersion: "22.x",
  buildCommand: null,
  installCommand: "npm ci",
  rootDirectory: "web",
  directoryListing: false,
  resourceConfig: { functionDefaultTimeout: 60, functionDefaultRegions: ["syd1"], futureField: "not on the list" },
  ssoProtection: { deploymentType: "preview" },
  link: {
    type: "github",
    org: "acme",
    repo: "notes",
    repoId: 123,
    productionBranch: "main",
    gitCredentialId: "cred_unitTest",
    deployHooks: [{ id: "hook_1", name: "rebuild", ref: "main", url: `https://api.vercel.com/v1/integrations/deploy/${PROJECT}/${HOOK_SECRET}` }],
  },
  crons: { enabledAt: 1700000000000, deploymentId: "dpl_unitTest", definitions: [{ host: "notes.vercel.app", path: "/api/cron/nightly", schedule: "0 3 * * *" }] },
  env: [{ key: "STRIPE_WEBHOOK_SECRET", type: "encrypted", value: ENCRYPTED_VALUE }],
  protectionBypass: { [BYPASS_SECRET]: { scope: "automation-bypass", createdAt: 1700000000000 } },
  passwordProtection: { deploymentType: "all" },
  latestDeployments: [{ id: "dpl_unitTest", url: "notes-abc.vercel.app" }],
};

const DOMAINS = [
  { name: "notes.example", apexName: "notes.example", projectId: PROJECT, verified: true, createdAt: 1, verification: [{ type: "TXT", value: "vc-domain-verify" }] },
  { name: "www.notes.example", apexName: "notes.example", redirect: "notes.example", redirectStatusCode: 308, verified: true },
  { name: "notes-app.vercel.app", apexName: "vercel.app", verified: true },
  { name: "shop.elsewhere.example", apexName: "elsewhere.example", gitBranch: "shop", verified: true },
];

const RECORDS = [
  { id: "rec_1", slug: "x", name: "", type: "ALIAS", value: "cname.vercel-dns.com.", ttl: 60, creator: "system", createdAt: 1 },
  { id: "rec_2", name: "", type: "MX", value: "mail.notes.example.", mxPriority: 10, ttl: 3600 },
  { id: "rec_3", name: "_dmarc", type: "TXT", value: "v=DMARC1; p=none", comment: "mail" },
];

/** Answers for a fake Vercel API, keyed by method and path. */
function answers(override = {}) {
  return {
    [`GET /v9/projects/${PROJECT}`]: { json: PROJECT_JSON },
    [`GET /v9/projects/${PROJECT}/domains`]: { json: { domains: DOMAINS, pagination: { count: 4, next: null, prev: null } } },
    [`GET /v5/domains/notes.example/records`]: { json: { records: RECORDS, pagination: { count: 3, next: null, prev: null } } },
    [`GET /v10/projects/${PROJECT}/env`]: { json: { envs: ENVS } },
    [`GET /v1/projects/${PROJECT}/env/env_enc1`]: { json: { key: "STRIPE_WEBHOOK_SECRET", type: "encrypted", decrypted: true, value: ENCRYPTED_VALUE } },
    // Vercel can still answer without a readable value; the copy keeps the name and says so.
    [`GET /v1/projects/${PROJECT}/env/env_pre1`]: { json: { key: "PREVIEW_ONLY_FLAG", type: "encrypted", decrypted: false, value: "eyJ2Ijoib3RoZXIifQ" } },
    ...override,
  };
}

function fakeFetch(routes, seen = []) {
  return async (url) => {
    const { pathname, search } = new URL(url);
    seen.push({ pathname, search });
    const answer = routes[`GET ${pathname}`];
    if (!answer) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
  };
}

const noSleep = async () => {};

function tempFile(name = "env.json") {
  return path.join(mkdtempSync(path.join(tmpdir(), "lg-vercel-")), name);
}

/** fakeFetch, also noting each request's method, body and Authorization header. */
function recording(routes, calls) {
  const answer = fakeFetch(routes);
  return async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body, authorization: init.headers?.Authorization });
    return answer(url);
  };
}

test("the copy keeps every name, every value Vercel returns, and says which values it could not have", async () => {
  const file = tempFile();
  const seen = [];
  const counts = await exportVercelEnv({ api: API, project: PROJECT, team: TEAM, token: TOKEN, file, fetchImpl: fakeFetch(answers(), seen), sleep: noSleep });
  assert.deepEqual(counts, { variables: 5, withValue: 2, withoutValue: 3 });
  assert.equal(statSync(file).mode & 0o777, 0o600, "only the runner's user can read the file");

  const { project, teamId, variables } = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(project, PROJECT);
  assert.equal(teamId, TEAM);
  const byKey = Object.fromEntries(variables.map((entry) => [entry.key, entry]));
  assert.equal(byKey.NEXT_PUBLIC_SITE_URL.value, PLAIN_VALUE);
  assert.deepEqual(byKey.NEXT_PUBLIC_SITE_URL.target, ["production", "preview"]);
  assert.equal(byKey.STRIPE_WEBHOOK_SECRET.value, ENCRYPTED_VALUE);
  assert.equal(byKey.STRIPE_WEBHOOK_SECRET.comment, "from Stripe");
  assert.equal(byKey.SUPABASE_SERVICE_ROLE_KEY.value, null);
  assert.match(byKey.SUPABASE_SERVICE_ROLE_KEY.note, /never returns this value\. Keep it yourself: LastGood cannot restore it\./);
  assert.equal(byKey.VERCEL_URL.value, null);
  assert.match(byKey.VERCEL_URL.note, /Set by Vercel itself/);
  assert.equal(byKey.PREVIEW_ONLY_FLAG.value, null, "a value Vercel sent still encrypted is not kept");
  assert.deepEqual(byKey.PREVIEW_ONLY_FLAG.target, ["preview"]);
  assert.equal(byKey.PREVIEW_ONLY_FLAG.gitBranch, "staging");

  // Only the list and the two encrypted variables are fetched, each for the team. Sensitive and system values are never asked for.
  assert.deepEqual(
    seen.map((call) => call.pathname),
    [`/v10/projects/${PROJECT}/env`, `/v1/projects/${PROJECT}/env/env_enc1`, `/v1/projects/${PROJECT}/env/env_pre1`],
  );
  assert.ok(seen.every((call) => call.search === `?teamId=${TEAM}`));
});

test("an expired token, a wrong project and a rate limit each say what to do, and never print the token", async () => {
  const fails = async (routes, extra = {}) => {
    await assert.rejects(
      exportVercelEnv({ api: API, project: PROJECT, token: TOKEN, file: tempFile(), fetchImpl: fakeFetch(routes), sleep: noSleep, ...extra }),
      (error) => {
        assert.ok(!error.message.includes(TOKEN));
        return true;
      },
    );
  };
  await assert.rejects(
    exportVercelEnv({ api: API, project: PROJECT, token: TOKEN, file: tempFile(), fetchImpl: fakeFetch(answers({ [`GET /v10/projects/${PROJECT}/env`]: { json: {}, status: 401 } })), sleep: noSleep }),
    /did not accept LIFEBOAT_VERCEL_TOKEN\. It may have expired or been revoked/,
  );
  await assert.rejects(
    exportVercelEnv({ api: API, project: "prj_someoneElse", token: TOKEN, file: tempFile(), fetchImpl: fakeFetch(answers()), sleep: noSleep }),
    /Check vercel-project-id, and vercel-team-id for a team project\./,
  );
  await fails(answers({ [`GET /v10/projects/${PROJECT}/env`]: { json: {}, status: 403 } }));

  let calls = 0;
  const waits = [];
  const limited = async (url) => {
    calls += 1;
    if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "7" } });
    return fakeFetch(answers())(url);
  };
  const counts = await exportVercelEnv({ api: API, project: PROJECT, token: TOKEN, file: tempFile(), fetchImpl: limited, sleep: async (ms) => waits.push(ms) });
  assert.equal(counts.variables, 5);
  assert.deepEqual(waits, [7000]);
});

test("a bad project or team ID, or a list Vercel sent in pages, stops before anything is written", async () => {
  const neverCalled = async () => assert.fail("Vercel should not be called");
  await assert.rejects(exportVercelEnv({ project: "", token: TOKEN, file: tempFile(), fetchImpl: neverCalled }), /Set vercel-project-id/);
  await assert.rejects(exportVercelEnv({ project: "../x", token: TOKEN, file: tempFile(), fetchImpl: neverCalled }), /Set vercel-project-id/);
  await assert.rejects(exportVercelEnv({ project: PROJECT, team: "acme", token: TOKEN, file: tempFile(), fetchImpl: neverCalled }), /vercel-team-id must be the team's ID/);
  await assert.rejects(exportVercelEnv({ project: PROJECT, token: "", file: tempFile(), fetchImpl: neverCalled }), /Set LIFEBOAT_VERCEL_TOKEN/);

  const file = tempFile();
  await assert.rejects(
    exportVercelEnv({
      api: API,
      project: PROJECT,
      token: TOKEN,
      file,
      fetchImpl: fakeFetch(answers({ [`GET /v10/projects/${PROJECT}/env`]: { json: { envs: ENVS, pagination: { count: 5, next: 1700000000000, prev: null } } } })),
      sleep: noSleep,
    }),
    /more than one page/,
  );
  assert.equal(existsSync(file), false);
});

test("the settings copy keeps what a rebuild needs, and leaves out deploy hook URLs, bypass secrets and environment variables", async () => {
  const file = tempFile("settings.json");
  const calls = [];
  const counts = await exportVercelSettings({ api: API, project: PROJECT, team: TEAM, token: TOKEN, file, fetchImpl: recording(answers(), calls), sleep: noSleep });
  assert.deepEqual(counts, { domains: 4, records: 3, unreadable: 1 });
  assert.equal(statSync(file).mode & 0o777, 0o600, "only the runner's user can read the file");

  const text = readFileSync(file, "utf8");
  for (const kept of [HOOK_SECRET, BYPASS_SECRET, ENCRYPTED_VALUE, "STRIPE_WEBHOOK_SECRET", "gitCredentialId", "latestDeployments", "passwordProtection", "futureField", "vc-domain-verify"]) {
    assert.ok(!text.includes(kept), `${kept} is not in the copy`);
  }
  const copy = JSON.parse(text);
  assert.equal(copy.project, PROJECT);
  assert.equal(copy.teamId, TEAM);
  assert.deepEqual(copy.settings, {
    id: PROJECT,
    name: "notes",
    framework: "nextjs",
    nodeVersion: "22.x",
    buildCommand: null,
    installCommand: "npm ci",
    rootDirectory: "web",
    directoryListing: false,
    resourceConfig: { functionDefaultTimeout: 60, functionDefaultRegions: ["syd1"] },
    ssoProtection: { deploymentType: "preview" },
    link: { type: "github", org: "acme", repo: "notes", repoId: 123, productionBranch: "main", deployHooks: [{ name: "rebuild", ref: "main" }] },
    crons: [{ path: "/api/cron/nightly", schedule: "0 3 * * *" }],
  });
  assert.deepEqual(
    copy.domains.map((domain) => domain.name),
    ["notes.example", "www.notes.example", "notes-app.vercel.app", "shop.elsewhere.example"],
  );
  assert.deepEqual(copy.domains[1], { name: "www.notes.example", apexName: "notes.example", redirect: "notes.example", redirectStatusCode: 308, verified: true });
  assert.deepEqual(copy.dns[0], {
    domain: "notes.example",
    records: [
      { name: "", type: "ALIAS", value: "cname.vercel-dns.com.", ttl: 60 },
      { name: "", type: "MX", value: "mail.notes.example.", ttl: 3600, mxPriority: 10 },
      { name: "_dmarc", type: "TXT", value: "v=DMARC1; p=none", comment: "mail" },
    ],
    note: null,
  });
  assert.equal(copy.dns[1].domain, "elsewhere.example");
  assert.equal(copy.dns[1].records, null);
  assert.match(copy.dns[1].note, /most likely because its DNS is kept outside Vercel\. .*LastGood cannot restore them\./);
  assert.equal(copy.dns.length, 2, "vercel.app's DNS is Vercel's own, so it is not asked for");

  // Only GETs, with the token only in the Authorization header, each for the team.
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [`/v9/projects/${PROJECT}`, `/v9/projects/${PROJECT}/domains`, "/v5/domains/notes.example/records", "/v5/domains/elsewhere.example/records"],
  );
  for (const call of calls) {
    assert.equal(call.method ?? "GET", "GET");
    assert.equal(call.body, undefined);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.ok(!call.url.includes(TOKEN));
    assert.equal(new URL(call.url).searchParams.get("teamId"), TEAM);
  }
});

test("the settings copy reads every page of domains and DNS records, and stops on pages that do not move on", async () => {
  const NEXT = 1700000000000;
  const paged = (pages) => async (url) => {
    const { pathname, searchParams } = new URL(url);
    const page = pages[`${pathname} ${searchParams.get("until") ?? ""}`];
    if (!page) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  };
  const pages = {
    [`/v9/projects/${PROJECT} `]: { name: "notes" },
    [`/v9/projects/${PROJECT}/domains `]: { domains: [DOMAINS[0]], pagination: { next: NEXT } },
    [`/v9/projects/${PROJECT}/domains ${NEXT}`]: { domains: [DOMAINS[1]], pagination: { next: null } },
    ["/v5/domains/notes.example/records "]: { records: [RECORDS[0]], pagination: { next: NEXT } },
    [`/v5/domains/notes.example/records ${NEXT}`]: { records: RECORDS.slice(1), pagination: { next: null } },
  };
  const file = tempFile("settings.json");
  const counts = await exportVercelSettings({ api: API, project: PROJECT, token: TOKEN, file, fetchImpl: paged(pages), sleep: noSleep });
  assert.deepEqual(counts, { domains: 2, records: 3, unreadable: 0 });

  const stuck = { ...pages, [`/v9/projects/${PROJECT}/domains ${NEXT}`]: { domains: [DOMAINS[1]], pagination: { next: NEXT } } };
  const stuckFile = tempFile("settings.json");
  await assert.rejects(
    exportVercelSettings({ api: API, project: PROJECT, token: TOKEN, file: stuckFile, fetchImpl: paged(stuck), sleep: noSleep }),
    /Vercel's pages of the project's domains did not move on/,
  );
  assert.equal(existsSync(stuckFile), false);
});

test("the settings copy fails on a token Vercel refuses or a DNS read that errors, and checks its inputs before calling Vercel", async () => {
  const file = tempFile("settings.json");
  await assert.rejects(
    exportVercelSettings({ api: API, project: PROJECT, token: TOKEN, file, fetchImpl: fakeFetch(answers({ [`GET /v9/projects/${PROJECT}`]: { json: {}, status: 401 } })), sleep: noSleep }),
    (error) => /did not accept LIFEBOAT_VERCEL_TOKEN/.test(error.message) && !error.message.includes(TOKEN),
  );
  // Only "not there" (403 or 404) means a domain's DNS is kept elsewhere. Vercel failing is a failed copy.
  await assert.rejects(
    exportVercelSettings({
      api: API,
      project: PROJECT,
      token: TOKEN,
      file,
      fetchImpl: fakeFetch(answers({ "GET /v5/domains/notes.example/records": { json: {}, status: 500 } })),
      sleep: noSleep,
    }),
    /Vercel answered 500 when reading the DNS records of notes\.example\./,
  );
  assert.equal(existsSync(file), false);

  const neverCalled = async () => assert.fail("Vercel should not be called");
  await assert.rejects(exportVercelSettings({ project: "../x", token: TOKEN, file, fetchImpl: neverCalled }), /Set vercel-project-id/);
  await assert.rejects(exportVercelSettings({ project: PROJECT, team: "acme", token: TOKEN, file, fetchImpl: neverCalled }), /vercel-team-id must be the team's ID/);
  await assert.rejects(exportVercelSettings({ project: PROJECT, token: "", file, fetchImpl: neverCalled }), /Set LIFEBOAT_VERCEL_TOKEN/);
  assert.throws(() => projectSettings([PROJECT_JSON]), /something other than a project/);
});

// The whole backup, with fake tools and a fake Vercel API on a local port.
function fakeTools(dir) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
echo "$*" >> "${dir}/aws.log"
case " $* " in
  *" s3api "*) printf '%s\\n' '{"Contents":[]}' ;;
  *" s3 cp "*)
    for last; do :; done
    prev=""; src=""
    for arg in "$@"; do [ "$arg" = "$last" ] && src="$prev"; prev="$arg"; done
    key="\${last#s3://*/}"
    mkdir -p "${uploads}/$(dirname "$key")"
    cp "$src" "${uploads}/$key"
    ;;
esac
exit 0
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
  return uploads;
}

async function fakeVercel(routes) {
  const checkins = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      if (request.url === "/checkin") {
        checkins.push(JSON.parse(body));
        response.writeHead(202).end("{}");
        return;
      }
      const answer = await fakeFetch(request.headers.authorization === `Bearer ${TOKEN}` ? routes : {})(`http://localhost${request.url}`);
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(await answer.text());
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, checkins };
}

async function backupWithVercel(routes, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-vercel-run-"));
  const uploads = fakeTools(dir);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const api = await fakeVercel(routes);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          HOME: dir,
          LIFEBOAT_MODE: "backup",
          DATABASE_URL: "postgres://example.invalid/db",
          S3_BUCKET: "bucket",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          S3_PREFIX: "lifeboat",
          LIFEBOAT_PUBLIC_KEY: publicKey,
          LIFEBOAT_MANAGE_RETENTION: "false",
          LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
          CHECKIN_SECRET: "unit-test-checkin-secret",
          CHECKIN_URL: `http://127.0.0.1:${api.port}/checkin`,
          LIFEBOAT_WORKDIR: work,
          LIFEBOAT_VERCEL_TOKEN: TOKEN,
          VERCEL_PROJECT_ID: PROJECT,
          VERCEL_API_URL: `http://127.0.0.1:${api.port}`,
          ...extra,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, dir, uploads, keyFile, work, checkins: api.checkins };
  } finally {
    api.server.close();
  }
}

/** What a reader of the job log sees: the runner consumes ::add-mask:: lines instead of printing them. */
function shown(text) {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

test("backup uploads the Vercel environment variables in one age archive under vercel/, and never prints a value or the token", async () => {
  const run = await backupWithVercel(answers());
  assert.equal(run.status, 0, run.stderr);
  const vercelDir = path.join(run.uploads, "lifeboat", "vercel");
  const files = readdirSync(vercelDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}Z\.tar\.gz\.age$/);
  assert.match(run.stdout, /Vercel: 5 environment variables, 2 with their values\./);
  assert.match(run.stdout, /::warning::3 Vercel environment variables are copied by name only\. .*LastGood cannot restore them\./);
  const log = shown(run.stdout) + run.stderr;
  assert.ok(run.stdout.includes(`::add-mask::${TOKEN}`), "the token is masked");
  for (const secret of [TOKEN, ENCRYPTED_VALUE, PLAIN_VALUE]) assert.ok(!log.includes(secret), "no value or token in the log");

  // Open it the way a customer would: age with the private key, then tar.
  const out = path.join(run.dir, "opened");
  mkdirSync(out);
  execFileSync("age", ["--decrypt", "--identity", run.keyFile, "--output", path.join(out, "vercel.tar.gz"), path.join(vercelDir, files[0])]);
  execFileSync("tar", ["-xzf", "vercel.tar.gz"], { cwd: out });
  const opened = JSON.parse(readFileSync(path.join(out, "env.json"), "utf8"));
  assert.equal(opened.variables.find((entry) => entry.key === "STRIPE_WEBHOOK_SECRET").value, ENCRYPTED_VALUE);
  // The settings, domains and DNS records ride in the same archive (B8).
  const settings = JSON.parse(readFileSync(path.join(out, "settings.json"), "utf8"));
  assert.equal(settings.settings.framework, "nextjs");
  assert.equal(settings.domains.length, 4);
  assert.equal(settings.dns[0].records.length, 3);
  assert.match(run.stdout, /Vercel settings: the project, 4 domains, 3 DNS records\./);
  assert.match(run.stdout, /::warning::This token cannot read the DNS records of 1 of the project's domains, .*LastGood cannot restore them\./);
  for (const secret of [HOOK_SECRET, BYPASS_SECRET]) assert.ok(!log.includes(secret));

  // Nothing readable is left on the runner, and the check-in carries counts, never names or values.
  assert.equal(existsSync(path.join(run.work, "vercel")), false);
  assert.equal(existsSync(path.join(run.work, "vercel.tar.gz")), false);
  assert.equal(run.checkins.length, 1);
  assert.equal(run.checkins[0].ok, true);
  assert.equal(run.checkins[0].vercelEnvVars, 5);
  assert.equal(run.checkins[0].vercelEnvValues, 2);
  assert.equal(run.checkins[0].vercelSource, "token");
  assert.equal(run.checkins[0].vercelDomains, 4);
  assert.equal(run.checkins[0].vercelDnsRecords, 3);
  assert.equal(run.checkins[0].vercelDnsUnreadable, 1);
  for (const name of ["STRIPE_WEBHOOK_SECRET", "notes.example", "acme"]) assert.ok(!JSON.stringify(run.checkins[0]).includes(name));
});

test("without LIFEBOAT_VERCEL_TOKEN the Vercel copy is skipped, and with encryption off it is never uploaded in the clear", async () => {
  const skipped = await backupWithVercel(answers(), { LIFEBOAT_VERCEL_TOKEN: "" });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /Vercel copy skipped: LIFEBOAT_VERCEL_TOKEN is not set, so this backup has no copy of the Vercel project's settings, domains, DNS records or environment variables\./);
  assert.equal(existsSync(path.join(skipped.uploads, "lifeboat", "vercel")), false);
  assert.equal(skipped.checkins[0].vercelEnvVars, null);
  assert.equal(skipped.checkins[0].vercelDomains, null);
  assert.equal(skipped.checkins[0].vercelSource, "none", "so the status page can say there is no Vercel copy");

  const plain = await backupWithVercel(answers(), { LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /::warning::Vercel copy skipped: encryption is off, and the environment variable values are secrets\./);
  assert.equal(existsSync(path.join(plain.uploads, "lifeboat", "vercel")), false);
  assert.equal(plain.checkins[0].vercelSource, null);
});

test("a Vercel token that cannot read the project fails the run by name, after the other copies, and uploads nothing for Vercel", async () => {
  const run = await backupWithVercel(answers({ [`GET /v10/projects/${PROJECT}/env`]: { json: {}, status: 403 } }), { LIFEBOAT_MANAGE_RETENTION: "true" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /LIFEBOAT_VERCEL_TOKEN cannot read the project's environment variables\. .*Nothing was uploaded for Vercel\. The users check still runs; then this run fails\./);
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "db")).length, 1, "the database copy still went up");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "vercel")), false);
  assert.equal(existsSync(path.join(run.work, "vercel")), false);
  assert.doesNotMatch(readFileSync(path.join(run.dir, "aws.log"), "utf8"), /list-objects-v2|s3 rm /, "retention did not run");
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /LIFEBOAT_VERCEL_TOKEN cannot read/);
  assert.ok(!run.stderr.includes(TOKEN) && !shown(run.stdout).includes(TOKEN));
});

test("a settings copy that fails still uploads the environment variables, then fails the run by name", async () => {
  const run = await backupWithVercel(answers({ [`GET /v9/projects/${PROJECT}`]: { json: {}, status: 403 } }));
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /LIFEBOAT_VERCEL_TOKEN cannot read the project's settings\. .*The environment variables still went up\. The users check still runs; then this run fails\./,
  );
  const vercelDir = path.join(run.uploads, "lifeboat", "vercel");
  const [archive] = readdirSync(vercelDir);
  const out = path.join(run.dir, "opened");
  mkdirSync(out);
  execFileSync("age", ["--decrypt", "--identity", run.keyFile, "--output", path.join(out, "vercel.tar.gz"), path.join(vercelDir, archive)]);
  assert.deepEqual(execFileSync("tar", ["-tzf", path.join(out, "vercel.tar.gz")], { encoding: "utf8" }).split("\n").filter(Boolean).sort(), ["./", "./env.json"]);
  assert.equal(existsSync(path.join(run.work, "vercel")), false);
  assert.equal(run.checkins[0].ok, false);
  assert.equal(run.checkins[0].vercelEnvVars, 5);
  assert.equal(run.checkins[0].vercelDomains, null);
  assert.ok(!run.stderr.includes(TOKEN) && !shown(run.stdout).includes(TOKEN));
});

/** A call that never answers until its signal gives up, on a 5 ms clock in place of the real timeout. */
function neverAnswers(t) {
  const real = AbortSignal.timeout.bind(AbortSignal);
  const timeout = t.mock.method(AbortSignal, "timeout", () => real(5));
  let calls = 0;
  const fetchImpl = (_url, init) => {
    calls += 1;
    if (!init?.signal) return Promise.reject(new Error("no signal: this call could wait forever"));
    return new Promise((_resolve, reject) => {
      // AbortSignal.timeout's timer doesn't hold the process open; a real stuck socket would.
      const open = setInterval(() => {}, 1000);
      init.signal.addEventListener("abort", () => {
        clearInterval(open);
        reject(init.signal.reason);
      });
    });
  };
  return { fetchImpl, calls: () => calls, limits: () => timeout.mock.calls.map((call) => call.arguments[0]) };
}

test("a Vercel call that never answers is given up after a minute and tried again, not left to run the job's clock down", { timeout: 5000 }, async (t) => {
  const stuck = neverAnswers(t);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lg-vercel-")), "vercel-env.json");
  await assert.rejects(
    exportVercelEnv({ api: API, project: PROJECT, team: TEAM, token: TOKEN, file, fetchImpl: stuck.fetchImpl, sleep: async () => {} }),
    /Vercel could not be reached when reading/,
  );
  assert.equal(stuck.calls(), 3);
  assert.deepEqual(stuck.limits(), [CALL_TIMEOUT_MS, CALL_TIMEOUT_MS, CALL_TIMEOUT_MS]);
  assert.equal(CALL_TIMEOUT_MS, 60_000);
});
