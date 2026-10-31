import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copiedStorageNames, decodeCopyField, stillThereSql, storageObjectCount, storageObjectNames, storageShortfall } from "../scripts/restore-list.mjs";
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
 * download, enough to copy with. Records every request, and refuses an access token it has retired. Each route in
 * `failFirst` is answered with `failStatus` that many times before it works, with `retryAfter` as its Retry-After when
 * given.
 */
async function fakeSupabase({ files = FILES, expiresIn = 3600, failFirst = {}, failStatus = 503, retryAfter = null, retireAfter = Infinity, names = null, emailOff = false, forbid = null } = {}) {
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
      const send = (status, value, type = "application/json", headers = {}) => {
        response.writeHead(status, { "content-type": type, ...headers });
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
        return send(failStatus, { message: "busy" }, "application/json", retryAfter === null ? {} : { "retry-after": retryAfter });
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

/** Copies against a fake that answers `route` with `status` the first `times` times, and counts how often it was asked. */
async function failing(route, status, times) {
  const fake = await fakeSupabase({ failFirst: { [route]: times }, failStatus: status });
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  try {
    const result = await copyStorage({ ref: REF, login: LOGIN, apikey: APIKEY, dir, api: fake.api, sleep: noSleep }).then(
      (counts) => ({ counts }),
      (error) => ({ error }),
    );
    return { ...result, asked: fake.requests.filter((request) => `${request.method} ${request.path}` === route).length };
  } finally {
    fake.server.close();
  }
}

test("a rate limit's Retry-After is waited out up to a minute, and without a number of seconds each wait doubles", async () => {
  const waited = async (retryAfter) => {
    const fake = await fakeSupabase({ failFirst: { "GET /storage/v1/bucket": 2 }, failStatus: 429, retryAfter });
    const waits = [];
    try {
      const counts = await copyStorage({ ref: REF, login: LOGIN, apikey: APIKEY, dir: mkdtempSync(path.join(tmpdir(), "lg-storage-")), api: fake.api, sleep: async (ms) => waits.push(ms) });
      assert.equal(counts.files, 7);
      return waits;
    } finally {
      fake.server.close();
    }
  };
  assert.deepEqual(await waited("5"), [5000, 5000]);
  assert.deepEqual(await waited("3600"), [60_000, 60_000], "capped at a minute");
  assert.deepEqual(await waited(null), [1000, 2000]);
  assert.deepEqual(await waited("0"), [1000, 2000]);
  assert.deepEqual(await waited("Wed, 28 Oct 2026 08:00:00 GMT"), [1000, 2000], "a date is not a number of seconds");
});

test("a rate limit is tried again and named when it lasts, and a file Supabase does not have is not asked for again", async () => {
  const once = await failing("GET /storage/v1/bucket", 429, 1);
  assert.equal(once.counts?.files, 7, once.error?.message);
  assert.equal(once.asked, 2);

  const lasting = await failing("GET /storage/v1/bucket", 429, 99);
  assert.match(lasting.error?.message ?? "", /^Supabase's rate limit stopped the copy of the list of buckets\. The next run tries again\.$/);
  assert.equal(lasting.asked, 3);

  const gone = await failing("GET /storage/v1/object/authenticated/avatars/top.txt", 404, 99);
  assert.equal(gone.error?.message, "Supabase could not find a file in avatars. It may have been deleted during the copy; the next run tries again.");
  assert.equal(gone.asked, 1);

  const noList = await failing("GET /storage/v1/bucket", 404, 99);
  assert.equal(noList.error?.message, "Supabase could not find the list of buckets. It may have been deleted during the copy; the next run tries again.");
  assert.equal(noList.asked, 1);
});

test("a session that says it lasts zero seconds is taken to last an hour, not renewed before every request", async () => {
  const { counts, requests } = await copied({}, { expiresIn: 0 });
  assert.equal(counts.files, 7);
  assert.deepEqual(
    requests.filter((request) => request.grant).map((request) => request.grant),
    ["password"],
  );
});

test("a storage login needs an email and a password, split at the last colon", () => {
  assert.deepEqual(parseLogin(`  ${LOGIN}\n`), { email: EMAIL, password: PASSWORD });
  for (const value of [`${EMAIL}:`, `no-at-sign:${PASSWORD}`, `:${PASSWORD}`, "", undefined]) {
    assert.throws(() => parseLogin(value), /LIFEBOAT_STORAGE_LOGIN is not a storage login/, String(value));
  }
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
/**
 * pg_restore for a dump whose storage.objects holds `rows` files: its TOC line, and the rows when asked for them. The
 * first `real` rows are files the fake project serves, so the copy holds them; the rest are in bucket b, which it doesn't.
 */
function pgRestoreWithObjects(rows, real = 7) {
  const served = Object.entries(FILES).flatMap(([bucket, files]) => Object.keys(files).map((name) => `${bucket}\t${name}`));
  const lines = Array.from({ length: rows }, (_, i) => `id${i}\t${i < real ? served[i] : `b\tn${i}`}`);
  return `#!/bin/sh
case " $* " in
  *" --list "*) echo "4300; 0 17700 TABLE DATA storage objects supabase_storage_admin" ;;
  *" -t objects "*)
    echo "COPY storage.objects (id, bucket_id, name) FROM stdin;"
    cat <<'ROWS'
${lines.join("\n")}
ROWS
    printf '%s\n' '\\.'
    ;;
esac
exit 0
`;
}

/** psql that answers the files check with `answer`, or fails with `status`, and keeps the query it was given. */
function psqlAnswering(answer, status = 0) {
  return (dir) => `#!/bin/sh
echo "$*" >> "${dir}/psql.log"
for arg; do
  if [ "$prev" = "--file" ]; then cat "$arg" > "${dir}/psql.sql"; fi
  prev="$arg"
done
case " $* " in
  *" --file "*) [ ${status} -eq 0 ] && printf '%s\n' '${answer}'; exit ${status} ;;
esac
exit 2
`;
}

/**
 * `tools.refuse` is a destination the fake bucket refuses, as a bucket refuses keys that may not write there.
 * `tools.fail` is { on, message }: any aws call with `on` in it prints the message and fails.
 */
function fakeTools(dir, tools = {}) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  if (tools.fail) writeFileSync(path.join(dir, "aws.fail"), tools.fail.message);
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
echo "$*" >> "${dir}/aws.log"
${tools.refuse ? `case " $* " in *" ${tools.refuse}"*) echo "upload failed: An error occurred (AccessDenied) when calling the PutObject operation: Access Denied" >&2; exit 1 ;; esac` : ""}
${tools.fail ? `case " $* " in *"${tools.fail.on}"*) cat "${dir}/aws.fail" >&2; exit 1 ;; esac` : ""}
case " $* " in
  *" s3api "*) printf '%s\\n' '{"Contents":[]}' ;;
  *" s3 ls "*) echo "2024-01-01 00:00:00 media" ;;
  *" s3 sync s3://"*)
    # A download from the project's own S3 endpoint: one file, dated when it last changed there, years ago.
    for last; do :; done
    mkdir -p "$last/2024"
    printf 'unchanged' > "$last/2024/a.png"
    touch -d '2001-02-03 04:05:06' "$last/2024/a.png"
    ;;
  *" s3 cp "*)
    for last; do :; done
    prev=""; src=""
    for arg in "$@"; do [ "$arg" = "$last" ] && src="$prev"; prev="$arg"; done
    key="\${last#s3://*/}"
    echo "upload $key: $(ls "$LIFEBOAT_WORKDIR" | tr '\n' ' ')" >> "${dir}/workdir.log"
    mkdir -p "${uploads}/$(dirname "$key")"
    cp "$src" "${uploads}/$key"
    ;;
  *" s3 sync "*)
    for last; do :; done
    prev=""; src=""
    for arg in "$@"; do [ "$arg" = "$last" ] && src="$prev"; prev="$arg"; done
    key="\${last#s3://*/}"
    find "$src" -type f -exec stat -c '%Y %n' {} + >> "${dir}/sync-times.log"
    mkdir -p "${uploads}/$key"
    cp -R "$src"/. "${uploads}/$key"
    ;;
esac
exit 0
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), tools.pgRestore ?? "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(dir, "psql"), (tools.psql ?? psqlAnswering("", 2))(dir));
  for (const tool of ["pg_dump", "aws", "pg_restore", "psql"]) chmodSync(path.join(dir, tool), 0o755);
  if (tools.age) {
    writeFileSync(path.join(dir, "age"), tools.age);
    chmodSync(path.join(dir, "age"), 0o755);
  }
  if (tools.tar) {
    writeFileSync(path.join(dir, "tar"), tools.tar);
    chmodSync(path.join(dir, "tar"), 0o755);
  }
  return uploads;
}

async function backupWithStorage(extra = {}, fake = {}, tools = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-run-"));
  const uploads = fakeTools(dir, tools);
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
          ...(typeof extra === "function" ? extra(supabase.api) : extra),
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

test("the runner holds at most two copies of the files at once, and no encrypted dump: each goes once the next step has it", async () => {
  const realAge = execFileSync("sh", ["-c", "command -v age"], { encoding: "utf8" }).trim();
  const age = `#!/bin/sh
case " $* " in
  *storage.tar*) echo "age: $(ls "$LIFEBOAT_WORKDIR" | tr '\\n' ' ')" >> "$LIFEBOAT_WORKDIR/../workdir.log" ;;
esac
exec "${realAge}" "$@"
`;
  const run = await backupWithStorage({}, {}, { age });
  assert.equal(run.status, 0, run.stderr);
  const log = readFileSync(path.join(run.dir, "workdir.log"), "utf8").split("\n");
  const listing = (line) => new Set(line.slice(line.indexOf(":") + 1).trim().split(" "));
  const encrypting = log.find((line) => line.startsWith("age: "));
  assert.ok(encrypting, "age encrypted the files archive");
  assert.ok(listing(encrypting).has("storage.tar"));
  assert.equal(listing(encrypting).has("storage"), false, "the folder is gone before encrypting");
  const uploading = log.find((line) => line.startsWith("upload lifeboat/storage/"));
  assert.ok(uploading, "the files archive was uploaded");
  assert.equal(listing(uploading).has("storage"), false);
  assert.equal(listing(uploading).has("storage.tar"), false, "the plain archive is gone before uploading");
  assert.ok([...listing(uploading)].some((name) => name.startsWith("storage.tar.")), "only the encrypted archive is left");
  assert.equal(listing(uploading).has("dump.backup.age"), false, "the encrypted dump went once it was uploaded");
  assert.ok(listing(uploading).has("dump.backup"), "the plain dump stays for the users count");
});

test("with encryption off the files go up bucket by bucket, as the S3 path always did", async () => {
  const run = await backupWithStorage({ LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(path.join(run.uploads, "lifeboat", "storage", "avatars", "top.txt"), "utf8"), "at the top");
  assert.equal(existsSync(path.join(run.work, "storage")), false);
});

test("with encryption off, a bucket whose name starts with a dot goes up too", async () => {
  const run = await backupWithStorage(
    { LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" },
    { files: { avatars: { "top.txt": "at the top" }, ".private": { "kept.txt": "in a dot bucket" } } },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(path.join(run.uploads, "lifeboat", "storage", "avatars", "top.txt"), "utf8"), "at the top");
  assert.equal(readFileSync(path.join(run.uploads, "lifeboat", "storage", ".private", "kept.txt"), "utf8"), "in a dot bucket");
});

test("files read with S3 keys go up dated now, so an unchanged one is never old enough for retention to delete", async () => {
  // aws s3 sync dates a download with when it last changed at the source. Uploaded as dated, a file nobody changed was
  // never sent again, so its copy kept its first date and retention deleted it after RETENTION_DAYS.
  const started = Math.floor(Date.now() / 1000) - 60;
  const run = await backupWithStorage({
    LIFEBOAT_ENCRYPT: "false",
    LIFEBOAT_PUBLIC_KEY: "",
    LIFEBOAT_STORAGE_LOGIN: "",
    STORAGE_S3_ENDPOINT: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
    STORAGE_S3_ACCESS_KEY_ID: "unit-test-storage-key-id",
    STORAGE_S3_SECRET_ACCESS_KEY: "unit-test-storage-secret-not-real",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.checkins[0].storageSource, "s3");
  assert.equal(readFileSync(path.join(run.uploads, "lifeboat", "storage", "media", "2024", "a.png"), "utf8"), "unchanged");
  const sent = readFileSync(path.join(run.dir, "sync-times.log"), "utf8").trim().split("\n");
  assert.equal(sent.length, 1);
  assert.ok(Number(sent[0].split(" ")[0]) >= started, `uploaded dated ${sent[0]}`);
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

test("when several parts fail, the night's error names every one first, so the check-in's 300 characters keep them all", async () => {
  // The storage login, the Supabase token and the Vercel token all refused: three parts fail on one night.
  const run = await backupWithStorage((api) => ({
    LIFEBOAT_STORAGE_LOGIN: `${EMAIL}:WrongPassword0000000000000000000`,
    LIFEBOAT_SUPABASE_TOKEN: `sbp_${"0".repeat(40)}`,
    SUPABASE_API_URL: api,
    LIFEBOAT_VERCEL_TOKEN: "unit-test-vercel-token-not-real",
    VERCEL_PROJECT_ID: "prj_unittest",
    VERCEL_API_URL: api,
  }));
  assert.notEqual(run.status, 0);
  const { error } = run.checkins[0];
  assert.match(error, /^3 parts failed: files, Supabase setup and Vercel\. Supabase did not accept the storage login/);
  assert.equal(error.length, 300, "the reasons run past what the check-in keeps; the names still came first");
  // The job log keeps every reason in full.
  for (const reason of [/did not accept the storage login/, /did not accept LIFEBOAT_SUPABASE_TOKEN/, /Vercel did not accept LIFEBOAT_VERCEL_TOKEN/]) {
    assert.match(run.stderr, reason);
  }
});

test("a users check that fails after a part failed counts as one of the failed parts, named first", async () => {
  // auth.users is in the dump without its rows, and the storage login is refused.
  const pgRestore = '#!/bin/sh\ncase " $* " in\n  *" --list "*) echo "200; 1259 17000 TABLE auth users supabase_auth_admin" ;;\nesac\nexit 0\n';
  const run = await backupWithStorage({ LIFEBOAT_STORAGE_LOGIN: `${EMAIL}:WrongPassword0000000000000000000` }, {}, { pgRestore });
  assert.notEqual(run.status, 0);
  assert.match(run.checkins[0].error, /^2 parts failed: users check and files\. The dump has the auth\.users table but none of its rows/);
  assert.match(run.stderr, /none of its rows.*Supabase did not accept the storage login/);
});

test("one failed part is named by its reason alone, as before", async () => {
  const run = await backupWithStorage({ LIFEBOAT_STORAGE_LOGIN: `${EMAIL}:WrongPassword0000000000000000000` });
  assert.notEqual(run.status, 0);
  assert.match(run.checkins[0].error, /^Supabase did not accept the storage login/);
});

test("the dump's storage.objects rows are counted, and a short copy reads as hidden only when it is clearly short", async () => {
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const text = args.includes("objects") ? "COPY storage.objects (id, bucket_id, name) FROM stdin;\n1\tb\ta\n2\tb\tb\n\\.\n" : "";
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(text));
      child.emit("close", 0);
    });
    return child;
  };
  const toc = "4300; 0 17700 TABLE DATA storage objects supabase_storage_admin\n";
  assert.equal(await storageObjectCount({ toc, dumpPath: "d", pgRestore: "pg_restore", spawnImpl }), 2);
  assert.equal(await storageObjectCount({ toc: "4268; 0 17467 TABLE DATA public notes postgres\n", dumpPath: "d", pgRestore: "pg_restore", spawnImpl }), null);
  assert.deepEqual(storageShortfall(7, 7), { state: "ok", missing: 0 });
  assert.deepEqual(storageShortfall(7, 9), { state: "ok", missing: 0 });
  assert.deepEqual(storageShortfall(3, 0), { state: "hidden", missing: 3 });
  assert.deepEqual(storageShortfall(8, 7), { state: "note", missing: 1 });
  assert.deepEqual(storageShortfall(30, 7), { state: "hidden", missing: 23 });
  assert.deepEqual(storageShortfall(1000, 960), { state: "note", missing: 40 });
  assert.deepEqual(storageShortfall(1000, 950), { state: "hidden", missing: 50 });
});

test("the dump's file names come out whole: escapes undone, a character split across output chunks kept, nulls left out", async () => {
  const rows = "COPY storage.objects (id, bucket_id, name, owner) FROM stdin;\n1\tdocs\tcaf\u00e9.pdf\t\\N\n2\tdocs\ttab\\there\t\\N\n3\tdocs\t\\N\t\\N\n\\.\n";
  const bytes = Buffer.from(rows);
  const split = bytes.indexOf(0xc3) + 1; // between the two bytes of é
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", bytes.subarray(0, split));
      child.stdout.emit("data", bytes.subarray(split));
      child.emit("close", 0);
    });
    return child;
  };
  const toc = "4300; 0 17700 TABLE DATA storage objects supabase_storage_admin\n";
  assert.deepEqual([...(await storageObjectNames({ toc, dumpPath: "d", pgRestore: "pg_restore", spawnImpl }))], ["docs/caf\u00e9.pdf", "docs/tab\there"]);
  assert.equal(await storageObjectNames({ toc: "4268; 0 17467 TABLE DATA public notes postgres\n", dumpPath: "d", pgRestore: "pg_restore", spawnImpl }), null);
  assert.equal(decodeCopyField("a\\\\b\\nc\\011d"), "a\\b\nc\td");
  assert.equal(decodeCopyField("\\N"), null);
});

test("the copy's names are its folders and files, one folder per bucket", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lifeboat-copied-names-"));
  try {
    mkdirSync(path.join(root, "avatars", "a", "deep"), { recursive: true });
    mkdirSync(path.join(root, "empty"));
    writeFileSync(path.join(root, "avatars", "a", "deep", "2.png"), "x");
    writeFileSync(path.join(root, "avatars", "top.txt"), "x");
    assert.deepEqual([...copiedStorageNames(root)].sort(), ["avatars/a/deep/2.png", "avatars/top.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the files query is read only and carries the names as one dollar-quoted value, whatever they hold", () => {
  const sql = stillThereSql(["docs/x$lastgood$y 'q'.pdf", "avatars/a/1.png"]);
  assert.match(sql, /^START TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '60s';\n/);
  assert.match(sql, /\nCOMMIT;\n$/);
  // The name holds $lastgood$, so the quote is a tag the names don't.
  assert.ok(sql.includes(`$lastgood_$[{"b":"docs","n":"x$lastgood$y 'q'.pdf"},{"b":"avatars","n":"a/1.png"}]$lastgood_$::json`));
  assert.equal(sql.split("$lastgood_$").length, 3);
});

/** The parts of the bucket a night's recorded copies are in, such as db and storage. */
function copiedParts(checkin) {
  return checkin.copies.map((copy) => copy.key.split("/")[1]);
}

test("files the bucket refuses check in with no files count, encrypted or not, and the database copy before them keeps its size", async () => {
  const plain = { LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" };
  const s3 = {
    LIFEBOAT_STORAGE_LOGIN: "",
    STORAGE_S3_ENDPOINT: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
    STORAGE_S3_ACCESS_KEY_ID: "unit-test-storage-key-id",
    STORAGE_S3_SECRET_ACCESS_KEY: "unit-test-storage-secret-not-real",
  };
  const cases = [
    ["encrypted, read with the storage login", {}, "login"],
    ["unencrypted, read with the storage login", plain, "login"],
    ["unencrypted, read with S3 keys", { ...plain, ...s3 }, "s3"],
  ];
  for (const [label, extra, source] of cases) {
    const run = await backupWithStorage(extra, {}, { refuse: "s3://bucket/lifeboat/storage/" });
    assert.equal(run.status, 1, label);
    const [checkin] = run.checkins;
    assert.equal(checkin.ok, false, label);
    assert.match(checkin.error, /^The storage refused the keys/, label);
    assert.equal(checkin.storageSource, source, label);
    assert.equal(checkin.storageObjects, 0, `${label}: no count for files that never went up`);
    assert.equal(checkin.dumpBytes, 4, `${label}: the database copy went up first and keeps its size`);
    assert.deepEqual(copiedParts(checkin), ["db"], label);
    assert.equal(existsSync(path.join(run.uploads, "lifeboat", "storage")), false, label);
  }
});

test("a disk that fills while the files are archived checks in with no files count, and the database copy before them keeps its size", async () => {
  const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  const tar = `#!/bin/sh
case " $* " in
  *"/storage.tar "*) echo "tar: storage.tar: Cannot write: No space left on device" >&2; exit 2 ;;
esac
exec "${realTar}" "$@"
`;
  const run = await backupWithStorage({}, {}, { tar });
  assert.notEqual(run.status, 0);
  const [checkin] = run.checkins;
  assert.equal(checkin.ok, false);
  assert.equal(checkin.storageObjects, 0, "no count for files that never went up");
  assert.equal(checkin.dumpBytes, 4, "the database copy went up first and keeps its size");
  assert.deepEqual(copiedParts(checkin), ["db"]);
});

/** A tar that prints `message` and fails when it packs `archive`, and is the real tar for everything else. */
function tarFailing(archive, message) {
  const realTar = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).trim();
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lg-tar-message-")), "message");
  writeFileSync(file, message);
  return `#!/bin/sh
case " $* " in
  *"/${archive} "*) cat "${file}" >&2; exit 2 ;;
esac
exec "${realTar}" "$@"
`;
}

/** The check-in carries the step's fixed sentence, never the tool's own words, and the tool's message stays in the log. */
function assertReason(label, run, error, message, words) {
  assert.notEqual(run.status, 0, label);
  assert.equal(run.checkins.length, 1, label);
  const [checkin] = run.checkins;
  assert.equal(checkin.ok, false, label);
  assert.equal(checkin.error, error, label);
  // The check-in keeps 300 characters, so the whole sentence must fit.
  assert.ok(checkin.error.length <= 300, `${label}: ${checkin.error.length}`);
  assert.doesNotMatch(checkin.error, /failed with status/, label);
  assert.doesNotMatch(checkin.error, words, `${label}: none of the tool's own words`);
  assert.ok(run.stderr.includes(message), `${label}: the tool's own message is in the run's log`);
}

const DISK = "The runner ran out of disk while packing the files into one archive.";
const TAR_FAILED = "tar could not pack the files into one archive. Its message is in this run's log in GitHub Actions.";
const TAR_WORDS = /storage\.tar|_temp|tmp\.|invoices|inv-1|avatars|Wrote only|Cannot|Permission denied|Error is not recoverable/;
const TAR_CASES = [
  ["tar: /home/runner/work/_temp/tmp.Xy12Ab/storage.tar: Cannot write: No space left on device\ntar: Error is not recoverable: exiting now", DISK],
  ["tar: /home/runner/work/_temp/tmp.Xy12Ab/storage.tar: Wrote only 4096 of 10240 bytes\ntar: Error is not recoverable: exiting now", DISK],
  ["tar: ./invoices/2026/10/inv-1.pdf: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors", TAR_FAILED],
];

test("files that cannot be packed into one archive check in with a sentence that says why, and tar's own message stays in the log", async () => {
  for (const [message, reason] of TAR_CASES) {
    const run = await backupWithStorage({}, {}, { tar: tarFailing("storage.tar", message) });
    assertReason(message, run, `${reason} Nothing was uploaded for the files.`, message, TAR_WORDS);
    assert.equal(run.checkins[0].storageObjects, 0, message);
    assert.deepEqual(copiedParts(run.checkins[0]), ["db"], message);
    assert.match(run.stderr, /The users check still runs; then this run fails\./, "the files part fails alone");
    assert.equal(existsSync(path.join(run.work, "storage")), false, "nothing of the files is left on the runner");
    assert.equal(existsSync(path.join(run.work, "storage.tar")), false, "nor the archive tar left part written");
  }
});

test("a month's first files archive that cannot be made fails the monthly copy by name, and tonight's files still went up", async () => {
  for (const [message, reason] of TAR_CASES) {
    const run = await backupWithStorage(
      { LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "", LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_MANAGE_RETENTION: "true" },
      {},
      { tar: tarFailing("monthly-storage.tar", message) },
    );
    assertReason(
      message,
      run,
      `This month's monthly copy was not made: ${reason} Tonight's files are in the bucket, and the next backup tries the monthly copy again.`,
      message,
      TAR_WORDS,
    );
    assert.equal(run.checkins[0].storageObjects, 7, "tonight's files went up, so they keep their count");
    assert.ok(existsSync(path.join(run.uploads, "lifeboat", "storage")), "tonight's files are in the bucket");
    assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false, "no monthly copy was made");
    assert.equal(existsSync(path.join(run.work, "monthly-storage.tar")), false, "the archive tar left part written is gone");
  }
});

test("files the project's own Storage S3 keys cannot read check in with a sentence that says why, and aws's message stays in the log", async () => {
  const s3 = {
    LIFEBOAT_STORAGE_LOGIN: "",
    STORAGE_S3_ENDPOINT: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3",
    STORAGE_S3_ACCESS_KEY_ID: "unit-test-storage-key-id",
    STORAGE_S3_SECRET_ACCESS_KEY: "unit-test-storage-secret-not-real",
  };
  const cases = [
    [
      " s3 ls ",
      "An error occurred (InvalidAccessKeyId) when calling the ListBuckets operation: The AWS Access Key Id you provided does not exist in our records.",
      "Supabase Storage refused the S3 access keys this workflow reads the files with. Check them in your project's Storage settings, or connect again in LastGood to make the storage login.",
    ],
    [
      " s3 ls ",
      'Could not connect to the endpoint URL: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3/"',
      "Supabase Storage didn't answer, or was too busy, while the files were copied. The next run tries again.",
    ],
    [
      " s3 sync s3://",
      "download failed: s3://media/2024/a.png to storage/media/2024/a.png [Errno 28] No space left on device",
      "The runner ran out of disk while copying the files from Supabase Storage.",
    ],
    [
      " s3 sync s3://",
      "fatal error: An error occurred (InternalError) when calling the ListObjectsV2 operation (reached max retries: 2): We encountered an internal error. Please try again.",
      "aws could not copy the files from Supabase Storage. Its message is in this run's log in GitHub Actions.",
    ],
  ];
  for (const [on, message, reason] of cases) {
    const run = await backupWithStorage(s3, {}, { fail: { on, message } });
    assertReason(message, run, `${reason} Nothing was uploaded for the files.`, message, /media|a\.png|supabase\.co|s3:\/\/|Errno|ListBuckets|InternalError|unit-test/);
    assert.equal(run.checkins[0].storageSource, "s3", message);
    assert.equal(run.checkins[0].storageObjects, 0, message);
    assert.equal(run.checkins[0].dumpBytes, 4, "the database copy went up first and keeps its size");
    assert.deepEqual(copiedParts(run.checkins[0]), ["db"], message);
    assert.match(run.stderr, /The users check still runs; then this run fails\./, "the files part fails alone");
    assert.equal(existsSync(path.join(run.work, "storage")), false, "nothing of the files is left on the runner");
  }
});

test("files a storage policy hides from the login still check in with the count that went up (B5)", async () => {
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(30) });
  assert.notEqual(run.status, 0);
  assert.equal(run.checkins[0].ok, false);
  assert.equal(run.checkins[0].storageObjects, 7, "the files it could read are in the bucket");
  assert.deepEqual(copiedParts(run.checkins[0]), ["db", "storage"]);
});

test("a copy that matches the dump's files says nothing more, and passes", async () => {
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(7) });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout + run.stderr, /hides|more than the files copy holds/);
});

test("a storage policy that hides files from the login fails the run by name, after uploading what it could read (B5)", async () => {
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(30) });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /The storage login copied 7 files of the 30 your database listed a moment earlier, so a storage policy hides 23 from it\. .*\(aal2\)\. .*lastgood-backup@lastgood\.invalid.* The files it could read were uploaded\./,
  );
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "storage")).length, 1, "the files it read still went up");
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /a storage policy hides 23 from it/);
});

test("a file the dump lists that the database no longer has was deleted between the two: noted, and the run passes", async () => {
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(8), psql: psqlAnswering("0 ") });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Files: 1 file the database dump listed was deleted before the files copy read it\. The next run copies what is there then\./);
  assert.equal(run.checkins[0].ok, true);
});

test("a few files the database still lists, hidden from the login, fail the night however few they are (B5)", async () => {
  // 1 of 8 is under the 5% the count alone allows for files deleted in between, so only the names show it.
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(8), psql: psqlAnswering("1 b") });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /The storage login could not see 1 file your database still lists: a storage policy hides it\. .*\(aal2\)\. .*lastgood-backup@lastgood\.invalid.* The files it could read were uploaded\./,
  );
  assert.match(run.stdout, /Files your database still lists that the storage login could not see are in: b\./);
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "storage")).length, 1, "the files it read still went up");
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /could not see 1 file your database still lists/);
  assert.doesNotMatch(run.checkins[0].error, /\bb\b.*n7|n7/, "no file name goes to LastGood");
  // Only the file the copy lacks is asked about, in a read-only transaction against the database being backed up.
  const sql = readFileSync(path.join(run.dir, "psql.sql"), "utf8");
  assert.match(sql, /^START TRANSACTION READ ONLY;/);
  assert.match(sql, /\[\{"b":"b","n":"n7"\}\]/);
  assert.match(readFileSync(path.join(run.dir, "psql.log"), "utf8"), /postgres:\/\/lastgood_backup\.[a-z]{20}:pw@example\.invalid\/db --no-psqlrc --quiet --tuples-only --no-align --file /);
});

test("a copy that matches the dump's count but not its names still finds the hidden file", async () => {
  // 7 rows, 7 files copied: the count alone sees nothing. One row is a file the login never saw.
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(7, 6), psql: psqlAnswering("1 b") });
  assert.notEqual(run.status, 0);
  assert.match(run.checkins[0].error, /could not see 1 file your database still lists: a storage policy hides it\./);
  assert.match(readFileSync(path.join(run.dir, "psql.sql"), "utf8"), /\[\{"b":"b","n":"n6"\}\]/);
});

test("when the database can't be asked about the missing files, the copy stands, the run passes, and a warning says it can't tell why", async () => {
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(8), psql: psqlAnswering("", 2) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /::warning::Files: the database dump lists 1 file the files copy does not hold, and the database could not be asked whether they are still there, so this run can't tell whether they were deleted between the two or a storage policy hides them from the storage login\. The next run checks again\./,
  );
  // Without an answer it never claims the files were deleted.
  assert.doesNotMatch(run.stdout, /Most likely they were deleted/);
});

test("a copy that holds every file the dump lists never asks the database", async () => {
  const run = await backupWithStorage({}, {}, { pgRestore: pgRestoreWithObjects(7), psql: psqlAnswering("1 b") });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(run.dir, "psql.sql")), false);
});

test("storage-check takes zero files copied, and refuses a count that isn't a whole number from zero", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-storage-check-"));
  const toc = path.join(dir, "toc.txt");
  writeFileSync(toc, ";\n; A dump with no storage.objects rows.\n224; 1259 17467 TABLE public notes postgres\n");
  const check = (copied) =>
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "restore-list.mjs"), "storage-check", toc, path.join(dir, "db.backup"), copied], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    assert.equal(check("0"), "none\n");
    for (const copied of ["-1", "1.5", "lots"]) {
      assert.throws(() => check(copied), (error) => /storage-check needs the number of files copied\./.test(String(error.stderr)), copied);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each request says what it sends and what it takes: JSON for the sign-in and file lists, anything for a download", async () => {
  const sent = [];
  const fetchImpl = (url, init) => {
    sent.push({ path: new URL(url).pathname, method: init.method ?? "GET", headers: init.headers });
    return fetch(url, init);
  };
  const { counts } = await copied({ fetchImpl });
  assert.equal(counts.files, 7);
  const first = (match) => sent.find(match);
  const signIn = first((request) => request.path === "/auth/v1/token");
  assert.equal(signIn.headers["Content-Type"], "application/json");
  assert.equal(signIn.headers.Accept, "application/json");
  const list = first((request) => request.path.startsWith("/storage/v1/object/list/"));
  assert.equal(list.headers["Content-Type"], "application/json");
  assert.equal(list.headers.Accept, "application/json");
  assert.equal(first((request) => request.path === "/storage/v1/bucket").headers.Accept, "application/json");
  assert.equal(first((request) => request.path.startsWith("/storage/v1/object/authenticated/")).headers.Accept, "*/*");
});

test("a refusal's reason is read from its error field when it has no error_code, an answer of JSON null is still a status, and a read refused twice names the key", async () => {
  const answering = (match, response) => (url, init) => (new URL(url).pathname === match ? Promise.resolve(response()) : fetch(url, init));
  await assert.rejects(
    copied({ fetchImpl: answering("/auth/v1/token", () => Response.json({ error: "email_provider_disabled" }, { status: 422 })) }),
    (error) => /^Supabase refused the storage login because email sign-in is turned off for this project\./.test(error.message),
  );
  await assert.rejects(
    copied({ fetchImpl: answering("/storage/v1/bucket", () => new Response("null", { status: 500, headers: { "content-type": "application/json" } })) }),
    (error) => error.message === "Supabase answered 500 when reading the list of buckets.",
  );
  await assert.rejects(
    copied({ fetchImpl: answering("/storage/v1/bucket", () => Response.json({ message: "Invalid API key" }, { status: 401 })) }),
    (error) => /^Supabase did not accept the publishable key in LIFEBOAT_SUPABASE_PUBLISHABLE_KEY\./.test(error.message),
  );
});

test("a bucket or file Supabase lists as null stops the copy by name", async () => {
  const nullBucket = (url, init) => (new URL(url).pathname === "/storage/v1/bucket" ? Promise.resolve(Response.json([null])) : fetch(url, init));
  await assert.rejects(copied({ fetchImpl: nullBucket }), (error) => error.message === "Supabase listed a bucket whose name cannot be saved as a folder.");
  await assert.rejects(copied({}, { names: () => [null] }), (error) => error.message === "Supabase listed a file in avatars whose name cannot be saved safely.");
});

test("a file or folder name too long to save on the runner stops the copy with a sentence that says so", async () => {
  // 130 characters, which Storage allows, but 256 bytes in UTF-8: one more than a Linux file name can hold.
  const long = `${"é".repeat(126)}.png`;
  const tooLong = "A file or folder in avatars has a name too long to save on the runner (over 255 bytes). Shorten it in Supabase Storage so the files copy can include it.";
  await assert.rejects(copied({}, { files: { avatars: { [long]: "x" } } }), (error) => error.message === tooLong);
  await assert.rejects(copied({}, { files: { avatars: { [`${"é".repeat(128)}/a.png`]: "x" } } }), (error) => error.message === tooLong);

  const longest = `${"é".repeat(125)}a.png`;
  assert.equal(Buffer.byteLength(longest), 255);
  const { counts, dir } = await copied({}, { files: { avatars: { [longest]: "fits" } } });
  assert.equal(counts.files, 1);
  assert.equal(readFileSync(path.join(dir, "avatars", longest), "utf8"), "fits");
});

test("a full disk or a file the runner cannot save stops the copy with a sentence that says so, without trying again", { skip: !existsSync("/dev/full") }, async () => {
  // /dev/full answers every write with ENOSPC, as a full disk does.
  const full = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  mkdirSync(path.join(full, "avatars"));
  symlinkSync("/dev/full", path.join(full, "avatars", "top.txt"));
  const supabase = await fakeSupabase();
  try {
    await assert.rejects(
      copyStorage({ ref: REF, login: LOGIN, apikey: APIKEY, dir: full, api: supabase.api, sleep: noSleep }),
      (error) => error.message === "The runner ran out of disk while copying the files in avatars.",
    );
    const asked = supabase.requests.filter((request) => request.path === "/storage/v1/object/authenticated/avatars/top.txt");
    assert.equal(asked.length, 1, "a full disk is not a download to try again");
  } finally {
    supabase.server.close();
  }

  // A folder where the file should go: the open fails, and the sentence names the error, not the network.
  const blocked = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  mkdirSync(path.join(blocked, "avatars", "top.txt"), { recursive: true });
  await assert.rejects(copied({ dir: blocked }), (error) => error.message === "A file in avatars could not be saved on the runner (EISDIR).");

  // A file where a folder should go.
  const notFolder = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  mkdirSync(path.join(notFolder, "avatars"));
  writeFileSync(path.join(notFolder, "avatars", "a"), "in the way");
  await assert.rejects(copied({ dir: notFolder }), (error) => /^A file in avatars could not be saved on the runner \((EEXIST|ENOTDIR)\)\.$/.test(error.message));
});

test("a download Supabase answers with no body is saved as an empty file", async () => {
  const noBody = (url, init) =>
    new URL(url).pathname === "/storage/v1/object/authenticated/avatars/top.txt" ? Promise.resolve(new Response(null, { status: 204 })) : fetch(url, init);
  const { counts, dir } = await copied({ fetchImpl: noBody });
  assert.equal(counts.files, 7);
  assert.equal(readFileSync(path.join(dir, "avatars", "top.txt"), "utf8"), "");
  const bytes = Object.values(FILES).reduce((sum, bucket) => sum + Object.values(bucket).join("").length, 0);
  assert.equal(counts.bytes, bytes - FILES.avatars["top.txt"].length);
});

test("without a sleep given, a busy answer waits a second on the clock before Supabase is asked again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let asked = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/auth/v1/token") return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    asked += 1;
    return asked === 1 ? Response.json({ message: "busy" }, { status: 503 }) : Response.json([]);
  };
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-"));
  const copy = copyStorage({ ref: REF, login: LOGIN, apikey: APIKEY, dir, api: "http://127.0.0.1:9", fetchImpl });
  await settle();
  assert.equal(asked, 1);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(asked, 1, "not asked again before the second is up");
  t.mock.timers.tick(1);
  assert.deepEqual(await copy, { buckets: 0, files: 0, bytes: 0 });
  assert.equal(asked, 2);
});

test("storage-copy.mjs prints a plain line, never Node's own error, when the copy fails in an unexpected way", async () => {
  const fake = await fakeSupabase();
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lg-storage-")), "not-a-folder");
  writeFileSync(file, "");
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts", "storage-copy.mjs"), path.join(file, "storage")], {
        env: { PATH: process.env.PATH, SUPABASE_PROJECT_REF: REF, LIFEBOAT_STORAGE_LOGIN: LOGIN, SUPABASE_PUBLISHABLE_KEY: APIKEY, SUPABASE_URL: fake.api },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "The storage copy failed.\n");
    assert.equal(result.stdout, "");
  } finally {
    fake.server.close();
  }
});
