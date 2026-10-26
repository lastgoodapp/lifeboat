import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

/**
 * Fake tools. pg_dump prints `message` on stderr, then fails with exit 1, or, with `dumps`, also writes the dump and
 * succeeds (a warning on a good night). aws keeps nothing and answers every listing empty.
 */
function fakeTools(dir, message, dumps) {
  writeFileSync(path.join(dir, "pg_dump.message"), message);
  writeFileSync(
    path.join(dir, "pg_dump"),
    `#!/bin/sh
cat "${dir}/pg_dump.message" >&2
${dumps ? "" : "exit 1"}
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then printf 'dump' > "$2"; exit 0; fi
  shift
done
exit 1
`,
  );
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
case " $* " in
  *" s3api "*) printf '%s\\n' '{"Contents":[]}' ;;
esac
exit 0
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
}

async function backup(message, { dumps = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-dump-errors-"));
  fakeTools(dir, message, dumps);
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
          S3_BUCKET: "unversioned",
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

const HOST = 'connection to server at "aws-0-ap-southeast-2.pooler.supabase.com" (13.236.0.1), port 5432 failed:';

const CASES = [
  [`pg_dump: error: ${HOST} FATAL:  Tenant or user not found`, /^pg_dump could not sign in: Supabase's pooler doesn't know this project or its user\. The project may be paused or deleted/],
  [`pg_dump: error: ${HOST} FATAL:  password authentication failed for user "lastgood_backup.abcdefghijklmnopqrst"`, /^pg_dump could not sign in: the database refused the password in DATABASE_URL\./],
  ['pg_dump: error: could not translate host name "aws-9-nowhere.pooler.supabase.com" to address: Name or service not known', /^pg_dump could not reach the database: the host in DATABASE_URL doesn't exist\./],
  [`pg_dump: error: ${HOST} FATAL:  remaining connection slots are reserved for roles with the SUPERUSER attribute`, /^pg_dump could not connect: the database had no free connections\./],
  [`pg_dump: error: ${HOST} Connection timed out`, /^pg_dump could not reach the database: it didn't answer\./],
  [`pg_dump: error: ${HOST} Connection refused`, /^pg_dump could not reach the database: it didn't answer\./],
  ['pg_dump: error: query failed: ERROR:  canceling statement due to lock timeout', /^pg_dump stopped: a table stayed locked for 10 minutes/],
  ['pg_dump: error: query failed: ERROR:  permission denied for table invoices', /^pg_dump was refused read access to part of the database\./],
  ['pg_dump: error: could not write to output file: No space left on device', /^pg_dump stopped: the runner ran out of disk while writing the dump\.$/],
  ["pg_dump: error: something new", /^pg_dump could not read the database\. Its message is in this run's log in GitHub Actions\.$/],
];

test("a failed pg_dump checks in with a sentence that says why, and its own message stays in the log", async () => {
  for (const [message, reason] of CASES) {
    const run = await backup(message);
    assert.equal(run.status, 1, message);
    assert.equal(run.bodies.length, 1, message);
    const checkin = JSON.parse(run.bodies[0]);
    assert.equal(checkin.ok, false);
    assert.match(checkin.error, reason, message);
    // The check-in keeps 300 characters, so the whole sentence must fit.
    assert.ok(checkin.error.length <= 300, `${checkin.error.length}: ${checkin.error}`);
    assert.doesNotMatch(checkin.error, /failed with status/);
    // The sentence never carries pg_dump's words: no host, no user, no table name.
    assert.doesNotMatch(checkin.error, /pooler\.supabase\.com|lastgood_backup|invoices|13\.236/);
    assert.ok(run.stderr.includes(message), "pg_dump's own message is in the run's log");
  }
});

test("a DATABASE_URL that pg_dump echoes back never reaches the check-in", async () => {
  const leaked = 'pg_dump: error: missing "=" after "postgres://lastgood_backup.abcdefghijklmnopqrst:Pw9fakeNotRealX@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres" in connection info string';
  const run = await backup(leaked);
  assert.equal(run.status, 1);
  assert.equal(run.bodies.length, 1);
  assert.doesNotMatch(run.bodies[0], /Pw9fakeNotRealX|postgres:\/\//);
  assert.equal(JSON.parse(run.bodies[0]).error, "pg_dump could not read the database. Its message is in this run's log in GitHub Actions.");
});

test("a warning from a dump that worked is printed and doesn't fail the night", async () => {
  const run = await backup("pg_dump: warning: there are circular foreign-key constraints on this table:", { dumps: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /pg_dump: warning: there are circular foreign-key constraints/);
  assert.equal(JSON.parse(run.bodies[0]).ok, true);
});
