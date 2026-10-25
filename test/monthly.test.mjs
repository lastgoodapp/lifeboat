import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

/**
 * Fake tools. The fake aws is a small bucket under uploads/: cp uploads or copies inside it, rm deletes,
 * list-objects-v2 lists it with each file's time as LastModified, and head-object prints a version ID.
 * FAKE_AWS_FAIL_COPY makes a copy from one bucket key to another fail, and FAKE_AWS_SHORT_COPY makes it come out short.
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
const keyOf = (url) => url.replace(/^s3:\\/\\/[^/]+\\//, "");
const walk = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(folder, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
if (args.includes("head-object")) {
  const key = args[args.indexOf("--key") + 1];
  if (args.join(" ").includes("ContentLength")) {
    console.log(fs.statSync(path.join(uploads, key)).size + "\t" + ${JSON.stringify(VERSION_ID)});
  } else {
    console.log(${JSON.stringify(VERSION_ID)});
  }
} else if (args.includes("list-objects-v2")) {
  const prefix = args[args.indexOf("--prefix") + 1];
  // Some CLI versions print nothing for an empty folder.
  if (process.env.FAKE_AWS_EMPTY_LIST_SILENT && !walk(uploads).some((file) => path.relative(uploads, file).startsWith(prefix))) process.exit(0);
  const Contents = walk(uploads)
    .map((file) => ({ Key: path.relative(uploads, file), LastModified: fs.statSync(file).mtime.toISOString() }))
    .filter((object) => object.Key.startsWith(prefix));
  console.log(JSON.stringify({ Contents }));
} else if (args.includes("cp")) {
  const [source, dest] = args.slice(-2);
  if (source.startsWith("s3://") && process.env.FAKE_AWS_FAIL_COPY) {
    console.error("An error occurred (AccessDenied) when calling the CopyObject operation: Access Denied");
    process.exit(1);
  }
  const target = path.join(uploads, keyOf(dest));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source.startsWith("s3://") ? path.join(uploads, keyOf(source)) : source, target);
  // A copy inside the bucket that comes out short.
  if (source.startsWith("s3://") && process.env.FAKE_AWS_SHORT_COPY) fs.truncateSync(target, 3);
} else if (args.includes("rm")) {
  fs.rmSync(path.join(uploads, keyOf(args[args.length - 1])));
}
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
  return uploads;
}

async function checkinServer() {
  const checkins = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      checkins.push(JSON.parse(body));
      response.writeHead(202, { "content-type": "application/json" }).end("{}");
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

async function backup({ extra = {}, before } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-monthly-run-"));
  const uploads = fakeTools(dir);
  before?.(uploads);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const api = await checkinServer();
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

test("monthly copies are off by default", async () => {
  const run = await backup();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false);
  assert.doesNotMatch(run.log, /\/monthly\//);
  assert.equal(run.checkins[0].copies.length, 1);
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
});

test("a part already copied this month is left alone, and a part that is missing is filled in", async () => {
  const month = thisMonth();
  const filled = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true" },
    before: (uploads) => put(uploads, `lifeboat/monthly/${month}/repo/20000101T000000Z.tar.gz.age`),
  });
  assert.equal(filled.status, 0, filled.stderr);
  assert.equal(readdirSync(path.join(filled.uploads, "lifeboat", "monthly", month, "db")).length, 1);

  const done = await backup({
    extra: { LIFEBOAT_MONTHLY_COPIES: "true" },
    before: (uploads) => put(uploads, `lifeboat/monthly/${month}/db/20000101T000000Z.backup.age`),
  });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(readdirSync(path.join(done.uploads, "lifeboat", "monthly", month, "db")), ["20000101T000000Z.backup.age"]);
  assert.match(done.stdout, new RegExp(`This month's monthly copy is already in lifeboat/monthly/${month}/\\.`));
  assert.equal(done.checkins[0].copies.length, 1);
});

test("when the bucket's own rule decides retention, monthly copies are not made and the log warns", async () => {
  const run = await backup({ extra: { LIFEBOAT_MONTHLY_COPIES: "true", LIFEBOAT_MANAGE_RETENTION: "false" } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "monthly")), false);
  assert.match(run.stdout, /::warning::Monthly copies are on, but this bucket's own rule decides how long copies are kept, so no monthly copy was made\./);
  assert.doesNotMatch(run.log, /list-objects-v2|s3 rm /);
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
