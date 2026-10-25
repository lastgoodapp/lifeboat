import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
// A made-up version ID of the shape S3 gives. Not a real object.
const VERSION_ID = "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY";

/**
 * Fake tools. The fake aws keeps each upload under uploads/ and answers head-object the way the bucket is set up:
 * "versioned" prints a version ID, "unversioned" prints None as the real CLI does, and "denied" fails.
 */
function fakeTools(dir, bucket) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
echo "$*" >> "${dir}/aws.log"
case " $* " in
  *" head-object "*)
    case "${bucket}" in
      versioned) printf '%s\\n' '${VERSION_ID}' ;;
      unversioned) printf '%s\\n' 'None' ;;
      *) echo "An error occurred (403) when calling the HeadObject operation: Forbidden" >&2; exit 254 ;;
    esac
    ;;
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

async function checkinServer(answer = "{}") {
  const checkins = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      checkins.push(JSON.parse(body));
      response.writeHead(202, { "content-type": "application/json" }).end(answer);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, checkins };
}

async function backup({ bucket = "versioned", extra = {}, before, answer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-copies-run-"));
  const uploads = fakeTools(dir, bucket);
  const work = path.join(dir, "work");
  mkdirSync(work);
  before?.(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const api = await checkinServer(answer);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          HOME: dir,
          LIFEBOAT_MODE: "backup",
          DATABASE_URL: "postgres://example.invalid/db",
          S3_BUCKET: bucket,
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          S3_PREFIX: "lifeboat",
          LIFEBOAT_PUBLIC_KEY: publicKey,
          LIFEBOAT_MANAGE_RETENTION: "false",
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
    return { ...result, dir, uploads, checkins: api.checkins };
  } finally {
    api.server.close();
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("the check-in reports each uploaded copy with its size, the SHA-256 of the encrypted bytes and the version ID", async () => {
  const run = await backup();
  assert.equal(run.status, 0, run.stderr);
  const [name] = readdirSync(path.join(run.uploads, "lifeboat", "db"));
  assert.match(name, /^\d{8}T\d{6}Z\.backup\.age$/);
  const uploaded = path.join(run.uploads, "lifeboat", "db", name);

  assert.equal(run.checkins.length, 1);
  assert.deepEqual(run.checkins[0].copies, [
    { key: `lifeboat/db/${name}`, bytes: readFileSync(uploaded).length, sha256: sha256(uploaded), versionId: VERSION_ID },
  ]);
  assert.notEqual(run.checkins[0].copies[0].sha256, createHash("sha256").update("dump").digest("hex"), "the hash is of the copy uploaded, not the plain dump");
  assert.match(readFileSync(path.join(run.dir, "aws.log"), "utf8"), new RegExp(`s3api head-object --bucket versioned --key lifeboat/db/${name.replaceAll(".", "\\.")} --query VersionId --output text`));
});

test("a bucket without versioning, or keys that cannot read the version, still report the copy, without a version ID", async () => {
  for (const bucket of ["unversioned", "denied"]) {
    const run = await backup({ bucket });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.checkins[0].copies.length, 1);
    assert.equal(run.checkins[0].copies[0].versionId, null, bucket);
    assert.match(run.checkins[0].copies[0].sha256, /^[0-9a-f]{64}$/);
  }

  const plain = await backup({ extra: { LIFEBOAT_ENCRYPT: "false", LIFEBOAT_PUBLIC_KEY: "" } });
  assert.equal(plain.status, 0, plain.stderr);
  const [name] = readdirSync(path.join(plain.uploads, "lifeboat", "db"));
  assert.equal(plain.checkins[0].copies[0].key, `lifeboat/db/${name}`);
  assert.equal(plain.checkins[0].copies[0].sha256, createHash("sha256").update("dump").digest("hex"));
});

test("a list left in the work folder by an earlier run is never reported, and a run that uploads nothing reports no copies", async () => {
  const stale = `lifeboat/db/20200101T000000Z.backup.age\t4\t${"0".repeat(64)}\t\n`;
  const run = await backup({ before: (work) => writeFileSync(path.join(work, "copies.tsv"), stale) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.checkins[0].copies.length, 1);
  assert.notEqual(run.checkins[0].copies[0].key, "lifeboat/db/20200101T000000Z.backup.age");

  const failed = await backup({
    extra: { DATABASE_URL: "" },
    before: (work) => writeFileSync(path.join(work, "copies.tsv"), stale),
  });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.checkins[0].ok, false);
  assert.deepEqual(failed.checkins[0].copies, []);
});

test("the log warns when LastGood records fewer copies than the backup reported, and stays quiet when it records them all", async () => {
  const short = await backup({ answer: JSON.stringify({ ok: true, emailed: false, copies: { reported: 1, recorded: 0 } }) });
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /::warning::LastGood recorded 0 of the 1 copies this backup reported\. A restore refuses a copy with no record/);

  const all = await backup({ answer: JSON.stringify({ ok: true, emailed: false, copies: { reported: 1, recorded: 1 } }) });
  assert.equal(all.status, 0, all.stderr);
  assert.doesNotMatch(all.stdout, /LastGood recorded/);

  const older = await backup({ answer: "not json" });
  assert.equal(older.status, 0, older.stderr);
  assert.doesNotMatch(older.stdout, /LastGood recorded/);
});
