import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { exportMetadata, LISTS, nextLink } from "../scripts/github-metadata.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const TOKEN = "ghs_unit-test-token-must-stay-hidden";
const REPO = "acme/notes";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

/** A repository with a branch the default branch never merged, a tag on a deleted branch and an orphan branch. */
function sourceRepo(root) {
  const dir = path.join(root, "server", "acme", "notes.git");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "app.txt"), "main\n");
  git(dir, "add", "app.txt");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "tag", "-a", "v1.0.0", "-m", "first release");
  git(dir, "checkout", "-q", "-b", "agent/never-merged");
  writeFileSync(path.join(dir, "app.txt"), "agent\n");
  git(dir, "commit", "-q", "-am", "agent work");
  git(dir, "checkout", "-q", "-b", "gone");
  git(dir, "commit", "-q", "--allow-empty", "-m", "only on a deleted branch");
  git(dir, "tag", "kept-from-gone");
  git(dir, "checkout", "-q", "--orphan", "docs");
  git(dir, "commit", "-q", "--allow-empty", "-m", "docs");
  git(dir, "tag", "-a", "docs-1", "-m", "docs");
  git(dir, "checkout", "-q", "main");
  git(dir, "branch", "-q", "-D", "gone");
  return dir;
}

function page(items, next) {
  return { status: 200, body: items, link: next ? `<${next}>; rel="next", <https://x.invalid/last>; rel="last"` : null };
}

/** A fake fetch over a map of URL to response, which records each request. */
function fakeFetch(routes, seen = []) {
  return async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization });
    const route = routes[url];
    const answer = typeof route === "function" ? route() : route;
    if (!answer) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const headers = new Headers({ "content-type": "application/json" });
    if (answer.link) headers.set("link", answer.link);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers });
  };
}

const API = "https://api.example.invalid";
const BASE = `${API}/repos/${REPO}`;
const url = (list, extra = "") => {
  const spec = LISTS.find((item) => item.path === list);
  return `${BASE}/${list}?${new URLSearchParams({ ...spec.query, per_page: "100" })}${extra}`;
};

test("nextLink reads only the next page", () => {
  assert.equal(nextLink('<https://a/b?page=2>; rel="next", <https://a/b?page=5>; rel="last"'), "https://a/b?page=2");
  assert.equal(nextLink('<https://a/b?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test("metadata follows every page and counts issues, pull requests and comments", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const seen = [];
  const routes = {
    [BASE]: { status: 200, body: { full_name: REPO, default_branch: "main" } },
    [url("issues")]: page([{ number: 1 }, { number: 2, pull_request: {} }], `${BASE}/issues?page=2`),
    [`${BASE}/issues?page=2`]: page([{ number: 3 }]),
    [url("issues/comments")]: page([{ id: 1 }, { id: 2 }]),
    [url("pulls")]: page([{ number: 2 }]),
    [url("pulls/comments")]: page([{ id: 9 }]),
  };
  const counts = await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes, seen), sleep: async () => {} });
  assert.deepEqual(counts, { issues: 2, pullRequests: 1, comments: 3 });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "issues.json"), "utf8")).map((item) => item.number), [1, 2, 3]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "repository.json"), "utf8")).default_branch, "main");
  assert.deepEqual(readdirSync(dir).sort(), ["issue-comments.json", "issues.json", "pulls.json", "repository.json", "review-comments.json"]);
  assert.ok(seen.every((request) => request.auth === `Bearer ${TOKEN}`));
});

test("issues switched off give an empty list and a note, not a failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const notes = [];
  const routes = {
    [BASE]: { status: 200, body: { full_name: REPO } },
    [url("issues")]: { status: 410, body: { message: "Issues are disabled for this repo" } },
    [url("issues/comments")]: { status: 410, body: { message: "Issues are disabled for this repo" } },
    [url("pulls")]: page([]),
    [url("pulls/comments")]: page([]),
  };
  const counts = await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: async () => {}, note: (line) => notes.push(line) });
  assert.deepEqual(counts, { issues: 0, pullRequests: 0, comments: 0 });
  assert.equal(notes.length, 2);
  assert.match(notes[0], /switched off/);
});

test("a token without issues: read names the missing permission, and never the token", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const routes = {
    [BASE]: { status: 200, body: { full_name: REPO } },
    [url("issues")]: { status: 403, body: { message: "Resource not accessible by integration" } },
  };
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: async () => {} }),
    (error) => /issues: read and pull-requests: read/.test(error.message) && !error.message.includes(TOKEN),
  );
});

test("a server error is retried, and a rate limit is named", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  let tries = 0;
  const routes = {
    [BASE]: () => (++tries < 3 ? { status: 502, body: { message: "Bad Gateway" } } : { status: 200, body: {} }),
    [url("issues")]: page([]),
    [url("issues/comments")]: page([]),
    [url("pulls")]: page([]),
    [url("pulls/comments")]: page([]),
  };
  await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: async () => {} });
  assert.equal(tries, 3);

  const limited = { [BASE]: { status: 403, body: { message: "API rate limit exceeded for installation" } } };
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(limited), sleep: async () => {} }),
    /rate limit/,
  );
  await assert.rejects(exportMetadata({ api: API, repository: "not a repo", token: TOKEN, dir }), /owner\/repo/);
});

function fakeTools(dir) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(
    path.join(dir, "pg_dump"),
    `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then printf 'dump' > "$2"; exit 0; fi
  shift
done
exit 1
`,
  );
  // Keeps each upload under its object key, folders and all.
  writeFileSync(
    path.join(dir, "aws"),
    `#!/bin/sh
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
esac
exit 0
`,
  );
  // The users check lists the dump: an empty TOC, or the one in FAKE_TOC when a test sets it.
  writeFileSync(path.join(dir, "pg_restore"), '#!/bin/sh\n[ -n "$FAKE_TOC" ] && cat "$FAKE_TOC"\nexit 0\n');
  chmodSync(path.join(dir, "pg_restore"), 0o755);
  chmodSync(path.join(dir, "pg_dump"), 0o755);
  chmodSync(path.join(dir, "aws"), 0o755);
  return uploads;
}

/** A fake GitHub API and check-in endpoint on one local port. */
async function fakeGitHub(answers) {
  const checkins = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/checkin") {
        checkins.push(JSON.parse(body));
        response.writeHead(202).end("{}");
        return;
      }
      const auth = request.headers.authorization;
      const pathname = new URL(request.url, "http://localhost").pathname;
      const answer = auth === `Bearer ${TOKEN}` ? answers[pathname] : { status: 401, body: { message: "Bad credentials" } };
      response.writeHead(answer?.status ?? 404, { "content-type": "application/json" });
      response.end(JSON.stringify(answer?.body ?? { message: "Not Found" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, checkins };
}

/** What a reader of the job log sees: the runner consumes ::add-mask:: lines instead of printing them. */
function shown(text) {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

function runAsync(env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [RUN], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const GOOD_API = {
  [`/repos/${REPO}`]: { status: 200, body: { full_name: REPO, default_branch: "main" } },
  [`/repos/${REPO}/issues`]: { status: 200, body: [{ number: 1, title: "Login breaks" }, { number: 2, pull_request: {} }] },
  [`/repos/${REPO}/issues/comments`]: { status: 200, body: [{ id: 10, body: "Seen it too" }] },
  [`/repos/${REPO}/pulls`]: { status: 200, body: [{ number: 2, head: { ref: "agent/never-merged" } }] },
  [`/repos/${REPO}/pulls/comments`]: { status: 200, body: [{ id: 11, body: "nit" }] },
};

async function backupWithCode(answers, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-code-"));
  sourceRepo(dir);
  const uploads = fakeTools(dir);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const api = await fakeGitHub(answers);
  try {
    const result = await runAsync({
      PATH: `${dir}:${process.env.PATH}`,
      HOME: dir,
      LIFEBOAT_MODE: "backup",
      DATABASE_URL: "postgres://example.invalid/db",
      S3_BUCKET: "bucket",
      S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
      S3_PREFIX: "lifeboat",
      LIFEBOAT_PUBLIC_KEY: publicKey,
      LIFEBOAT_MANAGE_RETENTION: "false",
      LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
      CHECKIN_SECRET: "unit-test-checkin-secret",
      CHECKIN_URL: `http://127.0.0.1:${api.port}/checkin`,
      LIFEBOAT_WORKDIR: work,
      GITHUB_REPOSITORY: REPO,
      GITHUB_SERVER_URL: `file://${path.join(dir, "server")}`,
      GITHUB_API_URL: `http://127.0.0.1:${api.port}`,
      GITHUB_TOKEN: TOKEN,
      ...extra,
    });
    return { ...result, dir, uploads, keyFile, work, checkins: api.checkins };
  } finally {
    api.server.close();
  }
}

test("backup uploads every branch and tag, with issues and pull requests, in one age archive under repo/", async () => {
  const run = await backupWithCode(GOOD_API);
  assert.equal(run.status, 0, run.stderr);
  const repoDir = path.join(run.uploads, "lifeboat", "repo");
  const files = readdirSync(repoDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}Z\.tar\.gz\.age$/);
  assert.match(run.stdout, /Code: 3 branches, 3 tags\. GitHub: 1 issues, 1 pull requests, 2 comments\./);
  assert.ok(!shown(run.stdout).includes(TOKEN) && !run.stderr.includes(TOKEN), "the token is never printed");
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  assert.ok(run.stdout.includes(`::add-mask::${basic}`), "the header form of the token is masked");

  // Open it the way a customer would: age with the private key, then tar, then git clone from the bundle.
  const out = path.join(run.dir, "opened");
  mkdirSync(out);
  execFileSync("age", ["--decrypt", "--identity", run.keyFile, "--output", path.join(out, "code.tar.gz"), path.join(repoDir, files[0])]);
  execFileSync("tar", ["-xzf", "code.tar.gz"], { cwd: out });
  assert.deepEqual(readdirSync(path.join(out, "github")).sort(), ["issue-comments.json", "issues.json", "pulls.json", "repository.json", "review-comments.json"]);
  assert.equal(JSON.parse(readFileSync(path.join(out, "github", "issues.json"), "utf8"))[0].title, "Login breaks");
  git(out, "clone", "-q", "--mirror", "code.bundle", "restored.git");
  const refs = git(path.join(out, "restored.git"), "for-each-ref", "--format=%(refname)").trim().split("\n").sort();
  assert.deepEqual(refs, [
    "refs/heads/agent/never-merged",
    "refs/heads/docs",
    "refs/heads/main",
    "refs/tags/docs-1",
    "refs/tags/kept-from-gone",
    "refs/tags/v1.0.0",
  ]);
  assert.equal(git(path.join(out, "restored.git"), "show", "agent/never-merged:app.txt"), "agent\n");

  // Nothing readable is left on the runner, and the check-in carries the counts.
  assert.equal(existsSync(path.join(run.work, "code")), false);
  assert.equal(existsSync(path.join(run.work, "code.tar.gz")), false);
  assert.equal(run.checkins.length, 1);
  assert.equal(run.checkins[0].ok, true);
  assert.equal(run.checkins[0].codeBranches, 3);
  assert.equal(run.checkins[0].codeTags, 3);
  assert.equal(run.checkins[0].githubPullRequests, 1);
  assert.equal(run.checkins[0].githubComments, 2);
  assert.ok(run.checkins[0].codeBytes > 0);
});

test("a workflow without issues: read fails the run by name, after the database copy, and uploads no code", async () => {
  const run = await backupWithCode({
    ...GOOD_API,
    [`/repos/${REPO}/issues`]: { status: 403, body: { message: "Resource not accessible by integration" } },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /issues: read and pull-requests: read under permissions/);
  assert.ok(readdirSync(path.join(run.uploads, "lifeboat", "db")).length === 1, "the database copy still went up");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "repo")), false);
  assert.equal(run.checkins[0].ok, false);
  assert.match(run.checkins[0].error, /issues: read/);
  assert.ok(!run.stderr.includes(TOKEN));
});

test("a token git cannot use fails the run without printing it", async () => {
  const run = await backupWithCode(GOOD_API, { GITHUB_SERVER_URL: "file:///nonexistent-lastgood-server" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /git could not read acme\/notes/);
  assert.ok(!run.stderr.includes(TOKEN) && !shown(run.stdout).includes(TOKEN));
});

test("outside GitHub Actions the code copy is skipped and the check-in says not copied", async () => {
  const run = await backupWithCode(GOOD_API, { GITHUB_REPOSITORY: "" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Code copy skipped/);
  assert.equal(run.checkins[0].codeBranches, null);
});

test("a users check failure still uploads the code archive, then fails the run", async () => {
  const toc = path.join(mkdtempSync(path.join(tmpdir(), "lg-toc-")), "toc.txt");
  writeFileSync(toc, "230; 1259 17500 TABLE auth users supabase_auth_admin\n");
  const run = await backupWithCode(GOOD_API, { FAKE_TOC: toc });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /none of its rows.*Everything else this run copies was uploaded first\./);
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "repo")).length, 1, "the code archive still went up");
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "db")).length, 1, "the database copy still went up");
  assert.equal(run.checkins[0].ok, false);
  assert.equal(run.checkins[0].codeBranches, 3);
});
