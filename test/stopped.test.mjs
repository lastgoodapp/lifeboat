import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A run stopped part way, as when the workflow is cancelled, times out or its runner shuts down. Bash still runs the
 * EXIT trap when a signal ends it, but with the status of the last command that finished, usually 0, so the stopped
 * run used to check in as passed. pg_dump here starts and then waits. A runner may signal the step's own process only
 * (`to: "process"`) or its whole process group (`to: "group"`), and may follow the first signal with another while the
 * check-in is on its way (`during`). Names and secrets are made up.
 */
async function stoppedBackup(signal, { to = "group", during } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-stopped-"));
  dirs.push(dir);
  // pg_dump writes its process group, so a run that never ends can be cleaned up, then hangs.
  const started = path.join(dir, "pg_dump.started");
  writeFileSync(path.join(dir, "pg_dump"), `#!/bin/sh\nps -o pgid= -p $$ | tr -d ' ' > "${started}.tmp"\nmv "${started}.tmp" "${started}"\nexec sleep 120\n`);
  writeFileSync(path.join(dir, "aws"), `#!/bin/sh\ncase " $* " in *" s3api "*) printf '%s\\n' '{"Contents":[]}' ;; esac\nexit 0\n`);
  for (const tool of ["pg_dump", "aws"]) chmodSync(path.join(dir, tool), 0o755);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      bodies.push(JSON.parse(body));
      // A second signal while the check-in waits for its answer, as a runner sends SIGTERM after SIGINT.
      if (during) {
        send(during);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  let dumpGroup;
  const send = (sig) => process.kill(to === "group" ? -child.pid : child.pid, sig);
  try {
    child = spawn("bash", [RUN], {
      detached: true,
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
    const closed = new Promise((resolve) => child.on("close", (status, killedBy) => resolve({ status, killedBy })));
    for (let waited = 0; !existsSync(started); waited += 20) {
      assert.ok(waited < 20_000, "pg_dump never started");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    dumpGroup = Number(readFileSync(started, "utf8"));
    send(signal);
    // Inside a runner's grace period: it sends SIGTERM 7.5 seconds after SIGINT, and kills what is left soon after.
    const late = new Promise((resolve) => setTimeout(() => resolve("late"), 7000));
    const ended = await Promise.race([closed, late]);
    assert.notEqual(ended, "late", "the run was still going 7 seconds after the signal");
    return { ...ended, bodies };
  } finally {
    server.close();
    for (const group of [child?.pid, dumpGroup]) {
      try {
        if (group) process.kill(-group, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

for (const to of ["group", "process"]) {
  for (const [signal, status] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ]) {
    test(`a backup stopped by ${signal} to its ${to === "group" ? "whole process group" : "own process only"} checks in as failed, saying it was stopped`, async () => {
      const { status: exit, bodies } = await stoppedBackup(signal, { to });
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].ok, false);
      assert.equal(bodies[0].error, `Lifeboat was stopped (${signal}) before it finished, so this run proves nothing.`);
      assert.equal(exit, status);
    });
  }

  test(`a second signal to the ${to === "group" ? "whole process group" : "own process only"} doesn't stop the check-in on its way`, async () => {
    const { status: exit, bodies } = await stoppedBackup("SIGINT", { to, during: "SIGTERM" });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].error, "Lifeboat was stopped (SIGINT) before it finished, so this run proves nothing.");
    assert.equal(exit, 130);
  });
}

test("the action runs run.sh as the step's own process, so a cancel or time out signals it", () => {
  const action = readFileSync(path.join(ROOT, "action.yml"), "utf8");
  assert.match(action, /\n\s+run: exec bash "\$GITHUB_ACTION_PATH\/scripts\/run\.sh"\n/);
});
