import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

/**
 * Fake tools: pg_dump writes a dump; aws prints `message` on stderr and fails every call with `failOn` in it (every s3 cp
 * unless a test says otherwise), and answers every listing with `list`. With `opensslFails`, openssl prints that and fails.
 */
function fakeTools(dir, message, { failOn = " s3 cp ", list = '{"Contents":[]}', opensslFails = "" } = {}) {
  writeFileSync(path.join(dir, "aws.message"), message);
  writeFileSync(path.join(dir, "aws.list"), `${list}\n`);
  if (opensslFails) {
    writeFileSync(path.join(dir, "openssl.message"), opensslFails);
    writeFileSync(path.join(dir, "openssl"), `#!/bin/sh\ncat "${dir}/openssl.message" >&2\nexit 1\n`);
    chmodSync(path.join(dir, "openssl"), 0o755);
  }
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
case " $* " in
  *"${failOn}"*) cat "${dir}/aws.message" >&2; exit 1 ;;
  *" s3api "*) cat "${dir}/aws.list" ;;
esac
exit 0
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
}

async function backup(message, extra = {}, tools = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-errors-"));
  fakeTools(dir, message, tools);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          HOME: dir,
          LIFEBOAT_MODE: "backup",
          DATABASE_URL: "postgres://example.invalid/db",
          S3_BUCKET: "customer-bucket",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          S3_PREFIX: "lifeboat",
          LIFEBOAT_ENCRYPT: "false",
          LIFEBOAT_PUBLIC_KEY: "",
          LIFEBOAT_MANAGE_RETENTION: "false",
          LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
          CHECKIN_SECRET: "unit-test-checkin-secret",
          CHECKIN_URL: `http://127.0.0.1:${server.address().port}/checkin`,
          LIFEBOAT_WORKDIR: work,
          ...extra,
        },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stderr }));
    });
    return { ...result, bodies };
  } finally {
    server.close();
  }
}

const UPLOAD = "upload failed: ./dump.backup to s3://customer-bucket/lifeboat/db/20261026T161700Z.backup";

const CASES = [
  [`${UPLOAD} An error occurred (InvalidAccessKeyId) when calling the PutObject operation: The AWS Access Key Id you provided does not exist in our records.`, /^The storage refused the keys in LIFEBOAT_ACCESS_KEY_ID and LIFEBOAT_SECRET_ACCESS_KEY\. If LastGood hosts your copies, write to hello@lastgood\.app\./],
  [`${UPLOAD} An error occurred (AccessDenied) when calling the PutObject operation: Access Denied`, /^The storage refused the keys/],
  [`${UPLOAD} An error occurred (NoSuchBucket) when calling the PutObject operation: The specified bucket does not exist`, /^The bucket in LIFEBOAT_BUCKET doesn't exist at this storage address\./],
  [`${UPLOAD} An error occurred (PermanentRedirect) when calling the PutObject operation: The bucket you are attempting to access must be addressed using the specified endpoint.`, /^The bucket is in another region than the workflow says\./],
  [`${UPLOAD} Could not connect to the endpoint URL: "https://s3.ap-southeast-2.wasabisys.com/customer-bucket/lifeboat/db/x.backup"`, /^The storage didn't answer, or was too busy\. The next run tries again\.$/],
  [`${UPLOAD} An error occurred (SlowDown) when calling the PutObject operation: Please reduce your request rate.`, /^The storage didn't answer, or was too busy\./],
  [`${UPLOAD} something new`, /^Copying to or from storage failed\. Its message is in this run's log in GitHub Actions\.$/],
];

/** A work folder where `name`, the file a step's message once went through, keeps nothing written to it, as on a full disk. */
function lossyWorkdir(name) {
  const work = mkdtempSync(path.join(tmpdir(), "lg-lossy-"));
  symlinkSync("/dev/null", path.join(work, name));
  return work;
}

test("a failed upload checks in with a sentence that says why, and aws's own message stays in the log", async () => {
  for (const [message, reason] of CASES) {
    const run = await backup(message);
    assert.equal(run.status, 1, message);
    assert.equal(run.bodies.length, 1, message);
    const checkin = JSON.parse(run.bodies[0]);
    assert.equal(checkin.ok, false);
    assert.match(checkin.error, reason, message);
    assert.ok(checkin.error.length <= 300, `${checkin.error.length}: ${checkin.error}`);
    assert.doesNotMatch(checkin.error, /failed with status|customer-bucket|s3:\/\//);
    assert.ok(run.stderr.includes(message), "aws's own message is in the run's log");
  }
});

test("aws's message picks the check-in's sentence and reaches the log even when the work folder keeps nothing", async () => {
  const run = await backup(`${UPLOAD} An error occurred (AccessDenied) when calling the PutObject operation: Access Denied`, { LIFEBOAT_WORKDIR: lossyWorkdir("aws.err") });
  assert.equal(run.status, 1);
  assert.match(JSON.parse(run.bodies[0]).error, /^The storage refused the keys/);
  assert.match(run.stderr, /\(AccessDenied\) when calling the PutObject operation/, "aws's own message is in the run's log");
});

test("a database copy the bucket refuses checks in with no database size, encrypted or not, so it never reads as copied", async () => {
  const keys = mkdtempSync(path.join(tmpdir(), "lg-storage-errors-key-"));
  execFileSync("age-keygen", ["-o", path.join(keys, "key.txt")], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", path.join(keys, "key.txt")], { encoding: "utf8" }).trim();
  for (const extra of [{}, { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PUBLIC_KEY: publicKey }]) {
    const label = extra.LIFEBOAT_ENCRYPT ? "encrypted" : "unencrypted";
    const run = await backup(`${UPLOAD} An error occurred (AccessDenied) when calling the PutObject operation: Access Denied`, extra);
    assert.equal(run.status, 1, label);
    const checkin = JSON.parse(run.bodies[0]);
    assert.equal(checkin.ok, false, label);
    assert.match(checkin.error, /^The storage refused the keys/, label);
    assert.equal(checkin.dumpBytes, 0, `${label}: no size for a database copy that never went up`);
    assert.deepEqual(checkin.copies, [], label);
  }
});

/** The check-in carries the step's fixed sentence, never the tool's own words, and the tool's message stays in the log. */
function assertReason(label, run, error, message, words) {
  assert.equal(run.status, 1, label);
  assert.equal(run.bodies.length, 1, label);
  const checkin = JSON.parse(run.bodies[0]);
  assert.equal(checkin.ok, false, label);
  assert.equal(checkin.error, error, label);
  assert.ok(checkin.error.length <= 300, `${label}: ${checkin.error.length}`);
  assert.doesNotMatch(checkin.error, /failed with status/, label);
  assert.doesNotMatch(checkin.error, words, `${label}: none of the tool's own words`);
  assert.ok(run.stderr.includes(message), `${label}: the tool's own message is in the run's log`);
  return checkin;
}

const REFUSED = "The storage refused the keys in LIFEBOAT_ACCESS_KEY_ID and LIFEBOAT_SECRET_ACCESS_KEY. If LastGood hosts your copies, write to hello@lastgood.app. With your own bucket, check the keys and that they may read and write it.";
const RETENTION_WORDS = /customer-bucket|s3:\/\/|20200101|wasabisys|ListObjectsV2|DeleteObject|list-type/;

test("retention that cannot list the bucket or delete an old copy checks in with a sentence that says why, and aws's message stays in the log", async () => {
  const old = JSON.stringify({ Contents: [{ Key: "lifeboat/db/20200101T000000Z.backup", LastModified: "2020-01-01T00:00:00.000Z", Size: 4 }] });
  const cases = [
    [
      { failOn: " --prefix lifeboat/ " },
      "An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied",
      `Old copies were not deleted: ${REFUSED} Tonight's copies are in the bucket.`,
    ],
    [
      { failOn: " --prefix lifeboat/ " },
      'Could not connect to the endpoint URL: "https://s3.ap-southeast-2.wasabisys.com/customer-bucket?list-type=2&prefix=lifeboat%2F&encoding-type=url"',
      "Old copies were not deleted: The storage didn't answer, or was too busy. The next run tries again. Tonight's copies are in the bucket.",
    ],
    [
      { failOn: " s3 rm ", list: old },
      "delete failed: s3://customer-bucket/lifeboat/db/20200101T000000Z.backup An error occurred (AccessDenied) when calling the DeleteObject operation: Access Denied",
      `Old copies were not all deleted: ${REFUSED} Tonight's copies are in the bucket.`,
    ],
  ];
  for (const [tools, message, error] of cases) {
    const run = await backup(message, { LIFEBOAT_MANAGE_RETENTION: "true" }, tools);
    const checkin = assertReason(message, run, error, message, RETENTION_WORDS);
    assert.equal(checkin.dumpBytes, 4, "tonight's database copy went up first and keeps its size");
    assert.deepEqual(checkin.copies.map((copy) => copy.key.split("/")[1]), ["db"]);
  }
});

test("a copy openssl cannot encrypt checks in with a sentence that says why, and openssl's message stays in the log", async () => {
  const message = "error writing output file\n40C7B1F2DC7F0000:error:8000001C:system library:BIO_write:No space left on device:../crypto/bio/bss_file.c:303:calling fwrite()";
  const run = await backup(
    "",
    { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PUBLIC_KEY: "", LIFEBOAT_ENCRYPTION_PASSPHRASE: "unit-test-passphrase-not-real" },
    { failOn: "no call fails", opensslFails: message },
  );
  const checkin = assertReason(
    "openssl",
    run,
    "openssl could not encrypt the copy, so it was not uploaded. Its message is in this run's log in GitHub Actions.",
    message,
    /BIO_write|bss_file|fwrite|dump\.backup|unit-test-passphrase/,
  );
  assert.equal(checkin.dumpBytes, 0, "no size for a database copy that never went up");
  assert.deepEqual(checkin.copies, []);
});
