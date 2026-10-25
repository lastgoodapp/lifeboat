import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyStorage, parseLogin, safeSegment } from "../scripts/storage-copy.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const REF = "abcdefghijklmnopqrst";
// Made-up values. None of them is a real secret.
const EMAIL = "lastgood-backup@lastgood.invalid";
const PASSWORD = "UnitTestStoragePassword12345678";
const LOGIN = `${EMAIL}:${PASSWORD}`;
const APIKEY = "sb_publishable_unitTestKey0123456789_abcd1234";

const FILES = {
  avatars: { "a/1.png": "first avatar", "a/deep/2.png": "second avatar", "top.txt": "at the top", "spaces in name.txt": "spaced" },
  invoices: { "2026/10/inv-1.pdf": "%PDF invoice one", "2026/10/inv-2.pdf": "%PDF invoice two", "2026/11/inv-3.pdf": "" },
  empty: {},
};

/**
 * A fake Supabase project: Auth's token endpoint and the Storage API's bucket list, file list and authenticated
 * download, enough to copy with. Records every request, and refuses an access token it has retired.
 */
async function fakeSupabase({ files = FILES, expiresIn = 3600, failFirst = {}, retireAfter = Infinity, names = null, emailOff = false, forbid = null } = {}) {
  const requests = [];
  const live = new Map();
  const refresh = new Set();
  let issued = 0;
  const checkins = [];
  const issue = () => {
    issued += 1;
    const access = `access-${issued}`;
    const next = `refresh-${issued}`;
    live.set(access, 0);
    refresh.add(next);
    return { access_token: access, refresh_token: next, expires_in: expiresIn, token_type: "bearer" };
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://localhost");
      const send = (status, value, type = "application/json") => {
        response.writeHead(status, { "content-type": type });
        response.end(type === "application/json" ? JSON.stringify(value) : value);
      };
      if (url.pathname === "/checkin") {
        checkins.push(JSON.parse(body));
        return send(202, {});
      }
      requests.push({ method: request.method, path: url.pathname, grant: url.searchParams.get("grant_type"), auth: request.headers.authorization ?? "" });
      const key = `${request.method} ${url.pathname}`;
      if (failFirst[key] > 0) {
        failFirst[key] -= 1;
        return send(503, { message: "busy" });
      }
      if (request.headers.apikey !== APIKEY) return send(401, { message: "Invalid API key" });
      if (url.pathname === "/auth/v1/token" && request.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (url.searchParams.get("grant_type") === "password") {
          // Supabase Auth answers 422 here, not 400 (supabase/auth internal/api/token.go, ResourceOwnerPasswordGrant).
          if (emailOff) return send(422, { code: 422, error_code: "email_provider_disabled", msg: "Email logins are disabled" });
          if (parsed.email !== EMAIL || parsed.password !== PASSWORD) {
            return send(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
          }
          return send(200, issue());
        }
        if (url.searchParams.get("grant_type") === "refresh_token" && refresh.has(parsed.refresh_token)) {
          refresh.delete(parsed.refresh_token);
          return send(200, issue());
        }
        return send(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      }
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!live.has(token)) return send(400, { statusCode: "403", error: "Unauthorized", message: "invalid signature" });
      live.set(token, live.get(token) + 1);
      if (live.get(token) > retireAfter) {
        live.delete(token);
        return send(401, { message: "JWT expired" });
      }
      if (url.pathname === "/storage/v1/bucket" && request.method === "GET") {
        return send(200, Object.keys(files).map((id) => ({ id, name: id, public: false })));
      }
      const list = /^\/storage\/v1\/object\/list\/([^/]+)$/.exec(url.pathname);
      if (list && request.method === "POST") {
        const bucket = decodeURIComponent(list[1]);
        // Storage answers a policy refusal with HTTP 400 and the real status in the body.
        if (bucket === forbid) return send(400, { statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" });
        const { prefix = "", limit = 100, offset = 0 } = JSON.parse(body || "{}");
        const children = new Map();
        for (const [name, content] of Object.entries(files[bucket] ?? {})) {
          if (!name.startsWith(prefix)) continue;
          const rest = name.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash === -1) children.set(rest, { name: rest, id: `id-${name}`, metadata: { size: content.length } });
          else children.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null, metadata: null });
        }
        const sorted = (names ? names(bucket, prefix) : null) ?? [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
        return send(200, sorted.slice(offset, offset + limit));
      }
      const get = /^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (get && request.method === "GET") {
        const bucket = decodeURIComponent(get[1]);
        const name = get[2].split("/").map(decodeURIComponent).join("/");
        const content = files[bucket]?.[name];
        if (content === undefined) return send(400, { statusCode: "404", error: "not_found", message: "Object not found" });
        return send(200, content, "application/octet-stream");
      }
      return send(404, { message: "no route" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, api: `http://127.0.0.1:${server.address().port}`, requests, checkins, issued: () => issued };
}

const noSleep = async () => {};

async function copied(options = {}, fake = {}) {
  const supabase = await fakeSupabase(fake);
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  try {
    const counts = await copyStorage({ ref: REF, login: LOGIN, apikey: APIKEY, dir, api: supabase.api, sleep: noSleep, ...options });
    return { counts, dir, requests: supabase.requests, issued: supabase.issued() };
  } finally {
    supabase.server.close();
  }
}

test("copies every file in every bucket, folders and pages included, and only ever reads", async () => {
  const { counts, dir, requests } = await copied({ pageSize: 2 });
  const total = Object.values(FILES).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0);
  const bytes = Object.values(FILES).reduce((sum, bucket) => sum + Object.values(bucket).join("").length, 0);
  assert.deepEqual(counts, { buckets: 3, files: total, bytes });
  for (const [bucket, files] of Object.entries(FILES)) {
    assert.ok(existsSync(path.join(dir, bucket)), `${bucket} has a folder, even when empty`);
    for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(path.join(dir, bucket, ...name.split("/")), "utf8"), content);
  }
  // Signs in once, then only lists and downloads: no upload, move, copy or delete.
  for (const request of requests) {
    const read =
      (request.method === "POST" && request.path === "/auth/v1/token") ||
      (request.method === "POST" && request.path.startsWith("/storage/v1/object/list/")) ||
      (request.method === "GET" && (request.path === "/storage/v1/bucket" || request.path.startsWith("/storage/v1/object/authenticated/")));
    assert.ok(read, `${request.method} ${request.path} is a read`);
  }
  assert.equal(requests.filter((request) => request.grant === "password").length, 1);
});

test("refreshes the session before it runs out, so a long copy keeps going", async () => {
  let clock = 0;
  // Every request moves the clock on 50 seconds; a session lasts 300, and is refreshed 120 before its end.
  const now = () => (clock += 50_000);
  const { counts, requests } = await copied({ now }, { expiresIn: 300 });
  assert.equal(counts.files, 7);
  assert.equal(requests.filter((request) => request.grant === "password").length, 1);
  assert.ok(requests.filter((request) => request.grant === "refresh_token").length >= 3);
});

test("a session Supabase ends early is refreshed once and the copy carries on", async () => {
  const { counts, requests } = await copied({}, { retireAfter: 3 });
  assert.equal(counts.files, 7);
  assert.ok(requests.some((request) => request.grant === "refresh_token"));
});

test("a busy answer is tried again", async () => {
  const { counts, requests } = await copied({}, { failFirst: { "GET /storage/v1/bucket": 2 } });
  assert.equal(counts.files, 7);
  assert.equal(requests.filter((request) => request.path === "/storage/v1/bucket").length, 3);
});

test("a wrong password, a wrong key or a secret key each say what to do, and never print the password", async () => {
  await assert.rejects(copied({ login: `${EMAIL}:WrongPassword0000000000000000000` }), (error) => {
    assert.match(error.message, /did not accept the storage login in LIFEBOAT_STORAGE_LOGIN\. If email sign-in is turned off for this project, that is the likely cause/);
    assert.match(error.message, /connect again in LastGood to make a new login\./);
    assert.ok(!error.message.includes(PASSWORD));
    return true;
  });
  await assert.rejects(copied({ apikey: "sb_publishable_someOtherProject0123456_ffff" }), /did not accept the publishable key in LIFEBOAT_SUPABASE_PUBLISHABLE_KEY/);
  const fake = await fakeSupabase();
  try {
    await assert.rejects(
      copyStorage({ ref: REF, login: LOGIN, apikey: "sb_secret_0123456789abcdef", dir: mkdtempSync(path.join(tmpdir(), "lg-storage-")), api: fake.api, sleep: noSleep }),
      /holds a secret key/,
    );
    assert.equal(fake.requests.length, 0, "a secret key is never sent");
  } finally {
    fake.server.close();
  }
  await assert.rejects(copied({ login: "no-colon-here" }), /is not a storage login/);
  await assert.rejects(copied({ ref: "short" }), /20-letter ref/);
});

test("email sign-in turned off, and a storage policy that refuses a read, each say so", async () => {
  await assert.rejects(copied({}, { emailOff: true }), /because email sign-in is turned off for this project\. Turn on the Email provider in Supabase, under Authentication \(new sign-ups can stay off\)/);
  await assert.rejects(copied({}, { forbid: "invoices" }), (error) => {
    assert.match(error.message, /refused to let the storage login read the files in invoices\. Connect again in LastGood to set its policies again\. A storage policy that needs two-factor sign-in \(aal2\) can also cause this\./);
    return true;
  });
});

test("a file name that would leave its folder stops the copy before anything is written outside", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  const fake = await fakeSupabase({
    files: { avatars: { "ok.txt": "fine" } },
    names: (bucket, prefix) => (prefix === "" ? [{ name: "..", id: null }, { name: "ok.txt", id: "1" }] : []),
  });
  try {
    await assert.rejects(copyStorage({ ref: REF, login: LOGIN, apikey: APIKEY, dir, api: fake.api, sleep: noSleep }), /cannot be saved safely/);
  } finally {
    fake.server.close();
  }
  assert.equal(safeSegment(".."), false);
  assert.equal(safeSegment("a/b"), false);
  assert.equal(safeSegment("a\\b"), false);
  assert.equal(safeSegment("spaces in name.txt"), true);
  assert.deepEqual(parseLogin(`a:b@c.invalid:${PASSWORD}`), { email: "a:b@c.invalid", password: PASSWORD });
});

// The whole backup, with fake tools, a fake bucket and a fake Supabase project on a local port.
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
  *" s3 sync "*)
    for last; do :; done
    prev=""; src=""
    for arg in "$@"; do [ "$arg" = "$last" ] && src="$prev"; prev="$arg"; done
    key="\${last#s3://*/}"
    mkdir -p "${uploads}/$key"
    cp -R "$src"/. "${uploads}/$key"
    ;;
esac
exit 0
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
  return uploads;
}

async function backupWithStorage(extra = {}, fake = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-run-"));
  const uploads = fakeTools(dir);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const supabase = await fakeSupabase(fake);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          HOME: dir,
          LIFEBOAT_MODE: "backup",
          DATABASE_URL: `postgres://lastgood_backup.${REF}:pw@example.invalid/db`,
          S3_BUCKET: "bucket",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          S3_PREFIX: "lifeboat",
          LIFEBOAT_PUBLIC_KEY: publicKey,
          LIFEBOAT_MANAGE_RETENTION: "false",
          LIFEBOAT_PROJECT: REF,
          CHECKIN_SECRET: "unit-test-checkin-secret",
          CHECKIN_URL: `${supabase.api}/checkin`,
          LIFEBOAT_WORKDIR: work,
          LIFEBOAT_STORAGE_LOGIN: LOGIN,
          SUPABASE_PUBLISHABLE_KEY: APIKEY,
          SUPABASE_URL: supabase.api,
          ...extra,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, dir, uploads, keyFile, work, checkins: supabase.checkins };
  } finally {
    supabase.server.close();
  }
}

/** What a reader of the job log sees: the runner consumes ::add-mask:: lines instead of printing them. */
function shown(text) {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

test("backup signs in with the storage login and uploads every file in one age archive under storage/", async () => {
  const run = await backupWithStorage();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Files: 7 files in 3 buckets, \d+ bytes, read with the storage login\./);
  assert.ok(run.stdout.includes(`::add-mask::${LOGIN}`), "the login is masked");
  assert.ok(run.stdout.includes(`::add-mask::${PASSWORD}`), "the password alone is masked");
  assert.ok(!(shown(run.stdout) + run.stderr).includes(PASSWORD), "the password never shows in the log");
  const storageDir = path.join(run.uploads, "lifeboat", "storage");
  const archives = readdirSync(storageDir);
  assert.equal(archives.length, 1);
  assert.match(archives[0], /^\d{8}T\d{6}Z\.tar\.age$/);
  const out = path.join(run.dir, "opened");
  mkdirSync(out);
  execFileSync("age", ["--decrypt", "--identity", run.keyFile, "--output", path.join(out, "storage.tar"), path.join(storageDir, archives[0])]);
  execFileSync("tar", ["-xf", "storage.tar"], { cwd: out });
  assert.equal(readFileSync(path.join(out, "avatars", "a", "deep", "2.png"), "utf8"), "second avatar");
  assert.equal(readFileSync(path.join(out, "invoices", "2026", "10", "inv-1.pdf"), "utf8"), "%PDF invoice one");
  assert.ok(existsSync(path.join(out, "empty")));
  // Nothing readable is left on the runner, and the check-in carries the count.
  assert.equal(existsSync(path.join(run.work, "storage")), false);
  assert.equal(existsSync(path.join(run.work, "storage.tar")), false);
  assert.equal(run.checkins[0].ok, true);
  assert.equal(run.checkins[0].storageObjects, 7);
  assert.equal(run.checkins[0].storageSource, "login");
  assert.ok(run.checkins[0].copies.some((copy) => copy.key.startsWith("lifeboat/storage/")));
});

test("with encryption off the files go up bucket by bucket, as the S3 path always did", async () => {
  const run = await backupWithStorage({ LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(path.join(run.uploads, "lifeboat", "storage", "avatars", "top.txt"), "utf8"), "at the top");
  assert.equal(existsSync(path.join(run.work, "storage")), false);
});

test("without the storage login the files are skipped and the log says how to add them", async () => {
  const run = await backupWithStorage({ LIFEBOAT_STORAGE_LOGIN: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Storage copy skipped: LIFEBOAT_STORAGE_LOGIN is not set, so your files are not in this copy\. Connect again in LastGood/);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "storage")), false);
  // The check-in says so, and LastGood's status card shows the files as not copied that night.
  assert.equal(run.checkins[0].ok, true);
  assert.equal(run.checkins[0].storageSource, "none");
});

test("a login Supabase refuses fails the run by name, after the other copies, and uploads nothing for the files", async () => {
  const run = await backupWithStorage({ LIFEBOAT_STORAGE_LOGIN: `${EMAIL}:WrongPassword0000000000000000000`, LIFEBOAT_MANAGE_RETENTION: "true" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /did not accept the storage login in LIFEBOAT_STORAGE_LOGIN\. .*Nothing was uploaded for the files\. The users check still runs; then this run fails\./);
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "db")).length, 1, "the database copy still went up");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "storage")), false);
  assert.equal(existsSync(path.join(run.work, "storage")), false);
  assert.doesNotMatch(readFileSync(path.join(run.dir, "aws.log"), "utf8"), /list-objects-v2|s3 rm /, "retention did not run");
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /did not accept the storage login/);
});
