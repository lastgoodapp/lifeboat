import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

/** Fake tools: pg_dump writes a dump; aws prints `message` on stderr and fails every s3 cp, and lists nothing. */
function fakeTools(dir, message) {
  writeFileSync(path.join(dir, "aws.message"), message);
  writeFileSync(path.join(dir, "pg_dump"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "--file" ]; then printf \'dump\' > "$2"; exit 0; fi\n  shift\ndone\nexit 1\n');
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
case " $* " in
  *" s3 cp "*) cat "${dir}/aws.message" >&2; exit 1 ;;
  *" s3api "*) printf '%s\\n' '{"Contents":[]}' ;;
esac
exit 0
`,
  );
  writeFileSync(path.join(dir, "pg_restore"), "#!/bin/sh\nexit 0\n");
  for (const tool of ["pg_dump", "aws", "pg_restore"]) chmodSync(path.join(dir, tool), 0o755);
}

async function backup(message) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-storage-errors-"));
  fakeTools(dir, message);
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
