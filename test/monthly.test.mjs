import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { keptMonths, monthlyCopies, monthlyKeyMonth, monthOf } from "../src/monthly.mjs";
import { keysToDelete } from "../src/retention.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
// A made-up version ID of the shape S3 gives. Not a real object.
const VERSION_ID = "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY";
const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("a run stamp gives its UTC month", () => {
  assert.equal(monthOf("20261018T161700Z"), "202610");
  assert.equal(monthOf("2026-10"), null);
  assert.equal(monthOf(undefined), null);
});

test("each part gets one monthly copy a month, and a part already copied this month is left alone", () => {
  const nightly = [
    "lifeboat/db/20261001T161700Z.backup.age",
    "lifeboat/storage/20261001T161700Z.tar.age",
    "lifeboat/repo/20261001T161700Z.tar.gz.age",
    "lifeboat/db/20261001T161700Z.second.age",
    "elsewhere/db/20261001T161700Z.backup.age",
    "lifeboat/db/nested/20261001T161700Z.backup.age",
    "lifeboat/monthly/202609/db/20260901T161700Z.backup.age",
  ];
  const existing = ["lifeboat/monthly/202610/repo/20261001T020000Z.tar.gz.age", "lifeboat/monthly/202609/db/20260901T161700Z.backup.age"];
  assert.deepEqual(monthlyCopies(nightly, existing, "lifeboat", "202610"), [
    { source: "lifeboat/db/20261001T161700Z.backup.age", dest: "lifeboat/monthly/202610/db/20261001T161700Z.backup.age" },
    { source: "lifeboat/storage/20261001T161700Z.tar.age", dest: "lifeboat/monthly/202610/storage/20261001T161700Z.tar.age" },
  ]);
  assert.deepEqual(monthlyCopies(nightly, [], "lifeboat", "2026-10"), []);
  assert.deepEqual(monthlyCopies(nightly, [], "", "202610"), []);
});

test("monthly copies are kept for this month and the eleven before it", () => {
  const months = keptMonths(NOW);
  assert.equal(months.length, 12);
  assert.equal(months[0], "202610");
  assert.equal(months[11], "202511");
  assert.deepEqual(keptMonths(Date.parse("2026-01-31T23:59:59.000Z")).slice(0, 2), ["202601", "202512"]);
  assert.equal(monthlyKeyMonth("lifeboat/monthly/202610/db/x.age", "lifeboat"), "202610");
  assert.equal(monthlyKeyMonth("lifeboat/monthly/latest/db/x.age", "lifeboat"), null);
  assert.equal(monthlyKeyMonth("lifeboat/db/x.age", "lifeboat"), null);
});

test("retention deletes monthly copies by month, not by the nightly window, and keeps a folder that is not a month", () => {
  const old = "2025-01-01T00:00:00.000Z";
  const objects = [
    { key: "lifeboat/db/old.backup.age", lastModified: old },
    { key: "lifeboat/monthly/202511/db/kept.backup.age", lastModified: old },
    { key: "lifeboat/monthly/202510/db/gone.backup.age", lastModified: old },
    { key: "lifeboat/monthly/someday/db/odd.backup.age", lastModified: old },
    { key: "lifeboat/monthly/202610/db/new.backup.age", lastModified: "2026-10-01T00:00:00.000Z" },
  ];
  assert.deepEqual(keysToDelete(objects, 30, NOW, "lifeboat"), ["lifeboat/db/old.backup.age", "lifeboat/monthly/202510/db/gone.backup.age"]);
  // Without the prefix, as before monthly copies, everything follows the nightly window.
  assert.equal(keysToDelete(objects, 30, NOW).length, 4);
});

test("retention keeps a copy made exactly at the window's edge, takes a one-day window, and refuses less", () => {
  const at = (ms) => new Date(ms).toISOString();
  const objects = [
    { key: "lifeboat/db/edge.backup.age", lastModified: at(NOW - DAY_MS) },
    { key: "lifeboat/db/older.backup.age", lastModified: at(NOW - DAY_MS - 1) },
  ];
  assert.deepEqual(keysToDelete(objects, 1, NOW), ["lifeboat/db/older.backup.age"], "a copy exactly one window old is kept");
  for (const days of [0, 0.5, -1, "", "seven"]) {
    assert.throws(() => keysToDelete(objects, days, NOW), /Retention days must be a positive number\./, String(days));
  }
});

/**
 * Fake tools. The fake aws is a small bucket under uploads/: cp uploads or copies inside it, rm deletes,
 * list-objects-v2 lists it with each file's time as LastModified, and head-object prints a version ID.
 * FAKE_AWS_FAIL_COPY makes a copy from one bucket key to another fail, and FAKE_AWS_SHORT_COPY makes it come out short.
 * FAKE_STORAGE_FILES is a folder of the app's Storage buckets: ls names them, and sync copies one down, or a folder up.
 */
function fakeTools(dir) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  writeFileSync(
    path.join(dir, "aws"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const uploads = ${JSON.stringify(uploads)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "aws.log"))}, args.join(" ") + "\\n");
// A call whose arguments hold FAKE_AWS_FAIL_ON fails as the real CLI does when the storage has a bad moment.
if (process.env.FAKE_AWS_FAIL_ON && args.join(" ").includes(process.env.FAKE_AWS_FAIL_ON)) {
  console.error("An error occurred (InternalError) when calling the operation: We encountered an internal error. Please try again. (503)");
  process.exit(254);
}
const keyOf = (url) => url.replace(/^s3:\\/\\/[^/]+\\//, "");
// LastGood's monthly bucket (B14) is a second bucket beside uploads/, which this key can put to and list but not read.
const monthlyRoot = uploads + "-monthly";
const isMonthly = (bucket) => bucket.startsWith("lastgood-monthly-");
const rootOfUrl = (url) => (isMonthly(url.replace(/^s3:\\/\\//, "")) ? monthlyRoot : uploads);
const bucketArg = () => args[args.indexOf("--bucket") + 1] || "";
const walk = (folder) => !fs.existsSync(folder) ? [] : fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(folder, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
if (args.includes("head-object") && isMonthly(bucketArg())) {
  console.error("An error occurred (403) when calling the HeadObject operation: Forbidden");
  process.exit(254);
} else if (args.includes("list-object-versions")) {
  const root = isMonthly(bucketArg()) ? monthlyRoot : uploads;
  const prefix = args[args.indexOf("--prefix") + 1];
  const Versions = walk(root)
    .map((file) => ({ Key: path.relative(root, file), Size: fs.statSync(file).size, VersionId: ${JSON.stringify(VERSION_ID)}, IsLatest: true }))
    .filter((object) => object.Key.startsWith(prefix));
  console.log(JSON.stringify({ Versions }));
} else if (args.includes("head-object")) {
  const key = args[args.indexOf("--key") + 1];
  if (args.join(" ").includes("ContentLength")) {
    console.log(fs.statSync(path.join(uploads, key)).size + "\t" + ${JSON.stringify(VERSION_ID)});
  } else {
    console.log(${JSON.stringify(VERSION_ID)});
  }
} else if (args.includes("list-objects-v2")) {
  const root = isMonthly(bucketArg()) ? monthlyRoot : uploads;
  const prefix = args[args.indexOf("--prefix") + 1];
  if (process.env.FAKE_AWS_BAD_LIST) {
    console.log("<html>not a list</html>");
    process.exit(0);
  }
  // Some CLI versions print nothing for an empty folder.
  if (process.env.FAKE_AWS_EMPTY_LIST_SILENT && !walk(root).some((file) => path.relative(root, file).startsWith(prefix))) process.exit(0);
  const Contents = walk(root)
    .map((file) => ({ Key: path.relative(root, file), LastModified: fs.statSync(file).mtime.toISOString() }))
    .filter((object) => object.Key.startsWith(prefix));
  console.log(JSON.stringify({ Contents }));
} else if (args.includes("cp")) {
  const [source, dest] = args.slice(-2);
  if (source.startsWith("s3://") && process.env.FAKE_AWS_FAIL_COPY) {
    console.error("An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied");
    process.exit(1);
  }
  const target = path.join(dest.startsWith("s3://") ? rootOfUrl(dest) : uploads, keyOf(dest));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source.startsWith("s3://") ? path.join(rootOfUrl(source), keyOf(source)) : source, target);
  // A copy inside the bucket that comes out short.
  if (source.startsWith("s3://") && process.env.FAKE_AWS_SHORT_COPY) fs.truncateSync(target, 3);
} else if (args.includes("rm")) {
  const url = args[args.length - 1];
  if (rootOfUrl(url) === monthlyRoot) {
    console.error("An error occurred (AccessDenied) when calling the DeleteObject operation: Access Denied");
    process.exit(1);
  }
  fs.rmSync(path.join(uploads, keyOf(url)));
} else if (args.includes("sync")) {
  const [source, dest] = args.slice(-2);
  const tree = (from, to) => {
    for (const file of walk(from)) {
      const target = path.join(to, path.relative(from, file));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
    }
  };
  if (!source.startsWith("s3://")) tree(source, path.join(rootOfUrl(dest), keyOf(dest)));
  else if (process.env.FAKE_STORAGE_FILES) tree(path.join(process.env.FAKE_STORAGE_FILES, source.slice(5)), dest);
} else if (args.includes("ls") && process.env.FAKE_STORAGE_FILES) {
  for (const name of fs.readdirSync(process.env.FAKE_STORAGE_FILES)) console.log("2026-10-01 00:00:00 " + name);
}
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
  return uploads;
}

async function checkinServer(status = 202) {
  const checkins = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      checkins.push(JSON.parse(body));
      response.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, checkins };
}

/** Writes a file into the fake bucket, optionally dated some days ago. */
function put(uploads, key, daysAgo = 0) {
  const file = path.join(uploads, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key);
  const when = new Date(Date.now() - daysAgo * DAY_MS);
  utimesSync(file, when, when);
}

/**
 * `now` runs the backup as if at that time: a fake date answers with it when asked for the time now, and does any other
 * sum (such as "+1 day") with the real one.
 */
async function backup({ extra = {}, before, checkinStatus, now } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-monthly-run-"));
  const uploads = fakeTools(dir);
  if (now) {
    const real = execFileSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(dir, "date"), `#!/bin/sh\ncase " $* " in *" -d "*) exec ${real} "$@" ;; esac\nexec ${real} -d ${JSON.stringify(now)} "$@"\n`);
    chmodSync(path.join(dir, "date"), 0o755);
  }
  before?.(uploads);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const api = await checkinServer(checkinStatus);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          HOME: dir,
          LIFEBOAT_MODE: "backup",
          DATABASE_URL: "postgres://example.invalid/db",
          S3_BUCKET: "own-bucket",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          S3_PREFIX: "lifeboat",
          LIFEBOAT_PUBLIC_KEY: publicKey,
          LIFEBOAT_MANAGE_RETENTION: "true",
          LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
          CHECKIN_SECRET: "unit-test-checkin-secret",
          CHECKIN_URL: `http://127.0.0.1:${api.port}/checkin`,
          LIFEBOAT_WORKDIR: work,
          ...extra,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, dir, uploads, checkins: api.checkins, log: readFileSync(path.join(dir, "aws.log"), "utf8") };
  } finally {
    api.server.close();
  }
}

function nightlyDump(uploads) {
  const [name] = readdirSync(path.join(uploads, "lifeboat", "db")).filter((file) => /^\d{8}T\d{6}Z\.backup\.age$/.test(file));
  return name;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const thisMonth = () => new Date().toISOString().slice(0, 7).replace("-", "");

/** What a run's check-in said the month's monthly copy came to, and why. */
const monthlySent = (run) => [run.checkins[0].monthlyState, run.checkins[0].monthlyReason];

test("monthly copies are off by default", async () => {
  const run = await backup();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false);
  assert.doesNotMatch(run.log, /\/monthly\//);
  assert.equal(run.checkins[0].copies.length, 1);
  assert.deepEqual(monthlySent(run), ["off", null]);
});

test("with monthly copies on, the first good backup of the month copies the dump inside the bucket and reports it", async () => {
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", FAKE_AWS_EMPTY_LIST_SILENT: "1" } });
  assert.equal(run.status, 0, run.stderr);
  const name = nightlyDump(run.uploads);
  const month = name.slice(0, 6);
  const nightly = path.join(run.uploads, "lifeboat", "db", name);
  const monthly = path.join(run.uploads, "lifeboat", "monthly", month, "db", name);
  assert.deepEqual(readFileSync(monthly), readFileSync(nightly), "the monthly copy is the same file, not encrypted again");
  assert.match(run.log, new RegExp(`s3 cp s3://own-bucket/lifeboat/db/${name.replaceAll(".", "\\.")} s3://own-bucket/lifeboat/monthly/${month}/db/`));
  assert.match(run.stdout, new RegExp(`Monthly copy kept for twelve months: lifeboat/monthly/${month}/db/`));
  assert.deepEqual(run.checkins[0].copies, [
    { key: `lifeboat/db/${name}`, bytes: readFileSync(nightly).length, sha256: sha256(nightly), versionId: VERSION_ID },
    { key: `lifeboat/monthly/${month}/db/${name}`, bytes: readFileSync(nightly).length, sha256: sha256(nightly), versionId: VERSION_ID },
  ]);
  assert.equal(run.checkins[0].ok, true);
  assert.deepEqual(monthlySent(run), ["made", null]);
});

test("with encryption off, the month's first night keeps the synced files as one archive in the monthly copy", async () => {
  // Hand-set S3 keys for the files, and a project with two files in one bucket.
  const storage = mkdtempSync(path.join(tmpdir(), "lg-monthly-files-"));
  mkdirSync(path.join(storage, "avatars", "team"), { recursive: true });
  writeFileSync(path.join(storage, "avatars", "a.png"), "first file");
  writeFileSync(path.join(storage, "avatars", "team", "b.png"), "second file");
  const files = {
    STORAGE_S3_ENDPOINT: "https://storage.example.invalid",
    STORAGE_S3_ACCESS_KEY_ID: "unit-test-id",
    STORAGE_S3_SECRET_ACCESS_KEY: "unit-test-secret",
    FAKE_STORAGE_FILES: storage,
  };
  const plain = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_ENCRYPT: "false", ...files } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.checkins[0].storageSource, "s3");
  assert.equal(readFileSync(path.join(plain.uploads, "lifeboat", "storage", "avatars", "team", "b.png"), "utf8"), "second file", "the nightly sync is as before");
  const month = thisMonth();
  const [name] = readdirSync(path.join(plain.uploads, "lifeboat", "monthly", month, "storage"));
  assert.match(name, /^\d{8}T\d{6}Z\.tar$/);
  const archive = path.join(plain.uploads, "lifeboat", "monthly", month, "storage", name);
  const listed = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split("\n").filter((entry) => entry && !entry.endsWith("/")).sort();
  assert.deepEqual(listed, ["./avatars/a.png", "./avatars/team/b.png"]);
  assert.equal(execFileSync("tar", ["-xOf", archive, "./avatars/team/b.png"], { encoding: "utf8" }), "second file");
  assert.match(plain.stdout, new RegExp(`Monthly copy kept for twelve months: lifeboat/monthly/${month}/storage/${name.replace(".", "\\.")}`));
  assert.match(plain.stdout, /Monthly copy kept for twelve months: lifeboat\/monthly\/\d{6}\/db\//);
  assert.doesNotMatch(plain.stdout, /leaves them out/);
  const recorded = plain.checkins[0].copies.find((copy) => copy.key === `lifeboat/monthly/${month}/storage/${name}`);
  assert.deepEqual(recorded, { key: `lifeboat/monthly/${month}/storage/${name}`, bytes: readFileSync(archive).length, sha256: sha256(archive), versionId: VERSION_ID });
  assert.equal(existsSync(path.join(plain.dir, "work", "monthly-storage.tar")), false);
  assert.deepEqual(monthlySent(plain), ["made", null]);

  // A later night this month, with the files' monthly copy already there, keeps no archive and makes no second one.
  const later = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_ENCRYPT: "false", ...files },
    before: (uploads) => {
      put(uploads, `lifeboat/monthly/${month}/storage/${month}01T161700Z.tar`);
      put(uploads, `lifeboat/monthly/${month}/db/${month}01T161700Z.backup`);
    },
  });
  assert.equal(later.status, 0, later.stderr);
  assert.deepEqual(readdirSync(path.join(later.uploads, "lifeboat", "monthly", month, "storage")), [`${month}01T161700Z.tar`]);
  assert.match(later.stdout, new RegExp(`This month's monthly copy is already in lifeboat/monthly/${month}/\\.`));
  assert.ok(later.checkins[0].copies.every((copy) => !copy.key.includes("/monthly/")));
  assert.deepEqual(monthlySent(later), ["already", null]);

  // Encrypted, the files are one copy like the rest and go in by the usual route. Without monthly copies, or without
  // this key keeping them, nothing is kept.
  const encrypted = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", ...files } });
  assert.equal(encrypted.status, 0, encrypted.stderr);
  assert.match(readdirSync(path.join(encrypted.uploads, "lifeboat", "monthly", month, "storage"))[0], /^\d{8}T\d{6}Z\.tar\.age$/);
  for (const extra of [{}, { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_MANAGE_RETENTION: "false" }]) {
    const off = await backup({ extra: { LIFEBOAT_ENCRYPT: "false", ...files, ...extra } });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(existsSync(path.join(off.uploads, "lifeboat", "monthly")), false, JSON.stringify(extra));
    assert.doesNotMatch(off.log, /\/monthly\/\d{6}\/storage\//);
  }
});

test("a files archive that won't upload fails the night and says the next backup tries again", async () => {
  const storage = mkdtempSync(path.join(tmpdir(), "lg-monthly-files-"));
  mkdirSync(path.join(storage, "avatars"));
  writeFileSync(path.join(storage, "avatars", "a.png"), "first file");
  const run = await backup({
    extra: {
      LIFEBOAT_MONTHLY_COPIES: "true",
      LIFEBOAT_ENCRYPT: "false",
      STORAGE_S3_ENDPOINT: "https://storage.example.invalid",
      STORAGE_S3_ACCESS_KEY_ID: "unit-test-id",
      STORAGE_S3_SECRET_ACCESS_KEY: "unit-test-secret",
      FAKE_STORAGE_FILES: storage,
      FAKE_AWS_FAIL_ON: "monthly-storage.tar",
    },
  });
  assert.equal(run.status, 1);
  assert.equal(
    run.checkins[0].error,
    "The monthly copy of the files was not made. Tonight's copies are in the bucket, and the next backup tries the monthly copy again.",
  );
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly", thisMonth(), "storage")), false);
  // The database's monthly copy went up first, but a night whose monthly copy failed says no state: its error says why.
  assert.ok(existsSync(path.join(run.uploads, "lifeboat", "monthly", thisMonth(), "db")));
  assert.deepEqual(monthlySent(run), [null, null]);
});

test("a monthly copy whose check-in never got through is removed, so a later backup this month makes and records it", async () => {
  // The first of this month, so the run is never on the month's last day, which says something else (the test below).
  const today = new Date();
  const firstDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1, 16, 17)).toISOString();
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_CHECKIN_WAIT_MS: "1" }, checkinStatus: 503, now: firstDay });
  assert.equal(run.status, 1);
  assert.equal(run.checkins.length, 3, "the check-in was tried three times");
  const name = nightlyDump(run.uploads);
  const month = name.slice(0, 6);
  const key = `lifeboat/monthly/${month}/db/${name}`;
  assert.equal(run.checkins[0].copies[1].key, key, "it was made and reported");
  assert.equal(existsSync(path.join(run.uploads, key)), false);
  assert.ok(existsSync(path.join(run.uploads, "lifeboat", "db", name)), "tonight's own copy stays");
  assert.match(run.log, new RegExp(`s3 rm s3://own-bucket/${key.replaceAll(".", "\\.")}\n`));
  assert.match(run.stdout, new RegExp(`Removed the monthly copy ${key.replaceAll(".", "\\.")}: LastGood has no record of it\\. The next good backup this month makes it again\\.`));

  // The next good night, on the same bucket, makes the month's copy again from its own copy and records it.
  const next = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true" }, before: (uploads) => cpSync(run.uploads, uploads, { recursive: true }) });
  assert.equal(next.status, 0, next.stderr);
  // The bucket holds both nights' dumps now: tonight's is the one this check-in reported first.
  const nextName = path.basename(next.checkins[0].copies[0].key);
  const nextKey = `lifeboat/monthly/${nextName.slice(0, 6)}/db/${nextName}`;
  const nightly = path.join(next.uploads, "lifeboat", "db", nextName);
  assert.deepEqual(readFileSync(path.join(next.uploads, nextKey)), readFileSync(nightly));
  assert.deepEqual(next.checkins[0].copies[1], { key: nextKey, bytes: readFileSync(nightly).length, sha256: sha256(nightly), versionId: VERSION_ID });
  assert.doesNotMatch(next.stdout, /Removed the monthly copy|already in/);

  const stuck = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_CHECKIN_WAIT_MS: "1", FAKE_AWS_FAIL_ON: "rm s3://own-bucket/lifeboat/monthly/" },
    checkinStatus: 503,
  });
  assert.equal(stuck.status, 1);
  const stuckName = nightlyDump(stuck.uploads);
  const stuckKey = `lifeboat/monthly/${stuckName.slice(0, 6)}/db/${stuckName}`;
  assert.ok(existsSync(path.join(stuck.uploads, stuckKey)));
  assert.ok(
    stuck.stdout.includes(
      `::warning::The monthly copy ${stuckKey} has no record in LastGood and could not be removed. Delete it so the next backup makes it again. Until then it opens only with the lastgood CLI's --unchecked.`,
    ),
  );
});

test("Lifeboat's own work folder goes only after a check-in that never got through has removed the monthly copy", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "lg-monthly-tmp-"));
  const run = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_CHECKIN_WAIT_MS: "1", LIFEBOAT_WORKDIR: "", TMPDIR: tmp },
    checkinStatus: 503,
  });
  assert.equal(run.status, 1);
  const name = nightlyDump(run.uploads);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly", name.slice(0, 6), "db", name)), false, "the copies list was still there to read");
  assert.match(run.stdout, /Removed the monthly copy/);
  assert.deepEqual(readdirSync(tmp), [], "and then the folder went");
});

test("a monthly copy removed on the month's last day says that month has no monthly copy", async () => {
  // The last day of this month, so retention keeps the month's folder whenever this test runs.
  const today = new Date();
  const lastDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 16, 17));
  const month = lastDay.toISOString().slice(0, 7).replace("-", "");
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_CHECKIN_WAIT_MS: "1" }, checkinStatus: 503, now: lastDay.toISOString() });
  assert.equal(run.status, 1);
  const name = nightlyDump(run.uploads);
  assert.equal(name.slice(0, 8), lastDay.toISOString().slice(0, 10).replaceAll("-", ""), "the run took the fake date");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly", month, "db", name)), false);
  assert.ok(run.stdout.includes(`Removed the monthly copy lifeboat/monthly/${month}/db/${name}: LastGood has no record of it.\n`));
  assert.doesNotMatch(run.stdout, /The next good backup this month/);
  assert.ok(
    run.stdout.includes(
      `::warning::Today is the last day of ${month} (UTC), so ${month} has no monthly copy of what was removed. Next month's first good backup makes next month's as usual.`,
    ),
  );

  // Any other day says nothing of the kind.
  const midMonth = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_CHECKIN_WAIT_MS: "1" },
    checkinStatus: 503,
    now: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1, 16, 17)).toISOString(),
  });
  assert.match(midMonth.stdout, /The next good backup this month makes it again\./);
  assert.doesNotMatch(midMonth.stdout, /has no monthly copy/);
});

test("a monthly copy whose check-in LastGood refused stays, since the next night would be refused too", async () => {
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true" }, checkinStatus: 401 });
  assert.equal(run.status, 1);
  assert.equal(run.checkins.length, 1);
  const name = nightlyDump(run.uploads);
  assert.ok(existsSync(path.join(run.uploads, "lifeboat", "monthly", name.slice(0, 6), "db", name)));
  assert.doesNotMatch(run.log, /s3 rm .*\/monthly\//);
  assert.doesNotMatch(run.stdout, /Removed the monthly copy/);
});

test("a part already copied this month is left alone, and a part that is missing is filled in", async () => {
  const month = thisMonth();
  const filled = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true" },
    before: (uploads) => put(uploads, `lifeboat/monthly/${month}/repo/20000101T000000Z.tar.gz.age`),
  });
  assert.equal(filled.status, 0, filled.stderr);
  assert.equal(readdirSync(path.join(filled.uploads, "lifeboat", "monthly", month, "db")).length, 1);
  assert.deepEqual(monthlySent(filled), ["made", null], "a part filled in is made too");

  const done = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true" },
    before: (uploads) => put(uploads, `lifeboat/monthly/${month}/db/20000101T000000Z.backup.age`),
  });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(readdirSync(path.join(done.uploads, "lifeboat", "monthly", month, "db")), ["20000101T000000Z.backup.age"]);
  assert.match(done.stdout, new RegExp(`This month's monthly copy is already in lifeboat/monthly/${month}/\\.`));
  assert.equal(done.checkins[0].copies.length, 1);
  assert.deepEqual(monthlySent(done), ["already", null]);
});

test("when the bucket's own rule decides retention, monthly copies are not made, the log warns and the check-in says why", async () => {
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_MANAGE_RETENTION: "false" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false);
  assert.match(
    run.stdout,
    /::warning::Monthly copies are on, but no monthly copy was made: this bucket's own rule decides how long copies are kept, and no monthly bucket is set\./,
  );
  assert.doesNotMatch(run.log, /list-objects-v2|s3 rm /);
  assert.equal(run.checkins[0].ok, true);
  assert.deepEqual(monthlySent(run), ["none", "no-monthly-bucket"]);
});

test("a monthly copy that cannot be made fails the run, which still reports the night's copy", async () => {
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", FAKE_AWS_FAIL_COPY: "1" } });
  assert.notEqual(run.status, 0);
  const name = nightlyDump(run.uploads);
  assert.match(run.stderr, new RegExp(`The monthly copy of ${name.replaceAll(".", "\\.")} was not made\\. Tonight's copies are in the bucket, and the next backup tries the monthly copy again\\.`));
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /The monthly copy of/);
  assert.deepEqual(run.checkins[0].copies.map((copy) => copy.key), [`lifeboat/db/${name}`]);
  assert.doesNotMatch(run.log, / s3 rm /, "retention did not run");
  assert.deepEqual(monthlySent(run), [null, null]);
});

test("a monthly copy that comes out the wrong size is removed, never recorded, and fails the run", async () => {
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", FAKE_AWS_SHORT_COPY: "1" } });
  assert.notEqual(run.status, 0);
  const name = nightlyDump(run.uploads);
  const month = name.slice(0, 6);
  const bytes = readFileSync(path.join(run.uploads, "lifeboat", "db", name)).length;
  assert.match(run.stderr, new RegExp(`The monthly copy of ${name.replaceAll(".", "\\.")} did not come out at ${bytes} bytes, so it was removed and not recorded\\.`));
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly", month, "db", name)), false, "the short copy is gone, so the next backup makes it again");
  assert.deepEqual(run.checkins[0].copies.map((copy) => copy.key), [`lifeboat/db/${name}`]);
  assert.match(run.log, /head-object --bucket own-bucket --key lifeboat\/monthly\/\d{6}\/db\/\S+ --query \[ContentLength,VersionId\]/);
});

test("a monthly listing or size check the bucket does not answer says so, and the night's copy is still reported", async () => {
  const listing = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", FAKE_AWS_FAIL_ON: "--prefix lifeboat/monthly/" } });
  assert.notEqual(listing.status, 0);
  assert.equal(
    listing.checkins[0].error,
    "This month's monthly copy was not made: The storage didn't answer, or was too busy. The next run tries again. Tonight's copies are in the bucket.",
  );
  assert.equal(listing.checkins[0].copies.length, 1, "tonight's copy is still reported");
  assert.match(listing.stderr, /InternalError/, "the CLI's own message stays in the log");

  const sized = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", FAKE_AWS_FAIL_ON: "[ContentLength,VersionId]" } });
  assert.notEqual(sized.status, 0);
  const name = nightlyDump(sized.uploads);
  assert.equal(
    sized.checkins[0].error,
    `The bucket did not say what size the monthly copy of ${name} came out, so it was removed and not recorded. Tonight's copies are in the bucket, and the next backup makes the monthly copy again.`,
  );
  assert.equal(existsSync(path.join(sized.uploads, "lifeboat", "monthly", name.slice(0, 6), "db", name)), false, "an unchecked copy is removed, so the next backup makes it again");
  assert.deepEqual(sized.checkins[0].copies.map((copy) => copy.key), [`lifeboat/db/${name}`]);
});

test("retention keeps monthly copies for twelve months and deletes older ones, with monthly copies on or off", async () => {
  const now = new Date();
  const monthBack = (back) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const keys = {
    oldNight: "lifeboat/db/20000101T000000Z.backup.age",
    elevenBack: `lifeboat/monthly/${monthBack(11)}/db/20000101T000000Z.backup.age`,
    twelveBack: `lifeboat/monthly/${monthBack(12)}/db/20000101T000000Z.backup.age`,
    odd: "lifeboat/monthly/someday/db/20000101T000000Z.backup.age",
  };
  const run = await backup({ before: (uploads) => Object.values(keys).forEach((key) => put(uploads, key, 400)) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(run.uploads, keys.oldNight)), false);
  assert.equal(existsSync(path.join(run.uploads, keys.twelveBack)), false);
  assert.equal(existsSync(path.join(run.uploads, keys.elevenBack)), true);
  assert.equal(existsSync(path.join(run.uploads, keys.odd)), true);
  assert.equal(run.checkins[0].deletedObjects, 2);
});

const MONTHLY_BUCKET = "lastgood-monthly-ap-southeast-2";
const HOSTED = { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_MANAGE_RETENTION: "false", LIFEBOAT_MONTHLY_BUCKET: MONTHLY_BUCKET, FAKE_AWS_EMPTY_LIST_SILENT: "1" };

test("on LastGood's storage, the month's first good backup is copied to the monthly bucket, checked by listing, and reported", async () => {
  const run = await backup({ extra: HOSTED });
  assert.equal(run.status, 0, run.stderr);
  const name = nightlyDump(run.uploads);
  const month = name.slice(0, 6);
  const monthly = path.join(`${run.uploads}-monthly`, "lifeboat", "monthly", month, "db", name);
  assert.deepEqual(readFileSync(monthly), readFileSync(path.join(run.uploads, "lifeboat", "db", name)), "the same file, not encrypted again");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false, "nothing monthly in the nightly bucket, where it would expire at 30 days");
  const escaped = name.replaceAll(".", "\\.");
  assert.match(run.log, new RegExp(`s3 cp s3://own-bucket/lifeboat/db/${escaped} s3://${MONTHLY_BUCKET}/lifeboat/monthly/${month}/db/${escaped}`));
  assert.match(run.log, new RegExp(`list-objects-v2 --bucket ${MONTHLY_BUCKET} --prefix lifeboat/monthly/${month}/`));
  assert.match(run.log, new RegExp(`list-object-versions --bucket ${MONTHLY_BUCKET} --prefix lifeboat/monthly/${month}/db/${escaped}`));
  assert.doesNotMatch(run.log, new RegExp(`head-object --bucket ${MONTHLY_BUCKET}`), "this key can't read the monthly bucket");
  assert.doesNotMatch(run.log, / s3 rm /, "and the job never deletes on LastGood's storage");
  const reported = run.checkins[0].copies.find((copy) => copy.key === `lifeboat/monthly/${month}/db/${name}`);
  assert.ok(reported, "the monthly copy is in the check-in's copies");
  assert.equal(reported.sha256, sha256(monthly));
  assert.equal(reported.versionId, VERSION_ID);
  assert.deepEqual(monthlySent(run), ["made", null]);
});

test("on LastGood's storage with encryption off, the files archive goes to the monthly bucket with the other monthly copies", async () => {
  const storage = mkdtempSync(path.join(tmpdir(), "lg-monthly-files-"));
  mkdirSync(path.join(storage, "avatars"), { recursive: true });
  writeFileSync(path.join(storage, "avatars", "a.png"), "first file");
  const files = {
    STORAGE_S3_ENDPOINT: "https://storage.example.invalid",
    STORAGE_S3_ACCESS_KEY_ID: "unit-test-id",
    STORAGE_S3_SECRET_ACCESS_KEY: "unit-test-secret",
    FAKE_STORAGE_FILES: storage,
  };
  const run = await backup({ extra: { ...HOSTED, LIFEBOAT_ENCRYPT: "false", ...files } });
  assert.equal(run.status, 0, run.stderr);
  const month = thisMonth();
  const [name] = readdirSync(path.join(`${run.uploads}-monthly`, "lifeboat", "monthly", month, "storage"));
  assert.match(name, /^\d{8}T\d{6}Z\.tar$/);
  const archive = path.join(`${run.uploads}-monthly`, "lifeboat", "monthly", month, "storage", name);
  assert.equal(execFileSync("tar", ["-xOf", archive, "./avatars/a.png"], { encoding: "utf8" }), "first file");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false, "nothing monthly in the nightly bucket, where it would expire at 30 days");
  assert.match(run.log, new RegExp(`list-objects-v2 --bucket ${MONTHLY_BUCKET} --prefix lifeboat/monthly/${month}/storage/`));
  assert.doesNotMatch(run.log, new RegExp(`head-object --bucket ${MONTHLY_BUCKET}`), "this key can't read the monthly bucket");
  assert.doesNotMatch(run.log, / s3 rm /);
  const recorded = run.checkins[0].copies.find((copy) => copy.key === `lifeboat/monthly/${month}/storage/${name}`);
  assert.deepEqual(recorded, { key: `lifeboat/monthly/${month}/storage/${name}`, bytes: readFileSync(archive).length, sha256: sha256(archive), versionId: VERSION_ID });
});

test("on LastGood's storage, a monthly copy of the wrong size fails the run, isn't recorded, and isn't deleted", async () => {
  const run = await backup({ extra: { ...HOSTED, FAKE_AWS_SHORT_COPY: "1" } });
  assert.notEqual(run.status, 0);
  const name = nightlyDump(run.uploads);
  const bytes = readFileSync(path.join(run.uploads, "lifeboat", "db", name)).length;
  assert.match(run.stderr, new RegExp(`The monthly copy of ${name.replaceAll(".", "\\.")} did not come out at ${bytes} bytes, so it was not recorded\\.`));
  assert.deepEqual(run.checkins[0].copies.map((copy) => copy.key), [`lifeboat/db/${name}`]);
  assert.doesNotMatch(run.log, / s3 rm /);
});

test("on LastGood's storage, a monthly copy whose check-in never got through stays under the monthly bucket's lock, and the log says to tell LastGood", async () => {
  const run = await backup({ extra: { ...HOSTED, LIFEBOAT_CHECKIN_WAIT_MS: "1" }, checkinStatus: 503 });
  assert.equal(run.status, 1);
  const name = nightlyDump(run.uploads);
  const key = `lifeboat/monthly/${name.slice(0, 6)}/db/${name}`;
  assert.equal(run.checkins[0].copies[1].key, key, "it was made and reported");
  assert.ok(existsSync(path.join(`${run.uploads}-monthly`, key)), "the copy stays");
  assert.doesNotMatch(run.log, / s3 rm /, "this key can't delete there, so it doesn't try");
  assert.doesNotMatch(run.stdout, /Removed the monthly copy/);
  assert.ok(
    run.stdout.includes(
      `::warning::The monthly copy ${key} has no record in LastGood. LastGood's monthly bucket keeps it under its lock. It opens only with the lastgood CLI's --unchecked. Tell hello@lastgood.app.`,
    ),
    run.stdout,
  );
  const monthly = run.checkins[0].copies.filter((copy) => copy.key.startsWith("lifeboat/monthly/"));
  assert.equal(run.stdout.match(/::warning::The monthly copy \S+ has no record in LastGood\./g)?.length, monthly.length, "one warning per copy");
});

test("retention that cannot work out what to delete deletes nothing and says why, and the night stays good", async () => {
  const old = "lifeboat/db/20000101T000000Z.backup.age";
  for (const [extra, why] of [
    [{ RETENTION_DAYS: "0" }, "retention-days is not a number of days, 1 or more. Set it to one, or set manage-retention to false to leave retention to the bucket."],
    [{ RETENTION_DAYS: "30 days" }, "retention-days is not a number of days, 1 or more."],
    [{ RETENTION_DAYS: "Infinity" }, "retention-days is not a number of days, 1 or more."],
    [{ FAKE_AWS_BAD_LIST: "1" }, "The bucket's list of copies could not be read."],
  ]) {
    const run = await backup({ extra, before: (uploads) => put(uploads, old, 400) });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`::warning::Nothing was deleted from the bucket. ${why}`), run.stdout);
    assert.equal(existsSync(path.join(run.uploads, old)), true);
    assert.doesNotMatch(run.log, / s3 rm /);
    assert.equal(run.checkins[0].ok, true);
    assert.equal(run.checkins[0].deletedObjects, 0);
  }
});
