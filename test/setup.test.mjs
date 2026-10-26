import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CALL_TIMEOUT_MS,
  checkSetup,
  dispositionParam,
  exportSetup,
  NOT_SECRET,
  parseMultipart,
  QUERIES,
  REDACTED,
  redactAuthConfig,
  safePath,
  SECRET_FIELD,
  secretAuthField,
  SETTINGS,
  SOUNDS_SECRET,
} from "../scripts/supabase-setup.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_fc_unit-test-token-must-stay-hidden";
const API = "https://api.example.invalid";
const BOUNDARY = "lg-test-boundary";

/** A multipart/form-data body as Supabase sends a function's source. */
function multipart(parts) {
  const chunks = [];
  for (const part of parts) {
    const head = Object.entries(part.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\r\n");
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${head}\r\n\r\n`), Buffer.from(part.body), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const BINARY = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
const HELLO = multipart([
  { headers: { "Content-Disposition": 'form-data; name="metadata"' }, body: '{"deno2_entrypoint_path":"file:///src/hello/index.ts"}' },
  { headers: { "Content-Disposition": 'form-data; name="file"; filename="hello/index.ts"' }, body: "Deno.serve(() => new Response('hi'));\n" },
  { headers: { "Content-Disposition": 'form-data; name="file"; filename="cors.ts"', "Supabase-Path": "_shared/cors.ts" }, body: "export const cors = {};\n" },
  { headers: { "Content-Disposition": "form-data; name=\"file\"; filename*=UTF-8''hello%2Fd%C3%A9j%C3%A0.json" }, body: "{}" },
  { headers: { "Content-Disposition": 'form-data; name="file"; filename="hello/logo.bin"' }, body: BINARY },
]);

const FUNCTIONS = [
  { slug: "hello", name: "hello", version: 4, verify_jwt: true, entrypoint_path: "file:///src/hello/index.ts" },
  { slug: "old-bundle", name: "old-bundle", version: 1, verify_jwt: false },
];

/** Rows for each read-only query, chosen by the SQL. */
function rowsFor(sql, { cron = true, vault = true } = {}) {
  if (sql.includes("to_regclass")) return [{ cron, vault }];
  if (sql === QUERIES.cronJobs) return [{ jobid: 1, jobname: "nightly-digest", schedule: "0 3 * * *", command: "select 1", active: true }, { jobid: 2, jobname: "purge", schedule: "*/5 * * * *", command: "select 2", active: true }];
  if (sql === QUERIES.databaseWebhooks) return [{ schema: "public", table: "orders", trigger: "notify_shipping", definition: "CREATE TRIGGER notify_shipping ..." }];
  if (sql === QUERIES.vaultSecretNames) return [{ id: "v1", name: "stripe_webhook", description: "", created_at: "2026-10-01" }];
  return null;
}

/** Answers for a fake Management API, keyed by method and path. */
function answers(options = {}) {
  return {
    [`GET /v1/projects/${REF}/functions`]: { json: FUNCTIONS },
    [`GET /v1/projects/${REF}/functions/hello/body`]: { body: HELLO, type: `multipart/form-data; boundary=${BOUNDARY}` },
    [`GET /v1/projects/${REF}/functions/old-bundle/body`]: { body: Buffer.from("ESZIP2.3 bundle bytes"), type: "application/octet-stream" },
    [`GET /v1/projects/${REF}/config/auth`]: { json: { site_url: "https://notes.example", uri_allow_list: "https://notes.example/**", external_github_enabled: true } },
    [`GET /v1/projects/${REF}/config/auth/third-party-auth`]: { json: [] },
    [`GET /v1/projects/${REF}/config/storage`]: { json: { fileSizeLimit: 52428800 } },
    [`GET /v1/projects/${REF}/storage/buckets`]: { json: [{ id: "avatars", name: "avatars", public: true }] },
    [`POST /v1/projects/${REF}/database/query/read-only`]: (body) => ({ json: rowsFor(JSON.parse(body).query, options), status: 201 }),
    ...options.override,
  };
}

/** A fake fetch over those answers, which records each request. */
function fakeFetch(routes, seen = []) {
  return async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    seen.push({ method, pathname, auth: init.headers?.Authorization, accept: init.headers?.Accept, body: init.body });
    const route = routes[`${method} ${pathname}`];
    const answer = typeof route === "function" ? route(init.body) : route;
    if (!answer) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (answer.json !== undefined) {
      return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "content-type": "application/json", ...answer.headers } });
    }
    return new Response(answer.body ?? "", { status: answer.status ?? 200, headers: { "content-type": answer.type ?? "application/json", ...answer.headers } });
  };
}

const noSleep = async () => {};

test("multipart parts keep their headers and exact bytes", () => {
  const parts = parseMultipart(HELLO, BOUNDARY);
  assert.equal(parts.length, 5);
  assert.equal(parts[2].headers["supabase-path"], "_shared/cors.ts");
  assert.deepEqual(Buffer.from(parts[4].body), BINARY);
  assert.throws(() => parseMultipart(Buffer.from("no boundary here"), BOUNDARY), /opening boundary/);
  assert.throws(() => parseMultipart(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="x"\r\n\r\nunfinished`), BOUNDARY), /closing boundary/);
});

test("Content-Disposition parameters read name without matching filename", () => {
  assert.equal(dispositionParam('form-data; filename="a.ts"; name="file"', "name"), "file");
  assert.equal(dispositionParam('form-data; name="file"; filename="a \\"b\\".ts"', "filename"), 'a "b".ts');
  assert.equal(dispositionParam("form-data; name=metadata", "name"), "metadata");
  assert.equal(dispositionParam('form-data; name="file"', "filename"), undefined);
});

test("file paths stay inside the function's folder", () => {
  assert.equal(safePath("hello/index.ts"), "hello/index.ts");
  assert.equal(safePath("file:///tmp/fn/source/index.ts"), "tmp/fn/source/index.ts");
  assert.equal(safePath("/src/./a//b.ts"), "src/a/b.ts");
  assert.equal(safePath("C:\\work\\fn\\index.ts"), "work/fn/index.ts");
  for (const bad of ["../escape.ts", "a/../../escape.ts", "..", "", ".", "a\0b"]) assert.equal(safePath(bad), null, bad);
});

test("the setup copy keeps each function's files, the settings and the database extras", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  const seen = [];
  const notes = [];
  const counts = await exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers(), seen), sleep: noSleep, note: (line) => notes.push(line) });
  assert.deepEqual(counts, { functions: 2, cronJobs: 2, databaseWebhooks: 1, vaultSecretNames: 1 });
  assert.deepEqual(notes, [], "a scoped token gets no warning");

  const hello = path.join(dir, "functions", "hello");
  assert.equal(readFileSync(path.join(hello, "files", "hello", "index.ts"), "utf8"), "Deno.serve(() => new Response('hi'));\n");
  assert.equal(readFileSync(path.join(hello, "files", "_shared", "cors.ts"), "utf8"), "export const cors = {};\n");
  assert.equal(readFileSync(path.join(hello, "files", "hello", "déjà.json"), "utf8"), "{}");
  assert.deepEqual(readFileSync(path.join(hello, "files", "hello", "logo.bin")), BINARY);
  const source = JSON.parse(readFileSync(path.join(hello, "source.json"), "utf8"));
  assert.equal(source.format, "files");
  assert.equal(source.entrypoint_path, "file:///src/hello/index.ts");
  assert.deepEqual(
    source.files.map((file) => file.saved),
    ["files/hello/index.ts", "files/_shared/cors.ts", "files/hello/déjà.json", "files/hello/logo.bin"],
  );

  // A function Supabase sends as one bundle is kept as it came.
  assert.equal(readFileSync(path.join(dir, "functions", "old-bundle", "body.eszip"), "utf8"), "ESZIP2.3 bundle bytes");
  assert.equal(JSON.parse(readFileSync(path.join(dir, "functions", "old-bundle", "source.json"), "utf8")).format, "eszip");

  assert.deepEqual(readdirSync(dir).sort(), [
    "auth-config.json",
    "auth-third-party.json",
    "buckets.json",
    "cron-jobs.json",
    "database-webhooks.json",
    "functions",
    "functions.json",
    "storage-config.json",
    "vault-secret-names.json",
  ]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "auth-config.json"), "utf8")).uri_allow_list, "https://notes.example/**");
  assert.equal(JSON.parse(readFileSync(path.join(dir, "cron-jobs.json"), "utf8"))[1].jobname, "purge");
  assert.equal(JSON.parse(readFileSync(path.join(dir, "vault-secret-names.json"), "utf8"))[0].name, "stripe_webhook");

  // Every request carries the token, reads nothing but GETs and read-only SQL, and asks for the source as files.
  assert.ok(seen.every((request) => request.auth === `Bearer ${TOKEN}`));
  assert.ok(seen.every((request) => request.method === "GET" || request.pathname.endsWith("/database/query/read-only")));
  assert.equal(seen.find((request) => request.pathname.endsWith("/hello/body")).accept, "multipart/form-data");
});

/** Every auth setting Supabase's GET returns, from its spec (see the fixture's source). */
const AUTH_FIELDS = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "auth-config-response-fields.json"), "utf8")).fields;

test("every auth secret is blanked before auth-config.json is written, and every other setting is kept as it came", async () => {
  // Each field filled with a value of its own, as a project using every provider, hook and SMS service would have.
  const filled = Object.fromEntries(AUTH_FIELDS.map((field) => [field, `value-of-${field}`]));
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-secrets-"));
  const routes = answers({ override: { [`GET /v1/projects/${REF}/config/auth`]: { json: filled } } });
  await exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: noSleep });
  const text = readFileSync(path.join(dir, "auth-config.json"), "utf8");
  const written = JSON.parse(text);

  const blanked = AUTH_FIELDS.filter((field) => written[field] === REDACTED);
  assert.equal(blanked.length, 37, "Supabase's spec has 37 secret settings");
  assert.deepEqual(blanked, AUTH_FIELDS.filter((field) => SECRET_FIELD.test(field)));
  for (const field of blanked) assert.ok(!text.includes(`value-of-${field}`), `${field} is not in the copy in any form`);
  for (const field of AUTH_FIELDS.filter((field) => !SECRET_FIELD.test(field))) assert.equal(written[field], `value-of-${field}`, field);
  assert.ok(blanked.includes("smtp_pass") && blanked.includes("external_google_secret") && blanked.includes("hook_send_email_secrets"));

  // An empty secret stays empty, so a rebuild can tell which secrets there are to set again.
  assert.deepEqual(redactAuthConfig({ smtp_pass: "", external_apple_secret: null, external_github_secret: "x", sms_twilio_auth_token: 0 }), {
    smtp_pass: "",
    external_apple_secret: null,
    external_github_secret: REDACTED,
    sms_twilio_auth_token: REDACTED,
  });
  assert.throws(() => redactAuthConfig([{ smtp_pass: "x" }]), /something other than settings for the auth settings/);
  assert.throws(() => redactAuthConfig("smtp_pass=x"), /something other than settings for the auth settings/);
});

test("an auth setting Supabase adds later that sounds like a secret is blanked until it is sorted", () => {
  // Every name in today's spec that sounds like a secret is either a known secret or read one by one as a setting.
  assert.deepEqual(
    AUTH_FIELDS.filter((field) => SOUNDS_SECRET.test(field) && !SECRET_FIELD.test(field)),
    [...NOT_SECRET].sort(),
  );
  // A new name is blanked by its sound alone, with no change here, and a new setting that does not sound like one is kept.
  assert.deepEqual(
    redactAuthConfig({
      external_newco_secret: "a",
      sms_newco_token: "b",
      smtp_credentials: "c",
      hook_newco_private_jwk: "d",
      saml_signing_cert: "e",
      external_newco_client_id: "f",
      external_newco_enabled: true,
    }),
    {
      external_newco_secret: REDACTED,
      sms_newco_token: REDACTED,
      smtp_credentials: REDACTED,
      hook_newco_private_jwk: REDACTED,
      saml_signing_cert: REDACTED,
      external_newco_client_id: "f",
      external_newco_enabled: true,
    },
  );
  assert.equal(secretAuthField("password_min_length"), false);
  assert.equal(secretAuthField("password_reset_token_secret"), true);
});

test("a setup copy reads back as it was saved, and the check names a file that is missing, cut short or outside its folder", async () => {
  const exported = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-check-"));
    const counts = await exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers()), sleep: noSleep });
    return { dir, counts };
  };
  const whole = await exported();
  assert.deepEqual(checkSetup(whole.dir), whole.counts);

  const cut = await exported();
  writeFileSync(path.join(cut.dir, "functions", "hello", "files", "hello", "logo.bin"), BINARY.subarray(0, 3));
  assert.throws(() => checkSetup(cut.dir), /^Error: files\/hello\/logo\.bin in the hello function did not read back at the size it was saved\.$/);

  const bundle = await exported();
  rmSync(path.join(bundle.dir, "functions", "old-bundle", "body.eszip"));
  assert.throws(() => checkSetup(bundle.dir), /body\.eszip in the old-bundle function did not read back/);

  const setting = await exported();
  rmSync(path.join(setting.dir, "storage-config.json"));
  assert.throws(() => checkSetup(setting.dir), /storage-config\.json in the Supabase setup copy did not read back\./);

  const list = await exported();
  writeFileSync(path.join(list.dir, "cron-jobs.json"), "{}");
  assert.throws(() => checkSetup(list.dir), /cron-jobs\.json in the Supabase setup copy is not a list\./);

  for (const saved of ["files/../../../../etc/hostname", "hello/index.ts", "files/a/../../source.json"]) {
    const outside = await exported();
    const file = path.join(outside.dir, "functions", "hello", "source.json");
    const source = JSON.parse(readFileSync(file, "utf8"));
    source.files[0].saved = saved;
    writeFileSync(file, JSON.stringify(source));
    assert.throws(() => checkSetup(outside.dir), /The hello function in the Supabase setup copy names a file outside its folder\./, saved);
  }
});

test("the settings files are the ones every setup copy has had since B7", () => {
  // The test restore requires each of these. Adding one means skipping it for copies made before it, or every older
  // copy fails its test restore until it ages out. Change this list only together with that handling.
  assert.deepEqual(
    SETTINGS.map((setting) => setting.file),
    ["auth-config.json", "auth-third-party.json", "storage-config.json", "buckets.json"],
  );
});

test("the Vault query reads names, never the secret values", () => {
  const columns = QUERIES.vaultSecretNames.replace(/ from .*/, "");
  assert.doesNotMatch(columns, /secret/);
});

test("a database without pg_cron or Vault gives empty lists and is never asked about them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  const seen = [];
  const counts = await exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers({ cron: false, vault: false }), seen), sleep: noSleep });
  assert.equal(counts.cronJobs, 0);
  assert.equal(counts.vaultSecretNames, 0);
  const queries = seen.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body).query);
  assert.ok(!queries.includes(QUERIES.cronJobs) && !queries.includes(QUERIES.vaultSecretNames));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "cron-jobs.json"), "utf8")), []);
});

test("a file path that climbs out of the function's folder stops the copy and writes nothing outside", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  const dir = path.join(root, "setup");
  const evil = multipart([{ headers: { "Content-Disposition": 'form-data; name="file"; filename="../../../escaped.ts"' }, body: "bad" }]);
  const override = { [`GET /v1/projects/${REF}/functions/hello/body`]: { body: evil, type: `multipart/form-data; boundary=${BOUNDARY}` } };
  await assert.rejects(
    exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers({ override })), sleep: noSleep }),
    /outside its folder/,
  );
  assert.equal(existsSync(path.join(root, "escaped.ts")), false);
  assert.equal(existsSync(path.join(dir, "escaped.ts")), false);
});

test("a missing permission is named, an expired token is explained, and the token is never in the message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  const forbidden = { override: { [`GET /v1/projects/${REF}/config/storage`]: { json: { message: "forbidden" }, status: 403 } } };
  await assert.rejects(
    exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers(forbidden)), sleep: noSleep }),
    (error) => /Storage Config: Read, for this project only/.test(error.message) && !error.message.includes(TOKEN),
  );
  const expired = { override: { [`GET /v1/projects/${REF}/functions`]: { json: { message: "Unauthorized" }, status: 401 } } };
  await assert.rejects(exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers(expired)), sleep: noSleep }), /expired/);
  await assert.rejects(exportSetup({ api: API, ref: "NotARef", token: TOKEN, dir }), /20 lowercase letters/);
});

test("a rate limit waits as long as Supabase asks, then carries on", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  const waits = [];
  let tries = 0;
  const override = {
    [`GET /v1/projects/${REF}/config/auth`]: () =>
      ++tries < 2 ? { json: { message: "Too Many Requests" }, status: 429, headers: { "retry-after": "7" } } : { json: { site_url: "x" } },
  };
  await exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: fakeFetch(answers({ override })), sleep: async (ms) => waits.push(ms) });
  assert.equal(tries, 2);
  assert.deepEqual(waits, [7000]);
});

test("a token that is not scoped still copies, with a warning to replace it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  const notes = [];
  await exportSetup({ api: API, ref: REF, token: "sbp_full_access_token_not_scoped", dir, fetchImpl: fakeFetch(answers()), sleep: noSleep, note: (line) => notes.push(line) });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^::warning::LIFEBOAT_SUPABASE_TOKEN is not a scoped token/);
});

// Two Supabase Auth accounts, one with a password, for the users check.
const AUTH_TOC = "230; 1259 17500 TABLE auth users supabase_auth_admin\n4270; 0 17500 TABLE DATA auth users supabase_auth_admin\n";
const AUTH_USERS_COPY = "COPY auth.users (instance_id, id, email, encrypted_password) FROM stdin;\n\\N\tu1\ta@users.test\t$2a$10$hash\n\\N\tu2\tb@users.test\t\n\\.\n";

function fakeTools(dir, { users = false } = {}) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  // Keeps each upload under its object key, folders and all, and logs every call.
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
  // The users check lists the dump. Without users it has no Supabase Auth tables.
  if (users) {
    writeFileSync(path.join(dir, "toc.txt"), AUTH_TOC);
    writeFileSync(path.join(dir, "copy.users"), AUTH_USERS_COPY);
    writeFileSync(
      path.join(dir, "pg_restore"),
      `#!/bin/sh
table=""
prev=""
for arg in "$@"; do
  [ "$arg" = "--list" ] && { cat "${dir}/toc.txt"; exit 0; }
  [ "$prev" = "-t" ] && table="$arg"
  prev="$arg"
done
cat "${dir}/copy.$table"
`,
    );
  } else {
    writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  }
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
  return uploads;
}

/** The fake Management API and the check-in endpoint on one local port. */
async function fakeSupabase(routes) {
  const checkins = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/checkin") {
        checkins.push(JSON.parse(body));
        response.writeHead(202).end("{}");
        return;
      }
      const fetchImpl = fakeFetch(request.headers.authorization === `Bearer ${TOKEN}` ? routes : {});
      const answer = await fetchImpl(`http://localhost${request.url}`, {
        method: request.method,
        headers: { Authorization: request.headers.authorization },
        body,
      });
      response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      response.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, checkins };
}

/** What a reader of the job log sees: the runner consumes ::add-mask:: lines instead of printing them. */
function shown(text) {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

function runAsync(env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [RUN], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function backupWithSetup(routes, extra = {}, tools = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-run-"));
  const uploads = fakeTools(dir, tools);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const api = await fakeSupabase(routes);
  try {
    const result = await runAsync({
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      LIFEBOAT_MODE: "backup",
      // The Session pooler URL names the project ref in its username.
      DATABASE_URL: `postgresql://lastgood_backup.${REF}:unit-test-db-password@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`,
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
      S3_PREFIX: "lifeboat",
      LIFEBOAT_PUBLIC_KEY: publicKey,
      LIFEBOAT_MANAGE_RETENTION: "false",
      LIFEBOAT_PROJECT: REF,
      CHECKIN_SECRET: "unit-test-checkin-secret",
      CHECKIN_URL: `http://127.0.0.1:${api.port}/checkin`,
      LIFEBOAT_WORKDIR: work,
      LIFEBOAT_SUPABASE_TOKEN: TOKEN,
      SUPABASE_API_URL: `http://127.0.0.1:${api.port}`,
      ...extra,
    });
    return { ...result, dir, uploads, keyFile, work, checkins: api.checkins };
  } finally {
    api.server.close();
  }
}

test("backup uploads the Edge Functions and settings in one age archive under setup/", async () => {
  const run = await backupWithSetup(answers());
  assert.equal(run.status, 0, run.stderr);
  const setupDir = path.join(run.uploads, "lifeboat", "setup");
  const files = readdirSync(setupDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}Z\.tar\.gz\.age$/);
  assert.match(run.stdout, /Supabase setup: 2 Edge Functions, auth and storage settings, 2 cron jobs, 1 database webhooks, 1 Vault secret names\./);
  assert.ok(run.stdout.includes(`::add-mask::${TOKEN}`), "the token is masked");
  assert.ok(!shown(run.stdout).includes(TOKEN) && !run.stderr.includes(TOKEN), "the token is never printed");

  // Open it the way a customer would: age with the private key, then tar.
  const out = path.join(run.dir, "opened");
  mkdirSync(out);
  execFileSync("age", ["--decrypt", "--identity", run.keyFile, "--output", path.join(out, "setup.tar.gz"), path.join(setupDir, files[0])]);
  execFileSync("tar", ["-xzf", "setup.tar.gz"], { cwd: out });
  assert.equal(readFileSync(path.join(out, "functions", "hello", "files", "_shared", "cors.ts"), "utf8"), "export const cors = {};\n");
  assert.equal(JSON.parse(readFileSync(path.join(out, "buckets.json"), "utf8"))[0].id, "avatars");

  // Nothing readable is left on the runner, and the check-in carries the counts.
  assert.equal(existsSync(path.join(run.work, "setup")), false);
  assert.equal(existsSync(path.join(run.work, "setup.tar.gz")), false);
  assert.equal(run.checkins.length, 1);
  assert.equal(run.checkins[0].ok, true);
  assert.equal(run.checkins[0].setupFunctions, 2);
  assert.equal(run.checkins[0].setupCronJobs, 2);
  assert.ok(run.checkins[0].setupBytes > 0);
});

test("without LIFEBOAT_SUPABASE_TOKEN the setup copy is skipped and the check-in says not copied", async () => {
  const run = await backupWithSetup(answers(), { LIFEBOAT_SUPABASE_TOKEN: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Supabase setup copy skipped/);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "setup")), false);
  assert.equal(run.checkins[0].setupFunctions, null);
  assert.equal(run.checkins[0].setupBytes, null);
});

test("with encryption off the setup copy is skipped with a warning, never uploaded in the clear", async () => {
  const run = await backupWithSetup(answers(), { LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /::warning::Supabase setup copy skipped: encryption is off/);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "setup")), false);
  assert.equal(run.checkins[0].setupFunctions, null);
});

test("a token without a permission fails the run by name, after the database copy, and uploads no setup", async () => {
  const run = await backupWithSetup(answers({ override: { [`GET /v1/projects/${REF}/functions`]: { json: { message: "forbidden" }, status: 403 } } }));
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Give the token Edge Functions: Read, for this project only\. Nothing was uploaded for the Supabase setup\./);
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "db")).length, 1, "the database copy still went up");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "setup")), false);
  assert.equal(existsSync(path.join(run.work, "setup")), false);
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /Edge Functions: Read/);
  assert.ok(!run.stderr.includes(TOKEN) && !shown(run.stdout).includes(TOKEN));
});

test("a setup 403 still reports the users counts, then fails before retention can delete older copies", async () => {
  const forbidden = answers({ override: { [`GET /v1/projects/${REF}/functions`]: { json: { message: "forbidden" }, status: 403 } } });
  const run = await backupWithSetup(forbidden, { LIFEBOAT_MANAGE_RETENTION: "true" }, { users: true });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Edge Functions: Read.*Nothing was uploaded for the Supabase setup\. The users check still runs; then this run fails\./);
  assert.match(run.stdout, /Users: 2 accounts, 1 with a password, 0 sign-in identities\./);
  assert.equal(run.checkins.length, 1);
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /Edge Functions: Read/);
  assert.equal(run.checkins[0].authUsers, 2);
  assert.equal(run.checkins[0].authUsersWithPassword, 1);
  assert.equal(run.checkins[0].setupFunctions, null);
  const calls = readFileSync(path.join(run.dir, "aws.log"), "utf8");
  assert.doesNotMatch(calls, /list-objects-v2|s3 rm /, "retention did not run");
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "db")).length, 1, "the database copy still went up");
});

test("a database URL that names no project ref asks for supabase-project-ref", async () => {
  const run = await backupWithSetup(answers(), { DATABASE_URL: "postgres://example.invalid/db" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Set supabase-project-ref/);
  const named = await backupWithSetup(answers(), { DATABASE_URL: "postgres://example.invalid/db", SUPABASE_PROJECT_REF: REF });
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.checkins[0].setupFunctions, 2);
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

test("a Supabase call that never answers is given up after two minutes and tried again, not left to run the job's clock down", { timeout: 5000 }, async (t) => {
  const stuck = neverAnswers(t);
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-"));
  await assert.rejects(
    exportSetup({ api: API, ref: REF, token: TOKEN, dir, fetchImpl: stuck.fetchImpl, sleep: noSleep }),
    /Supabase could not be reached when reading/,
  );
  assert.equal(stuck.calls(), 3);
  assert.deepEqual(stuck.limits(), [CALL_TIMEOUT_MS, CALL_TIMEOUT_MS, CALL_TIMEOUT_MS]);
  assert.equal(CALL_TIMEOUT_MS, 120_000);
});
