import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/**
 * A step before run.sh in the action failed, such as installing the Postgres client, so the run never started and
 * nothing checked in: LastGood heard only from the 36-hour late check, and of a failed test restore only from the 35-day
 * missed one. The action's closing step now runs run.sh again with LIFEBOAT_SETUP_FAILED naming that step and only the
 * environment that step passes, and the run checks in as failed. Names and secrets are made up.
 */
async function setupFailed(step, mode, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-failed-"));
  dirs.push(dir);
  // Nothing past the check-in may run: each tool leaves a mark if it is called.
  const called = path.join(dir, "called");
  for (const tool of ["pg_dump", "pg_restore", "psql", "aws", "age", "git", "tar"]) {
    writeFileSync(path.join(dir, tool), `#!/bin/sh\necho ${tool} >> "${called}"\nexit 1\n`);
    chmodSync(path.join(dir, tool), 0o755);
  }
  const bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const child = spawn("bash", [RUN], {
      detached: true,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: dir,
        LIFEBOAT_SETUP_FAILED: step,
        LIFEBOAT_MODE: mode,
        LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
        CHECKIN_URL: `http://127.0.0.1:${server.address().port}/checkin`,
        CHECKIN_SECRET: "unit-test-checkin-secret",
        RETENTION_DAYS: "30",
        ...extra,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve) => child.on("close", resolve));
    return { status, stderr, bodies, called: existsSync(called) ? readFileSync(called, "utf8").trim().split("\n") : [] };
  } finally {
    server.close();
  }
}

const SENTENCES = {
  postgres: (run) => `Lifeboat could not install the Postgres client on the runner, so ${run} did not run. Its message is in this run's log in GitHub Actions.`,
  age: (run) => `Lifeboat could not set up the age encryption tool on the runner, so ${run} did not run. Its message is in this run's log in GitHub Actions.`,
  other: (run) => `A setup step in the Lifeboat action failed, so ${run} did not run. Its message is in this run's log in GitHub Actions.`,
};

for (const [mode, run] of [
  ["backup", "the backup"],
  ["restore-test", "the test restore"],
]) {
  for (const step of ["postgres", "age", "other"]) {
    test(`a ${mode} whose ${step} setup step failed checks in as failed, naming the step, and runs nothing else`, async () => {
      const { status, stderr, bodies, called } = await setupFailed(step, mode);
      assert.equal(status, 1);
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].ok, false);
      assert.equal(bodies[0].kind, mode);
      assert.equal(bodies[0].project, "abcdefghijklmnopqrst");
      assert.equal(bodies[0].error, SENTENCES[step](run));
      assert.equal(bodies[0].dumpBytes, 0);
      assert.deepEqual(bodies[0].copies, []);
      assert.deepEqual(called, []);
      assert.match(stderr, new RegExp(SENTENCES[step](run).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }
}

test("a setup step name the script doesn't know still checks in as a failed setup step", async () => {
  const { bodies } = await setupFailed("checkout", "backup");
  assert.equal(bodies[0].error, SENTENCES.other("the backup"));
});

test("with no check-in secret the failed setup step still fails the run, and nothing is sent", async () => {
  const { status, bodies, called } = await setupFailed("postgres", "backup", { CHECKIN_SECRET: "" });
  assert.equal(status, 1);
  assert.deepEqual(bodies, []);
  assert.deepEqual(called, []);
});

/** The action's steps, as `- name:` blocks under `runs.steps`, each with its own lines. */
function actionSteps() {
  const action = readFileSync(path.join(ROOT, "action.yml"), "utf8");
  const steps = action.slice(action.indexOf("\n  steps:\n")).split(/\n(?= {4}- name: )/).slice(1);
  return steps.map((block) => ({ name: /^ {4}- name: (.*)$/m.exec(block)?.[1], block }));
}

test("the action names its setup steps and Lifeboat's own, so the closing step can tell which one failed", () => {
  const steps = actionSteps();
  assert.deepEqual(
    steps.map((step) => step.name),
    ["Install the Postgres client", "Install age", "Run Lifeboat", "Check in a setup step that failed"],
  );
  assert.match(steps[0].block, /^ {6}id: postgres$/m);
  assert.match(steps[1].block, /^ {6}id: age$/m);
  assert.match(steps[2].block, /^ {6}id: run$/m);
});

test("the closing step runs only when a step failed and Lifeboat itself didn't, and passes what run.sh needs to check in", () => {
  const steps = actionSteps();
  const closing = steps.at(-1).block;
  // Lifeboat's own failure has checked in already; a run that passed has nothing to add.
  assert.match(closing, /^ {6}if: failure\(\) && steps\.run\.outcome != 'failure'$/m);
  assert.match(
    closing,
    /^ {8}LIFEBOAT_SETUP_FAILED: \$\{\{ steps\.postgres\.outcome == 'failure' && 'postgres' \|\| steps\.age\.outcome == 'failure' && 'age' \|\| 'other' \}\}$/m,
  );
  // The same inputs as Lifeboat's own step, so the check-in goes to the same place, signed the same way.
  const run = steps[2].block;
  for (const line of [
    "LIFEBOAT_MODE: ${{ inputs.mode }}",
    "LIFEBOAT_PROJECT: ${{ inputs.project }}",
    "CHECKIN_URL: ${{ inputs.checkin-url }}",
    "CHECKIN_SECRET: ${{ inputs.checkin-secret }}",
    "RETENTION_DAYS: ${{ inputs.retention-days }}",
  ]) {
    assert.ok(closing.includes(`\n        ${line}\n`), line);
    assert.ok(run.includes(`\n        ${line}\n`), line);
  }
  // Only those: no database, bucket or key reaches a run that only checks in.
  const env = closing.slice(closing.indexOf("\n      env:\n"), closing.indexOf("\n      run:"));
  assert.equal(env.match(/^ {8}[A-Z_]+:/gm)?.length, 6);
  assert.match(closing, /\n {6}run: exec bash "\$GITHUB_ACTION_PATH\/scripts\/run\.sh"\n?$/);
});
