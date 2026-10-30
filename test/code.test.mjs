import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CALL_TIMEOUT_MS, countMetadata, exportMetadata, LISTS, nextLink } from "../scripts/github-metadata.mjs";

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
    for (const [name, value] of Object.entries(answer.headers ?? {})) headers.set(name, value);
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

test("with Issues switched off, pull requests' conversation comments are read one pull request at a time, or the copy fails by name", async () => {
  const off = { status: 410, body: { message: "Issues are disabled for this repo" } };
  const onePull = (number) => `${BASE}/issues/${number}/comments?per_page=100`;
  const routes = {
    [BASE]: { status: 200, body: { full_name: REPO } },
    [url("issues")]: off,
    [url("issues/comments")]: off,
    [url("pulls")]: page([{ number: 2 }, { number: 3 }]),
    [url("pulls/comments")]: page([{ id: 9 }]),
    [onePull(2)]: page([{ id: 20, body: "Looks good" }], `${onePull(2)}&page=2`),
    [`${onePull(2)}&page=2`]: page([{ id: 21, body: "Merging" }]),
    [onePull(3)]: page([{ id: 30, body: "Needs a test" }]),
  };
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const notes = [];
  const counts = await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: async () => {}, note: (line) => notes.push(line) });
  assert.deepEqual(counts, { issues: 0, pullRequests: 2, comments: 4 });
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, "issue-comments.json"), "utf8")).map((comment) => comment.id),
    [20, 21, 30],
  );
  assert.deepEqual(countMetadata(dir), counts, "a restore reads the same counts back");
  assert.ok(notes.some((line) => /conversation comments were read one pull request at a time/.test(line)), notes.join("\n"));

  const refused = { ...routes, [onePull(3)]: off };
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir: mkdtempSync(path.join(tmpdir(), "lg-meta-")), fetchImpl: fakeFetch(refused), sleep: async () => {} }),
    (error) =>
      error.message === "The pull requests' conversation comments could not be copied: Issues is switched off for acme/notes, and GitHub keeps those comments under Issues.",
  );
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

test("issues left on give no note, and pull requests are counted from their own list", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const notes = [];
  const routes = {
    [BASE]: { status: 200, body: { full_name: REPO } },
    [url("issues")]: page([{ number: 1 }, { number: 2, pull_request: {} }, { number: 3, pull_request: {} }]),
    [url("issues/comments")]: page([{ id: 1 }]),
    [url("pulls")]: page([{ number: 2 }, { number: 3 }]),
    [url("pulls/comments")]: page([{ id: 7 }, { id: 8 }, { id: 9 }, { id: 10 }]),
  };
  const counts = await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: async () => {}, note: (line) => notes.push(line) });
  assert.deepEqual(counts, { issues: 1, pullRequests: 2, comments: 5 });
  assert.deepEqual(notes, []);
  // Read back the way a restore reads the folder, the same counts come out.
  assert.deepEqual(countMetadata(dir), counts);
});

test("a rate limit is waited out and tried again, a refusal is not, and no wait follows the last try", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const empty = { [url("issues")]: page([]), [url("issues/comments")]: page([]), [url("pulls")]: page([]), [url("pulls/comments")]: page([]) };
  let tries = 0;
  const limited = { ...empty, [BASE]: () => (++tries < 2 ? { status: 429, body: { message: "Too Many Requests" } } : { status: 200, body: {} }) };
  const sleeps = [];
  await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(limited), sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(tries, 2);
  assert.deepEqual(sleeps, [1000]);

  const seen = [];
  const missing = { [BASE]: { status: 404, body: { message: "Not Found" } } };
  await assert.rejects(exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(missing, seen), sleep: async () => {} }));
  assert.equal(seen.length, 1);

  for (const fetchImpl of [fakeFetch({ [BASE]: { status: 502, body: { message: "Bad Gateway" } } }), async () => Promise.reject(new TypeError("fetch failed"))]) {
    const waits = [];
    await assert.rejects(exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl, sleep: async (ms) => void waits.push(ms) }));
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test("a rate limit waits as long as GitHub asks, up to a minute, a secondary limit's 403 included, and is named when it lasts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const empty = { [url("issues")]: page([]), [url("issues/comments")]: page([]), [url("pulls")]: page([]), [url("pulls/comments")]: page([]) };
  const limitedThen = (answers) => {
    let tries = 0;
    return { ...empty, [BASE]: () => answers[tries++] ?? { status: 200, body: {} } };
  };
  const secondary = { status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, headers: { "retry-after": "30" } };
  const sleeps = [];
  await exportMetadata({
    api: API,
    repository: REPO,
    token: TOKEN,
    dir,
    fetchImpl: fakeFetch(limitedThen([secondary, { status: 429, body: { message: "Too Many Requests" }, headers: { "retry-after": "600" } }])),
    sleep: async (ms) => void sleeps.push(ms),
  });
  assert.deepEqual(sleeps, [30_000, 60_000], "Retry-After is kept, and capped at a minute");

  const always = { ...empty, [BASE]: { status: 429, body: { message: "Too Many Requests" } } };
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(always), sleep: async () => {} }),
    (error) => error.message === "GitHub's rate limit stopped the copy of the repository. The next run tries again.",
  );
});

test("a list takes 1,000 pages and refuses a 1,001st", async () => {
  const pagesOf = (count) => {
    const routes = {
      [BASE]: { status: 200, body: { full_name: REPO } },
      [url("issues")]: page([{ number: 0 }], `${BASE}/issues?page=1`),
      [url("issues/comments")]: page([]),
      [url("pulls")]: page([]),
      [url("pulls/comments")]: page([]),
    };
    for (let n = 1; n < count; n += 1) routes[`${BASE}/issues?page=${n}`] = page([{ number: n }], n + 1 < count ? `${BASE}/issues?page=${n + 1}` : undefined);
    return fakeFetch(routes);
  };
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const counts = await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: pagesOf(1000), sleep: async () => {} });
  assert.equal(counts.issues, 1000);
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: pagesOf(1001), sleep: async () => {} }),
    /issues\.json has more than 100000 entries/,
  );
});

test("a copy whose repository.json or a list is damaged or missing does not read back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const write = (file, value) => writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
  for (const list of LISTS) write(list.file, []);
  for (const repository of [null, [], "repo", 7]) {
    write("repository.json", JSON.stringify(repository));
    assert.throws(() => countMetadata(dir), /repository\.json in the code copy is not a repository/, JSON.stringify(repository));
  }
  write("repository.json", { full_name: REPO });
  assert.deepEqual(countMetadata(dir), { issues: 0, pullRequests: 0, comments: 0 });
  write("pulls.json", { not: "a list" });
  assert.throws(() => countMetadata(dir), /pulls\.json in the code copy is not a list/);
  write("pulls.json", "{");
  assert.throws(() => countMetadata(dir), /pulls\.json in the code copy did not read back/);
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
      ...(typeof extra === "function" ? extra(api.port) : extra),
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
  assert.match(run.stderr, /The users check still runs; then this run fails\./, "the code part fails alone");
  assert.equal(run.checkins[0].codeBranches, null, "no counts for a code copy that never went up");
  assert.equal(run.checkins[0].codeTags, null);
  assert.equal(run.checkins[0].codeBytes, null);
});

test("a clone that cannot reach GitHub says so, not that a permission is missing, and the rest of the night still runs", async () => {
  const run = await backupWithCode(GOOD_API, { GITHUB_SERVER_URL: "http://127.0.0.1:9" });
  assert.notEqual(run.status, 0);
  assert.equal(
    run.checkins[0].error,
    "git could not reach GitHub to copy acme/notes, or GitHub didn't answer. The next run tries again. Nothing was uploaded for the code.",
  );
  assert.doesNotMatch(run.checkins[0].error, /contents: read/);
  assert.match(run.stderr, /Failed to connect/, "git's own message stays in the log");
  assert.match(run.stderr, /The users check still runs; then this run fails\./);
  assert.equal(readdirSync(path.join(run.uploads, "lifeboat", "db")).length, 1, "the database copy still went up");
  assert.equal(existsSync(path.join(run.uploads, "lifeboat", "repo")), false);
  assert.equal(existsSync(path.join(run.work, "code")), false, "nothing of the clone is left behind");
  assert.equal(run.checkins[0].codeBranches, null);
});

test("a token GitHub refuses when cloning over HTTP still names the permission", async () => {
  // The fake answers 401 to anything not sent with the bearer token, as GitHub does to a token without contents: read.
  const run = await backupWithCode(GOOD_API, (port) => ({ GITHUB_SERVER_URL: `http://127.0.0.1:${port}` }));
  assert.notEqual(run.status, 0);
  assert.equal(run.checkins[0].error, "git could not read acme/notes with the workflow's token. The workflow needs contents: read under permissions. Nothing was uploaded for the code.");
  assert.ok(!run.stderr.includes(TOKEN) && !shown(run.stdout).includes(TOKEN));
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

/** A call that never answers until its signal gives up, on a 5 ms clock in place of the real timeout. */
function neverAnswers(t) {
  const real = AbortSignal.timeout.bind(AbortSignal);
  const timeout = t.mock.method(AbortSignal, "timeout", () => real(5));
  let calls = 0;
  const fetchImpl = (_url, init) => {
    calls += 1;
    if (!init?.signal) return Promise.reject(new Error("no signal: this call could wait forever"));
    return new Promise((_resolve, reject) => {
      // AbortSignal.timeout's timer doesn't hold the process open; a real stuck socket would.
      const open = setInterval(() => {}, 1000);
      init.signal.addEventListener("abort", () => {
        clearInterval(open);
        reject(init.signal.reason);
      });
    });
  };
  return { fetchImpl, calls: () => calls, limits: () => timeout.mock.calls.map((call) => call.arguments[0]) };
}

test("a GitHub call that never answers is given up after a minute and tried again, not left to run the job's clock down", { timeout: 5000 }, async (t) => {
  const stuck = neverAnswers(t);
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: stuck.fetchImpl, sleep: async () => {} }),
    /GitHub could not be reached when reading/,
  );
  assert.equal(stuck.calls(), 3);
  assert.deepEqual(stuck.limits(), [CALL_TIMEOUT_MS, CALL_TIMEOUT_MS, CALL_TIMEOUT_MS]);
  assert.equal(CALL_TIMEOUT_MS, 60_000);
});

test("a refusal GitHub sends without JSON is still explained, and a token GitHub refuses is named", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const answering = (status, text) => async () => new Response(text, { status, headers: { "content-type": "text/html" } });
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: answering(401, "<html>Bad credentials</html>"), sleep: async () => {} }),
    (error) => error.message === "GitHub did not accept the workflow's token.",
  );
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: answering(502, "<html>Bad Gateway</html>"), sleep: async () => {} }),
    (error) => error.message === "GitHub answered 502 when reading the repository.",
  );
  const refused = { [BASE]: { status: 401, body: { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" } } };
  await assert.rejects(
    exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(refused), sleep: async () => {} }),
    (error) => error.message === "GitHub did not accept the workflow's token.",
  );
});

test("without a sleep given, a server error waits a second on the clock before GitHub is asked again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  let tries = 0;
  const routes = {
    [BASE]: () => (++tries < 2 ? { status: 502, body: { message: "Bad Gateway" } } : { status: 200, body: {} }),
    [url("issues")]: page([]),
    [url("issues/comments")]: page([]),
    [url("pulls")]: page([]),
    [url("pulls/comments")]: page([]),
  };
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const copy = exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes) });
  await settle();
  assert.equal(tries, 1);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(tries, 1, "not asked again before the second is up");
  t.mock.timers.tick(1);
  assert.deepEqual(await copy, { issues: 0, pullRequests: 0, comments: 0 });
  assert.equal(tries, 2);
});

test("github-metadata.mjs --count reads a folder back and prints its counts, and an unexpected failure prints no detail", async () => {
  const script = path.join(ROOT, "scripts", "github-metadata.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "lg-meta-"));
  const routes = {
    [BASE]: { status: 200, body: { full_name: REPO } },
    [url("issues")]: page([{ number: 1 }, { number: 2, pull_request: {} }]),
    [url("issues/comments")]: page([{ id: 1 }]),
    [url("pulls")]: page([{ number: 2 }]),
    [url("pulls/comments")]: page([{ id: 7 }, { id: 8 }]),
  };
  await exportMetadata({ api: API, repository: REPO, token: TOKEN, dir, fetchImpl: fakeFetch(routes), sleep: async () => {} });
  assert.equal(execFileSync(process.execPath, [script, "--count", dir], { encoding: "utf8", env: { PATH: process.env.PATH } }), "1 1 3\n");

  // A folder that cannot be made, under a file, is not a MetadataError: the run's log gets the plain line, not Node's.
  const file = path.join(mkdtempSync(path.join(tmpdir(), "lg-meta-")), "not-a-folder");
  writeFileSync(file, "");
  const failed = spawnSync(process.execPath, [script, path.join(file, "github")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN, GITHUB_API_URL: "http://127.0.0.1:9" },
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, "The GitHub metadata copy failed.\n");
  assert.equal(failed.stdout, "");
});
