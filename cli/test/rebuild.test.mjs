import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { clean, rebuildRestoreList, sortRestoreErrors, SUPABASE_SCHEMAS, tocEntry } from "../lib/rebuild-list.mjs";
import { connection, duration, githubIsPublic, githubRepository, outsideName, rebuildCode, runSteps, shownGitUrl, StepError, takeOutLoginAfterFailure, todoList, todoMarkdown } from "../lib/rebuild.mjs";
import { CHUNK, checkSecretKey, copyBlock, copyRow, decodeCopyField, fileMeta, projectRef, rebuildFiles, storageBase } from "../lib/rebuild-files.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "lastgood.mjs");
const FIXTURE = path.join(HERE, "..", "..", "lifeboat", "test", "fixtures", "supabase");
// The Supabase-shaped dump is the backup action's own test fixture, so a copy of cli/ on its own skips the tests that load it.
const NO_FIXTURE = existsSync(path.join(HERE, "..", "..", "lifeboat")) ? false : "needs the full repository";
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function folder(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** A key file and a function that seals a file to it, as the backup does. */
async function keyed(dir) {
  const key = await generateX25519Identity();
  const recipient = await identityToRecipient(key);
  const keyFile = path.join(dir, "lastgood-key-acme-notes.txt");
  writeFileSync(keyFile, `# LastGood key for acme/notes\n# public key: ${recipient}\n${key}\n`);
  const seal = async (file, out) => {
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    writeFileSync(out, Buffer.from(await encrypter.encrypt(readFileSync(file))));
    return out;
  };
  return { keyFile, seal };
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const HAS_PG_RESTORE = spawnSync("pg_restore", ["--version"]).status === 0;

describe("the restore list for a new Supabase project", () => {
  it("reads entries whose owner is empty, as pg_restore lists an extension's comment", () => {
    const entry = tocEntry("4321; 0 0 COMMENT - EXTENSION supabase_vault ");
    assert.deepEqual([entry.desc, entry.namespace, entry.name, entry.owner], ["COMMENT", "-", "EXTENSION supabase_vault", ""]);
    const policy = tocEntry("5001; 3256 17000 POLICY storage objects Signed-in users read avatars supabase_storage_admin");
    assert.deepEqual([policy.desc, policy.namespace, policy.words[0], policy.name], ["POLICY", "storage", "objects", "objects Signed-in users read avatars"]);
    assert.equal(tocEntry("; Archive created at 2026-10-17"), null);
  });

  it("keeps the app's schema and rows, the users, identities and buckets, and the app's trigger and policy on Supabase's tables", { skip: NO_FIXTURE || (HAS_PG_RESTORE ? false : "pg_restore is not installed") }, () => {
    const toc = execFileSync("pg_restore", ["--list", path.join(FIXTURE, "dump.backup")], { encoding: "utf8" });
    const plan = rebuildRestoreList(toc, {
      schemas: ["public", "auth", "storage", "extensions", "graphql", "graphql_public", "realtime", "vault", "pgsodium"],
      installed: ["plpgsql", "pgcrypto", "uuid-ossp", "pg_stat_statements"],
      available: ["plpgsql", "pgcrypto", "uuid-ossp", "pg_stat_statements"],
    });
    const kept = new Set(plan.kept.map((entry) => `${entry.desc} ${entry.namespace} ${entry.name}`));
    for (const wanted of [
      "TABLE public profiles",
      "TABLE DATA public listings",
      "POLICY public profiles Users update their own profile",
      "ROW SECURITY public listings",
      "TRIGGER public messages messages_hook",
      "TABLE DATA auth users",
      "TABLE DATA auth identities",
      "TABLE DATA storage buckets",
      "TRIGGER auth users on_auth_user_created",
      "POLICY storage objects Signed-in users read avatars",
      "PUBLICATION TABLE public supabase_realtime messages",
      "MATERIALIZED VIEW DATA public listing_counts",
    ]) {
      assert.ok(kept.has(wanted), `${wanted} is restored`);
    }
    // Supabase made these in the new project, and keeps them.
    for (const unwanted of [
      "TABLE auth users",
      "FUNCTION auth uid()",
      "TABLE storage objects",
      "TABLE DATA storage objects",
      "TABLE DATA auth sessions",
      "TABLE DATA vault secrets",
      "SCHEMA - auth",
      "EVENT TRIGGER - pgrst_ddl_watch",
      "EXTENSION - pgcrypto",
      "PUBLICATION - supabase_realtime",
      "ROW SECURITY storage objects",
      "COMMENT - EXTENSION pg_graphql",
    ]) {
      assert.ok(!kept.has(unwanted), `${unwanted} is left as the new project has it`);
    }
    assert.deepEqual(plan.unavailableExtensions.sort(), ["pg_graphql", "pg_net", "pgjwt", "pgsodium", "supabase_vault"]);
    assert.ok(plan.supabaseRows.includes("storage.objects") && plan.supabaseRows.includes("auth.mfa_factors"));
    assert.deepEqual(plan.eventTriggers, [], "Supabase's own event triggers are not the app's");
    // Every line is either kept as it was or commented out, so pg_restore still reads the whole list.
    assert.equal(plan.text.split("\n").length, toc.split("\n").length);
  });

  it("leaves out the storage login's policies and an app's event trigger, and names them", () => {
    const toc = [
      "10; 3256 17001 POLICY storage objects lastgood_backup_read_files supabase_storage_admin",
      "11; 3256 17002 POLICY storage objects Owners read their files supabase_storage_admin",
      "12; 3466 17003 EVENT TRIGGER - audit_ddl postgres",
      "13; 2615 17004 SCHEMA - billing postgres",
      "14; 2615 17005 COMMENT - SCHEMA billing postgres",
      "15; 2615 17006 COMMENT - SCHEMA auth supabase_auth_admin",
      "16; 3079 17007 EXTENSION - pg_cron ",
      "17; 0 0 COMMENT - EXTENSION pg_cron ",
    ].join("\n");
    const plan = rebuildRestoreList(toc, { schemas: ["public", "auth", "storage"], installed: [], available: ["pg_cron"] });
    const kept = plan.kept.map((entry) => entry.id);
    assert.deepEqual(kept, ["11", "13", "14", "16"]);
    assert.deepEqual(plan.storageLoginPolicies, ["lastgood_backup_read_files"]);
    assert.deepEqual(plan.eventTriggers, ["audit_ddl"]);
  });

  it("sorts pg_restore's errors: Supabase's own objects already there, rows that failed, objects to add by hand", () => {
    const stderr = [
      "pg_restore: while PROCESSING TOC:",
      "pg_restore: from TOC entry 3871; 2620 17010 TRIGGER storage objects update_objects_updated_at supabase_storage_admin",
      'pg_restore: error: could not execute query: ERROR:  trigger "update_objects_updated_at" for relation "objects" already exists',
      "Command was: CREATE TRIGGER update_objects_updated_at ...",
      "pg_restore: from TOC entry 3900; 1255 17011 FUNCTION public uses_vault() postgres",
      'pg_restore: error: could not execute query: ERROR:  schema "vault" does not exist',
      "pg_restore: from TOC entry 4100; 0 17012 TABLE DATA public profiles postgres",
      'pg_restore: error: COPY failed for table "profiles": ERROR:  duplicate key value violates unique constraint "profiles_pkey"',
      "pg_restore: warning: errors ignored on restore: 3",
    ].join("\n");
    const sorted = sortRestoreErrors(stderr);
    assert.equal(sorted.already, 1);
    assert.deepEqual(sorted.notRestored, ['function public.uses_vault(): schema "vault" does not exist']);
    assert.equal(sorted.failed.length, 1);
    assert.match(sorted.failed[0], /^table data public\.profiles: COPY failed/);
  });

  it("ties an error to the object pg_restore --verbose named before it", () => {
    const stderr = [
      'pg_restore: creating TRIGGER "storage.objects update_objects_updated_at"',
      'pg_restore: error: could not execute query: ERROR:  trigger "update_objects_updated_at" for relation "objects" already exists',
      'pg_restore: creating EXTENSION "pg_cron"',
      'pg_restore: error: could not execute query: ERROR:  permission denied to create extension "pg_cron"',
      'pg_restore: processing data for table "auth.users"',
      'pg_restore: error: COPY failed for table "users": ERROR:  query would be affected by row-level security policy for table "users"',
    ].join("\n");
    const sorted = sortRestoreErrors(stderr);
    assert.equal(sorted.already, 1);
    assert.deepEqual(sorted.notRestored, ['extension pg_cron: permission denied to create extension "pg_cron"']);
    assert.deepEqual(sorted.failed, ['table data auth.users: COPY failed for table "users": ERROR: query would be affected by row-level security policy for table "users"']);
  });

  it("never prints a connection string or password from a message", () => {
    assert.equal(clean('could not connect to postgresql://postgres:hunter2@db.example.co:5432/postgres password=hunter2'), "could not connect to postgresql://… password=…");
  });
});

describe("the steps", () => {
  it("time each step, stop at the first failure and list what did not run", async () => {
    let clock = 0;
    const out = [];
    const ok = await runSteps(
      [
        { name: "Open the copies", run: async () => ((clock += 2000), "code and database") },
        {
          name: "Code",
          run: async () => {
            clock += 75_000;
            throw new StepError("git could not push to https://github.com/acme/notes.git: denied", "Check you can push to it.");
          },
        },
        { name: "Database", run: async () => "restored" },
      ],
      (text) => out.push(text),
      () => clock,
    );
    const text = out.join("");
    assert.equal(ok, false);
    assert.match(text, /Open the copies: done in 2 s\./);
    assert.match(text, /Code: failed after 1 min 15 s\. git could not push/);
    assert.match(text, /Database\s+not run\s+not run, because Code failed/);
    assert.match(text, /Total 1 min 17 s\./);
    assert.match(text, /Check you can push to it\./);
    assert.doesNotMatch(text, /== Database ==/, "the step after a failure never starts");
  });

  it("gather what is left to do by hand into one numbered list after the summary, with what every rebuild leaves last", async () => {
    const out = [];
    const list = [];
    const ok = await runSteps(
      [
        { name: "Open the copies", run: async () => "code, database and setup" },
        { name: "Code", run: async (say, todo) => (say("Pushed 2 branches."), todo("Set the default branch to main."), "pushed") },
        { name: "Database", skip: "you said an earlier run restored it" },
        {
          name: "Edge Functions and settings",
          run: async (say, todo) => {
            todo("Set these auth settings by hand: smtp_pass.");
            throw new StepError("Supabase did not take 1 Edge Function: hello.");
          },
        },
        { name: "Vercel environment variables", run: async (say, todo) => todo("never reached") },
      ],
      (text) => out.push(text),
      () => 0,
      { always: ["Point your domain at the new project."], list },
    );
    const text = out.join("");
    assert.equal(ok, false);
    assert.match(text, /== Code ==\nPushed 2 branches\.\nSet the default branch to main\.\n/, "a to-do line still shows where it happens");
    const tail = text.slice(text.indexOf("\nStill to do by hand\n"));
    assert.equal(
      tail,
      [
        "",
        "Still to do by hand",
        "  Code",
        "   1. Set the default branch to main.",
        "  Edge Functions and settings",
        "     This step stopped part way, so its list may be short. Run it again once the cause is fixed.",
        "   2. Set these auth settings by hand: smtp_pass.",
        "  Vercel environment variables",
        "     Not known yet: this step did not run. Run it, and it lists its own.",
        "  Every rebuild",
        "   3. Point your domain at the new project.",
        "",
      ].join("\n"),
    );
    assert.deepEqual(list.map((group) => group.name), ["Code", "Edge Functions and settings", "Vercel environment variables", "Every rebuild"]);
    const markdown = todoMarkdown(list, new Date("2026-10-24T08:00:00Z"));
    assert.match(markdown, /^# Still to do by hand\n\nFrom lastgood rebuild, 2026-10-24T08:00:00\.000Z\. Names only: no value, key or password is in this file\.\n\n## Code\n\n1\. Set the default branch to main\.\n\n## Edge Functions and settings\n\nThis step stopped part way/);
    assert.match(markdown, /## Every rebuild\n\n3\. Point your domain at the new project\.\n$/);
    assert.deepEqual(todoList([{ name: "Code", status: "done", todo: [] }], []), [], "nothing to do, no list");
  });

  it("refuses a --todo file that is already there, before anything runs", async () => {
    const dir = folder("lastgood-rebuild-todo-");
    const file = path.join(dir, "todo.md");
    writeFileSync(file, "mine\n");
    const result = await cli(["rebuild", "--key", "k.txt", "--code", "c.tar.gz.age", "--code-to", "git@github.com:acme/notes.git", "--todo", file]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /todo\.md already exists\. Give --todo a new file: rebuild never writes over one\./);
    assert.equal(readFileSync(file, "utf8"), "mine\n");
  });

  it("writes the list to --todo as Markdown, readable only by its owner, even when a step fails", async () => {
    const dir = folder("lastgood-rebuild-todo-");
    const { keyFile, seal } = await keyed(dir);
    const copy = await seal(codeArchive(dir), path.join(dir, "acme-notes-repo-20261017T000000Z.tar.gz.age"));
    const file = path.join(dir, "todo.md");
    const wrong = "0".repeat(64);
    const result = await cli(["rebuild", "--key", keyFile, "--code", copy, "--code-sha256", wrong, "--code-to", path.join(dir, "new.git"), "--todo", file]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /The list is in .*todo\.md too\./);
    const markdown = readFileSync(file, "utf8");
    assert.match(markdown, /## Code\n\nNot known yet: this step did not run\./);
    assert.match(markdown, /## Every rebuild\n\n1\. Rebuild the Vercel project: import the new repository in Vercel, then run lastgood rebuild with --vercel/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("show addresses without a password or token", () => {
    assert.equal(shownGitUrl("https://x-access-token:ghp_secret@github.com/acme/notes.git"), "https://github.com/acme/notes.git");
    assert.equal(githubRepository("git@github.com:acme/notes.git"), "acme/notes");
    assert.equal(githubRepository("https://github.com/acme/notes"), "acme/notes");
    assert.equal(githubRepository("https://gitlab.com/acme/notes.git"), null);
    const target = connection("postgresql://postgres.abcdefghijklmnopqrst:p%40ss@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres");
    assert.equal(target.env.PGPASSWORD, "p@ss");
    assert.doesNotMatch(target.url, /p%40ss|p@ss/);
    assert.equal(target.shown, "aws-0-ap-southeast-2.pooler.supabase.com/postgres");
    assert.throws(() => connection("mysql://x@y/z"), /not a postgresql:\/\/ connection string/);
    assert.equal(duration(59_400), "59 s");
  });

  it("asks GitHub, without a token, whether a repository is public", async () => {
    const answer = (status) => async () => ({ status });
    assert.equal(await githubIsPublic("acme/notes", answer(200)), true);
    assert.equal(await githubIsPublic("acme/notes", answer(404)), false);
    assert.equal(await githubIsPublic("acme/notes", answer(403)), null);
  });
});

/** A repository with two branches and a tag, its bundle and GitHub metadata in a code copy as the backup makes it. */
function codeArchive(dir, { repository = { name: "notes", private: false, default_branch: "main" } } = {}) {
  const source = path.join(dir, "source");
  const run = (args, cwd = source) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  mkdirSync(source);
  run(["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(path.join(source, "README.md"), "notes\n");
  run(["add", "."]);
  run(["commit", "--quiet", "-m", "first"]);
  run(["tag", "v1.0.0"]);
  run(["checkout", "--quiet", "-b", "agent/fix-login"]);
  writeFileSync(path.join(source, "login.ts"), "export {};\n");
  run(["add", "."]);
  run(["commit", "--quiet", "-m", "fix"]);
  const copy = path.join(dir, "copy");
  mkdirSync(path.join(copy, "github"), { recursive: true });
  run(["clone", "--bare", "--quiet", source, path.join(copy, "repo.git")], dir);
  run(["-C", path.join(copy, "repo.git"), "bundle", "create", "--quiet", path.join(copy, "code.bundle"), "--all"], dir);
  rmSync(path.join(copy, "repo.git"), { recursive: true });
  writeFileSync(path.join(copy, "github", "repository.json"), JSON.stringify(repository));
  for (const file of ["issues.json", "issue-comments.json", "pulls.json", "review-comments.json"]) {
    writeFileSync(path.join(copy, "github", file), JSON.stringify(file === "issues.json" ? [{ number: 1 }, { number: 2, pull_request: {} }] : file === "pulls.json" ? [{ number: 2 }] : []));
  }
  const archive = path.join(dir, "code.tar.gz");
  execFileSync("tar", ["-C", copy, "-czf", archive, "."]);
  return archive;
}

describe("lastgood rebuild: code", () => {
  it("pushes every branch and tag to an empty repository, then refuses one that is not empty", async () => {
    const dir = folder("lastgood-rebuild-code-");
    const { keyFile, seal } = await keyed(dir);
    const copy = await seal(codeArchive(dir), path.join(dir, "acme-notes-repo-20261017T000000Z.tar.gz.age"));
    const target = path.join(dir, "new.git");
    execFileSync("git", ["init", "--quiet", "--bare", target]);
    const first = await cli(["rebuild", "--key", keyFile, "--code", copy, "--code-sha256", sha(copy), "--code-to", target]);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /matches the SHA-256 your backup recorded, and opened\./);
    assert.match(first.stdout, /The copy holds 2 branches and 1 tag, and git fsck found no damage\./);
    assert.match(first.stdout, /Pushed 2 branches and 1 tag to /);
    assert.match(first.stdout, /The old default branch was main\./);
    assert.match(first.stdout, /the copy holds 1 issue, 1 pull request and 0 comments as JSON/);
    assert.match(first.stdout, /Rebuild summary\n\s+Open the copies\s+done\s+\d+ s\s+code\n\s+Code\s+done\s+\d+ s\s+2 branches and 1 tag pushed/);
    // The by-hand lines again, in one numbered list after the summary, with what every rebuild leaves last.
    const list = first.stdout.slice(first.stdout.indexOf("\nStill to do by hand\n"));
    assert.match(list, /^\nStill to do by hand\n  Code\n   1\. The old default branch was main\. If GitHub shows another, set it under Settings, then Branches\.\n   2\. Issues and pull requests are not recreated: /);
    assert.match(list, /\n  Every rebuild\n   3\. Rebuild the Vercel project: import the new repository in Vercel, then run lastgood rebuild with --vercel and the night's Vercel copy, which puts back its environment variables, settings and domains\. Without a Vercel copy, set them by hand as the old project had them\.\n   4\. Point your domain at the new Vercel project where its DNS is kept .*\n   5\. Connect the new repository and project to LastGood, so backups start again/);
    assert.doesNotMatch(list, /Open the copies/, "a step with nothing to add is left out");
    const refs = execFileSync("git", ["-C", target, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(refs, ["refs/heads/agent/fix-login", "refs/heads/main", "refs/tags/v1.0.0"]);

    const again = await cli(["rebuild", "--key", keyFile, "--code", copy, "--code-sha256", sha(copy), "--code-to", target]);
    assert.equal(again.status, 1);
    assert.match(again.stdout, /is not empty, so nothing was pushed\. Rebuild pushes only into a new, empty repository/);
  });

  it("will not push a private repository's code to a public one", async () => {
    const dir = folder("lastgood-rebuild-private-");
    const archive = codeArchive(dir, { repository: { name: "notes", private: true, default_branch: "main" } });
    const work = folder("lastgood-rebuild-work-");
    const said = [];
    await assert.rejects(
      rebuildCode({ archive, to: "https://github.com/acme/notes-rebuilt.git", work, say: (line) => said.push(line), fetchImpl: async () => ({ status: 200 }) }),
      /acme\/notes-rebuilt is public, and the old repository was private, so the code was not pushed\./,
    );
  });

  it("refuses a --code-to address that git would read as an option", async () => {
    const dir = folder("lastgood-rebuild-option-");
    const archive = codeArchive(dir);
    const marker = path.join(dir, "ran");
    await assert.rejects(
      rebuildCode({ archive, to: `--upload-pack=touch ${marker}`, work: folder("lastgood-rebuild-work-"), say: () => {} }),
      /The --code-to address starts with "-", so nothing was pushed\./,
    );
    assert.equal(existsSync(marker), false);
  });

  it("refuses a code or files copy naming a path outside its own folder, before anything is opened", async () => {
    assert.equal(outsideName("./code.bundle"), false);
    assert.equal(outsideName("./a..b/c"), false);
    assert.equal(outsideName("../evil.txt"), true);
    assert.equal(outsideName("./attachments/../../evil.txt"), true);
    assert.equal(outsideName("/etc/cron.d/evil"), true);
    const dir = folder("lastgood-rebuild-outside-");
    const copy = path.join(dir, "copy");
    mkdirSync(path.join(copy, "attachments"), { recursive: true });
    writeFileSync(path.join(copy, "attachments", "a.txt"), "a\n");
    writeFileSync(path.join(dir, "evil.txt"), "evil\n");
    // -P keeps a ".." or absolute name in the archive, as a hand-made archive could.
    const dotted = path.join(dir, "dotted.tar.gz");
    execFileSync("tar", ["-C", copy, "-czPf", dotted, "./attachments/a.txt", "../evil.txt"]);
    const absolute = path.join(dir, "absolute.tar");
    execFileSync("tar", ["-C", copy, "-cPf", absolute, "./attachments/a.txt", path.join(dir, "evil.txt")]);
    const work = folder("lastgood-rebuild-work-");
    await assert.rejects(rebuildCode({ archive: dotted, to: path.join(dir, "x.git"), work, say: () => {} }), /The code copy names a path outside its own folder \(\.\.\/evil\.txt\)/);
    const files = (archive) =>
      rebuildFiles({ archive, dumpPath: "unused", databaseTo: "postgresql://u@127.0.0.1/x", filesTo: "http://127.0.0.1:9", key: "sb_secret_x", work, say: () => {} });
    await assert.rejects(files(absolute), /The files copy names a path outside its own folder \(\/.*evil\.txt\)/);
    assert.equal(existsSync(path.join(work, "evil.txt")), false);
    assert.equal(existsSync(path.join(work, "files")), false, "nothing was opened");
  });

  it("refuses a code copy holding a link", async () => {
    const dir = folder("lastgood-rebuild-link-");
    const copy = path.join(dir, "copy");
    mkdirSync(copy);
    execFileSync("ln", ["-s", "/etc/hostname", path.join(copy, "code.bundle")]);
    const archive = path.join(dir, "code.tar.gz");
    execFileSync("tar", ["-C", copy, "-czf", archive, "."]);
    await assert.rejects(rebuildCode({ archive, to: path.join(dir, "x.git"), work: folder("lastgood-rebuild-work-"), say: () => {} }), /holds something other than plain files and folders/);
  });
});

// The database step against a real Postgres server: a new project set up like a hosted one (fresh-project.sql), with
// the restore run as a role that is not a superuser, over a password-protected connection.
const TOOLS = ["initdb", "pg_ctl", "psql", "pg_restore", "pg_dump"];
function findPostgres() {
  const candidates = [process.env.LIFEBOAT_TEST_PG_BIN, ...[18, 17, 16].map((major) => `/usr/lib/postgresql/${major}/bin`)];
  for (const bin of candidates.filter(Boolean)) {
    if (!TOOLS.every((tool) => existsSync(path.join(bin, tool)))) continue;
    if (process.getuid?.() !== 0) return { bin, base: tmpdir() };
    const entry = spawnSync("getent", ["passwd", "postgres"], { encoding: "utf8" }).stdout?.trim().split(":") ?? [];
    if (entry.length < 6 || !existsSync(entry[5])) continue;
    return { bin, base: entry[5], user: { uid: Number(entry[2]), gid: Number(entry[3]) } };
  }
  return null;
}
const PG = findPostgres();
const NO_PG = PG ? false : "no Postgres 16 or newer server binaries (initdb, pg_ctl) on this machine";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const PASSWORD = "rebuild-test-pass@word";

async function startCluster() {
  const dir = mkdtempSync(path.join(PG.base, "lg-rebuild-pg-"));
  if (PG.user) chownSync(dir, PG.user.uid, PG.user.gid);
  const asServer = (command, args) => spawnSync(path.join(PG.bin, command), args, { encoding: "utf8", ...(PG.user ?? {}) });
  const data = path.join(dir, "data");
  const port = await freePort();
  const init = asServer("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=scram-sha-256", "--no-sync"]);
  assert.equal(init.status, 0, init.stderr);
  const start = asServer("pg_ctl", ["-D", data, "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "-l", path.join(dir, "server.log"), "-w", "start"]);
  assert.equal(start.status, 0, start.stderr);
  const admin = (database) => `postgresql://postgres@/${database}?host=${dir}&port=${port}`;
  const sql = (database, text) =>
    execFileSync(path.join(PG.bin, "psql"), [admin(database), "--no-psqlrc", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", text], { encoding: "utf8" }).trim();
  const sqlFile = (database, file) =>
    execFileSync(path.join(PG.bin, "psql"), [admin(database), "--no-psqlrc", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8", stdio: "pipe" });
  // A hosted project's postgres role can bypass row-level security, which Supabase turns on for auth.users.
  sql("postgres", `CREATE ROLE rebuilder LOGIN BYPASSRLS PASSWORD '${PASSWORD}'`);
  /** A new project, owned by `rebuilder` as a hosted project's database is owned by its postgres role. */
  const project = (name) => {
    sql("postgres", `CREATE DATABASE ${name} OWNER rebuilder`);
    sqlFile(name, path.join(FIXTURE, "fresh-project.sql"));
    return `postgresql://rebuilder:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}/${name}`;
  };
  return {
    sql,
    sqlFile,
    project,
    admin,
    stop() {
      asServer("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("lastgood rebuild: database", { skip: NO_FIXTURE || NO_PG }, () => {
  it("restores a Supabase-shaped copy into a new project: the app, its users, buckets, sign-up trigger and storage policy", async () => {
    const cluster = await startCluster();
    try {
      const to = cluster.project("fresh");
      const dir = folder("lastgood-rebuild-db-");
      const { keyFile, seal } = await keyed(dir);
      const copy = await seal(path.join(FIXTURE, "dump.backup"), path.join(dir, "acme-notes-database-20261017T000000Z.backup.age"));
      const env = { PATH: `${PG.bin}:${process.env.PATH}`, LASTGOOD_DATABASE_TO: to };
      const result = await cli(["rebuild", "--key", keyFile, "--database", copy, "--database-sha256", sha(copy)], env);
      const printed = result.stdout + result.stderr;
      assert.equal(result.status, 0, printed);
      assert.doesNotMatch(printed, /rebuild-test-pass|pass%40word/, "the password is never printed");
      assert.match(result.stdout, /127\.0\.0\.1\/fresh is empty\. Restoring into it\./);
      assert.match(result.stdout, /Row count matched for public\.\w+: \d+\./);
      assert.match(result.stdout, /Users restored: 12 accounts, 9 with a password, 12 sign-in identities, matching the dump\./);
      assert.match(result.stdout, /Extensions this project does not offer, left out: .*pg_graphql/);
      assert.match(result.stdout, /Left out 5 rows of Supabase's storage\.objects: the files themselves are not in the database copy\./);
      assert.match(result.stdout, /Left out 1 row of Supabase's vault\.secrets: Vault secrets are sealed/);
      assert.doesNotMatch(result.stdout, /auth\.schema_migrations/, "Supabase's own bookkeeping is not worth a line");
      assert.match(result.stdout, /1 trigger or policy of Supabase's own was already in the new project, as expected\./);
      assert.match(result.stdout, /Restored the app's schema and the rows of 6 tables\./);
      assert.match(result.stdout, /Database\s+done\s+\d+ s\s+12 users/);

      const q = (text) => cluster.sql("fresh", text);
      assert.equal(q("SELECT count(*) FROM public.profiles"), "12");
      assert.equal(q("SELECT count(*) FROM public.listings"), "12");
      assert.equal(q("SELECT count(*) FROM auth.identities"), "12");
      assert.equal(q("SELECT string_agg(id, ',') FROM storage.buckets"), "avatars");
      assert.equal(q("SELECT count(*) FROM storage.objects"), "0");
      assert.equal(q("SELECT count(*) FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass"), "1");
      assert.equal(q("SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'Signed-in users read avatars'"), "1");
      assert.equal(q("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass"), "t");
      assert.equal(q("SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'messages'"), "1");
      assert.equal(q("SELECT has_table_privilege('authenticated', 'public.profiles', 'SELECT')"), "t", "Supabase's default grants apply");
      // A new sign-up still makes its profile, as on the old project.
      q("INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('00000000-0000-4000-8000-000000000099', 'new@example.invalid', '{\"username\":\"newbie\"}')");
      assert.equal(q("SELECT username FROM public.profiles WHERE id = '00000000-0000-4000-8000-000000000099'"), "newbie");

      const again = await cli(["rebuild", "--key", keyFile, "--database", copy, "--database-sha256", sha(copy)], env);
      assert.equal(again.status, 1);
      assert.match(again.stdout, /127\.0\.0\.1\/fresh is not empty: it has \d+ tables and views .*, 13 users, 1 storage buckets\. Nothing was written\./);

      // A plain Postgres database has nowhere to put the users.
      cluster.sql("postgres", "CREATE DATABASE plain OWNER rebuilder");
      const plain = to.replace(/\/fresh$/, "/plain");
      const noAuth = await cli(["rebuild", "--key", keyFile, "--database", copy, "--database-sha256", sha(copy)], { ...env, LASTGOOD_DATABASE_TO: plain });
      assert.equal(noAuth.status, 1);
      assert.match(noAuth.stdout, /127\.0\.0\.1\/plain has no Supabase Auth \(auth\.users\), so the app's users have nowhere to go\. Nothing was written\./);
      assert.equal(cluster.sql("plain", "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"), "0");
    } finally {
      cluster.stop();
    }
  });

  it("leaves LastGood's storage login and its policies behind, so the old project's secret cannot read the new one", async () => {
    const cluster = await startCluster();
    try {
      // An old project that LastGood connected: one app user, the storage login, and the login's read policy.
      cluster.sql("postgres", "CREATE DATABASE oldapp OWNER rebuilder");
      cluster.sqlFile("oldapp", path.join(FIXTURE, "fresh-project.sql"));
      cluster.sql(
        "oldapp",
        `INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data) VALUES
          ('00000000-0000-4000-8000-000000000001', 'ada@example.invalid', '$2a$10$x', '{}'),
          ('00000000-0000-4000-8000-0000000000ff', 'lastgood-backup@lastgood.invalid', '$2a$10$y', '{"lastgood":"storage-backup"}');
        INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
          SELECT id::text, id, jsonb_build_object('sub', id::text, 'email', email), 'email' FROM auth.users;
        CREATE POLICY lastgood_backup_read_files ON storage.objects FOR SELECT TO authenticated
          USING ((SELECT auth.uid()) = '00000000-0000-4000-8000-0000000000ff'::uuid);
        CREATE TABLE public.notes (id int PRIMARY KEY, body text);
        INSERT INTO public.notes VALUES (1, 'hello');`,
      );
      const dir = folder("lastgood-rebuild-login-");
      const dump = path.join(dir, "old.backup");
      execFileSync(path.join(PG.bin, "pg_dump"), [cluster.admin("oldapp"), "--format=custom", "--no-owner", "--no-acl", "--file", dump]);
      const to = cluster.project("fresh2");
      const { keyFile, seal } = await keyed(dir);
      const copy = await seal(dump, path.join(dir, "acme-notes-database-20261018T000000Z.backup.age"));
      const result = await cli(["rebuild", "--key", keyFile, "--database", copy, "--unchecked"], { PATH: `${PG.bin}:${process.env.PATH}`, LASTGOOD_DATABASE_TO: to });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /LastGood's storage login from the old project was left out\./);
      assert.match(result.stdout, /Left out the storage login's policies: lastgood_backup_read_files\./);
      assert.match(result.stdout, /Users restored: 1 accounts, 1 with a password, 1 sign-in identities, matching the dump\./);
      const q = (text) => cluster.sql("fresh2", text);
      assert.equal(q("SELECT string_agg(email, ',') FROM auth.users"), "ada@example.invalid");
      assert.equal(q("SELECT count(*) FROM auth.identities"), "1");
      assert.equal(q("SELECT count(*) FROM pg_policies WHERE policyname LIKE 'lastgood_backup%'"), "0");
      assert.equal(q("SELECT body FROM public.notes"), "hello");
    } finally {
      cluster.stop();
    }
  });

  /** An old project whose sign-up trigger gave LastGood's storage login a profile row too, as the D17 drill's does. */
  async function loginWithProfile(cluster, name, foreignKey) {
    cluster.sql("postgres", `CREATE DATABASE ${name} OWNER rebuilder`);
    cluster.sqlFile(name, path.join(FIXTURE, "fresh-project.sql"));
    cluster.sql(
      name,
      `INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data) VALUES
        ('00000000-0000-4000-8000-000000000001', 'ada@example.invalid', '$2a$10$x', '{}'),
        ('00000000-0000-4000-8000-000000000002', 'bea@example.invalid', '$2a$10$x', '{}'),
        ('00000000-0000-4000-8000-0000000000ff', 'lastgood-backup@lastgood.invalid', '$2a$10$y', '{"lastgood":"storage-backup"}');
      INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
        SELECT id::text, id, jsonb_build_object('sub', id::text, 'email', email), 'email' FROM auth.users;
      CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users (id) ${foreignKey}, username text);
      INSERT INTO public.profiles SELECT id, split_part(email, '@', 1) FROM auth.users;`,
    );
    const dir = folder("lastgood-rebuild-profile-");
    const dump = path.join(dir, "old.backup");
    execFileSync(path.join(PG.bin, "pg_dump"), [cluster.admin(name), "--format=custom", "--no-owner", "--no-acl", "--file", dump]);
    const { keyFile, seal } = await keyed(dir);
    return { keyFile, copy: await seal(dump, path.join(dir, "acme-notes-database-20261018T000000Z.backup.age")) };
  }

  it("checks the rows while the storage login is there, then names the app's rows that went with it", async () => {
    const cluster = await startCluster();
    try {
      const { keyFile, copy } = await loginWithProfile(cluster, "cascading", "ON DELETE CASCADE");
      const to = cluster.project("fresh3");
      const result = await cli(["rebuild", "--key", keyFile, "--database", copy, "--unchecked"], { PATH: `${PG.bin}:${process.env.PATH}`, LASTGOOD_DATABASE_TO: to });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Row count matched for public\.profiles: 3\./, "counted as the dump counts it, before the login goes");
      assert.match(result.stdout, /Users restored: 2 accounts, 2 with a password, 2 sign-in identities, matching the dump\./);
      assert.match(result.stdout, /LastGood's storage login from the old project was left out\./);
      assert.match(result.stdout, /The app's rows that pointed at it went with it, as their foreign keys cascade: public\.profiles \(1 row\), and any rows that cascade from those\./);
      const q = (text) => cluster.sql("fresh3", text);
      assert.equal(q("SELECT string_agg(email, ',' ORDER BY email) FROM auth.users"), "ada@example.invalid,bea@example.invalid");
      assert.equal(q("SELECT string_agg(username, ',' ORDER BY username) FROM public.profiles"), "ada,bea");
    } finally {
      cluster.stop();
    }
  });

  it("after a restore that failed part way, says so when the storage login cannot be taken out, rather than hiding it", async () => {
    const cluster = await startCluster();
    const path0 = process.env.PATH;
    try {
      const to = cluster.project("partial");
      cluster.sql(
        "partial",
        `INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data) VALUES
          ('00000000-0000-4000-8000-0000000000ff', 'lastgood-backup@lastgood.invalid', '$2a$10$y', '{"lastgood":"storage-backup"}');
        CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users (id), username text);
        INSERT INTO public.profiles VALUES ('00000000-0000-4000-8000-0000000000ff', 'lastgood-backup');
        ALTER TABLE public.profiles OWNER TO rebuilder;`,
      );
      process.env.PATH = `${PG.bin}:${path0}`;
      const said = [];
      const todo = [];
      await takeOutLoginAfterFailure(connection(to), SUPABASE_SCHEMAS, (line) => said.push(line), (line) => todo.push(line));
      assert.equal(todo.length, 1);
      assert.match(todo[0], /^LastGood's storage login from the old project is still in the new one, because public\.profiles \(1 row\) points at it with a foreign key that does not cascade\..* Deleting the new project, as the summary says, takes it out too; otherwise delete the user lastgood-backup@lastgood\.invalid in Supabase under Authentication\.$/);
      assert.equal(cluster.sql("partial", "SELECT count(*) FROM auth.users"), "1");
    } finally {
      process.env.PATH = path0;
      cluster.stop();
    }
  });

  it("stops, naming the table, when a foreign key that does not cascade keeps the storage login in", async () => {
    const cluster = await startCluster();
    try {
      const { keyFile, copy } = await loginWithProfile(cluster, "refusing", "");
      const to = cluster.project("fresh4");
      const result = await cli(["rebuild", "--key", keyFile, "--database", copy, "--unchecked"], { PATH: `${PG.bin}:${process.env.PATH}`, LASTGOOD_DATABASE_TO: to });
      assert.equal(result.status, 1);
      const text = result.stdout + result.stderr;
      assert.match(text, /LastGood's storage login from the old project is still in the new one, because public\.profiles \(1 row\) points at it with a foreign key that does not cascade\./);
      assert.match(text, /Delete those rows, then delete the user lastgood-backup@lastgood\.invalid in Supabase under Authentication\./);
      assert.equal(cluster.sql("fresh4", "SELECT count(*) FROM public.profiles"), "3", "no app row is deleted to make room");
    } finally {
      cluster.stop();
    }
  });
});

describe("lastgood rebuild: files, the parts that need no server", () => {
  it("finds the new project from its connection string, and refuses a URL for another project", () => {
    assert.equal(projectRef("postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres"), "abcdefghijklmnopqrst");
    assert.equal(projectRef("postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres"), "abcdefghijklmnopqrst");
    assert.equal(projectRef("postgresql://rebuilder@127.0.0.1:5432/fresh"), null);
    const pooled = "postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres";
    assert.equal(storageBase(undefined, pooled), "https://abcdefghijklmnopqrst.supabase.co");
    assert.equal(storageBase("https://abcdefghijklmnopqrst.supabase.co/", pooled), "https://abcdefghijklmnopqrst.supabase.co");
    assert.throws(() => storageBase("https://zyxwvutsrqponmlkjihg.supabase.co", pooled), /--files-to is project zyxwvutsrqponmlkjihg, but the database connection string is project abcdefghijklmnopqrst/);
    assert.throws(() => storageBase(undefined, "postgresql://rebuilder@127.0.0.1:5432/fresh"), /Give --files-to/);
    assert.throws(() => storageBase("http://abcdefghijklmnopqrst.supabase.co", pooled), /must start with https:\/\//);
    assert.equal(storageBase("http://127.0.0.1:5999", "postgresql://rebuilder@127.0.0.1:5432/fresh"), "http://127.0.0.1:5999");
  });

  it("takes keys out of any message", () => {
    assert.equal(clean("refused sb_secret_abc-DEF_123 and sb_publishable_x1"), "refused sb_secret_… and sb_publishable_…");
    assert.equal(clean("token sbp_0123456789abcdef refused"), "token sbp_… refused");
    assert.equal(clean("Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl"), "Bearer …");
  });

  it("takes a secret key or the legacy service_role key, and refuses the publishable or anon key", () => {
    const jwt = (role) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
    assert.equal(checkSecretKey(" sb_secret_abc "), "sb_secret_abc");
    assert.equal(checkSecretKey(jwt("service_role")), jwt("service_role"));
    assert.throws(() => checkSecretKey(""), /Set LASTGOOD_SUPABASE_SECRET_KEY/);
    assert.throws(() => checkSecretKey("sb_publishable_abc"), /holds the publishable key/);
    assert.throws(() => checkSecretKey(jwt("anon")), /is not a secret key/);
  });

  it("reads storage.objects rows as pg_dump writes them, and only header-safe types and cache settings", () => {
    assert.equal(decodeCopyField("\\N"), null);
    assert.equal(decodeCopyField("a\\tb\\\\c\\nd\\101"), "a\tb\\c\ndA");
    const block = copyBlock(
      ["SET x = 1;", "COPY storage.objects (id, bucket_id, name, owner, metadata) FROM stdin;", "1\tdocs\ta\\tb.txt\t\\N\t{\"mimetype\": \"text/plain\", \"cacheControl\": \"max-age=60\"}", "\\.", ""].join("\n"),
      "storage.objects",
    );
    assert.deepEqual(block.columns, ["id", "bucket_id", "name", "owner", "metadata"]);
    const row = copyRow(block.columns, block.lines[0]);
    assert.equal(row.name, "a\tb.txt");
    assert.equal(row.owner, null);
    assert.deepEqual(fileMeta(row), { type: "text/plain", cache: "max-age=60", maxAge: "60" });
    assert.deepEqual(fileMeta({ metadata: '{"mimetype": "text/plain\\r\\nX-Evil: 1"}' }), { type: "application/octet-stream", cache: null, maxAge: null });
    assert.deepEqual(fileMeta(undefined), { type: "application/octet-stream", cache: null, maxAge: null });
  });

  it("asks for the database copy and the secret key before anything runs", async () => {
    const noDatabase = await cli(["rebuild", "--key", "k.txt", "--files", "f.tar.age"]);
    assert.equal(noDatabase.status, 2);
    assert.match(noDatabase.stderr, /Give --database with --files: each file's type and owner come from the database copy\./);
    const noKey = await cli(["rebuild", "--key", "k.txt", "--files", "f.tar.age", "--database", "d.age", "--database-to", "postgresql://postgres.abcdefghijklmnopqrst:pw@h:5432/postgres"], {
      LASTGOOD_SUPABASE_SECRET_KEY: "",
    });
    assert.equal(noKey.status, 2);
    assert.match(noKey.stderr, /Set LASTGOOD_SUPABASE_SECRET_KEY to the new project's secret key/);
    const badSkip = await cli(["rebuild", "--key", "k.txt", "--database", "d.age", "--database-to", "postgresql://x@h/p", "--skip", "code"]);
    assert.equal(badSkip.status, 2);
    assert.match(badSkip.stderr, /Only the database step can be skipped/);
  });
});

const lit = (value) => (value === null ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);

/**
 * Enough of a new project's Storage API for rebuild, as Supabase answers it: buckets from the project's database,
 * files kept in memory, standard and resumable (TUS) uploads that never write over a file, and each upload adding its
 * storage.objects row with no owner, as an upload with the secret key does.
 */
async function fakeStorage({ key, sql, limit = Infinity, refuse = () => null }) {
  const files = new Map();
  const pending = new Map();
  const stats = { standard: 0, resumable: 0 };
  const keep = (bucket, name, body, type, cache) => {
    files.set(`${bucket}/${name}`, { body, type, cache });
    sql(`INSERT INTO storage.objects (bucket_id, name, metadata) VALUES (${lit(bucket)}, ${lit(name)}, ${lit(JSON.stringify({ size: body.length, mimetype: type, cacheControl: cache }))})`);
  };
  const server = createHttpServer((request, response) =>
    handle(request, response).catch((error) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ statusCode: "500", error: "internal", message: String(error?.message ?? error).slice(0, 200) }));
    }),
  );
  async function handle(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (status, json, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (request.headers.apikey !== key || request.headers.authorization !== `Bearer ${key}`) return send(403, { statusCode: "403", error: "Unauthorized", message: "Invalid key" });
    const parts = new URL(request.url, "http://storage").pathname.split("/").slice(3).map(decodeURIComponent);
    const [area, action] = parts;
    const refused = refuse(request, parts);
    if (refused) return send(refused.status, refused.body);
    if (area === "bucket" && request.method === "GET") return send(200, JSON.parse(sql("SELECT coalesce(json_agg(json_build_object('id', id, 'name', name)), '[]') FROM storage.buckets")));
    if (area === "object" && action === "list") {
      const bucket = parts[2];
      const { prefix, limit: size, offset } = JSON.parse(String(body));
      const entries = new Map();
      for (const [path_, file] of files) {
        if (!path_.startsWith(`${bucket}/${prefix}`)) continue;
        const rest = path_.slice(bucket.length + 1 + prefix.length);
        if (rest.includes("/")) entries.set(rest.split("/")[0], { name: rest.split("/")[0], id: null, metadata: null });
        else entries.set(rest, { name: rest, id: "file", metadata: { size: file.body.length } });
      }
      return send(200, [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).slice(offset, offset + size));
    }
    if (area === "object" && action === "authenticated" && request.method === "GET") {
      const file = files.get(parts.slice(2).join("/"));
      if (!file) return send(400, { statusCode: "404", error: "not_found", message: "Object not found" });
      response.writeHead(200, { "Content-Type": file.type });
      return response.end(file.body);
    }
    if (area === "object" && request.method === "POST") {
      const [bucket, ...rest] = parts.slice(1);
      if (files.has(`${bucket}/${rest.join("/")}`)) return send(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      if (body.length > limit) return send(400, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
      stats.standard += 1;
      keep(bucket, rest.join("/"), body, request.headers["content-type"], request.headers["cache-control"] ?? "no-cache");
      return send(200, { Key: `${bucket}/${rest.join("/")}` });
    }
    if (area === "upload" && action === "resumable" && parts.length === 2 && request.method === "POST") {
      const meta = Object.fromEntries(String(request.headers["upload-metadata"]).split(",").map((field) => field.split(" ")).map(([name, value]) => [name, Buffer.from(value, "base64").toString("utf8")]));
      if (files.has(`${meta.bucketName}/${meta.objectName}`)) return send(409, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      const id = `u${pending.size + 1}`;
      pending.set(id, { meta, length: Number(request.headers["upload-length"]), received: [] });
      return send(201, undefined, { Location: `/storage/v1/upload/resumable/${id}`, "Tus-Resumable": "1.0.0" });
    }
    if (area === "upload" && action === "resumable" && parts.length === 3) {
      const upload = pending.get(parts[2]);
      const offset = upload.received.reduce((total, part) => total + part.length, 0);
      if (request.method === "HEAD") return send(200, undefined, { "Upload-Offset": String(offset) });
      if (Number(request.headers["upload-offset"]) !== offset) return send(409, { statusCode: "409", error: "Conflict", message: "Offset mismatch" });
      upload.received.push(body);
      const now = offset + body.length;
      if (now === upload.length) {
        stats.resumable += 1;
        keep(upload.meta.bucketName, upload.meta.objectName, Buffer.concat(upload.received), upload.meta.contentType, upload.meta.cacheControl ? `max-age=${upload.meta.cacheControl}` : "no-cache");
      }
      return send(204, undefined, { "Upload-Offset": String(now) });
    }
    return send(400, { statusCode: "404", error: "not_found", message: `No route for ${request.method} ${request.url}` });
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, files, stats, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe("lastgood rebuild: files", { skip: NO_FIXTURE || NO_PG }, () => {
  const ADA = "00000000-0000-4000-8000-000000000001";
  const BOB = "00000000-0000-4000-8000-000000000002";
  const KEY = "sb_secret_rebuild-test-key";
  let cluster;
  let fixture;

  before(async () => {
    cluster = await startCluster();
    // The old project: two users, a private and a public bucket, and file records with owners, types and cache settings.
    cluster.sql("postgres", "CREATE DATABASE filesold OWNER rebuilder");
    cluster.sqlFile("filesold", path.join(FIXTURE, "fresh-project.sql"));
    cluster.sql(
      "filesold",
      `INSERT INTO auth.users (id, email, encrypted_password) VALUES ('${ADA}', 'ada@example.invalid', '$2a$10$x'), ('${BOB}', 'bob@example.invalid', '$2a$10$y');
      INSERT INTO auth.identities (provider_id, user_id, identity_data, provider) SELECT id::text, id, jsonb_build_object('sub', id::text, 'email', email), 'email' FROM auth.users;
      INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', false), ('avatars', 'avatars', true);
      INSERT INTO storage.objects (bucket_id, name, owner, owner_id, user_metadata, metadata) VALUES
        ('attachments', 'ada/notes.txt', '${ADA}', '${ADA}', '{"label": "mine"}', '{"size": 10, "mimetype": "text/plain", "cacheControl": "max-age=60"}'),
        ('attachments', 'bob/Q1 & Q2 report.pdf', '${BOB}', '${BOB}', NULL, '{"size": 9, "mimetype": "application/pdf", "cacheControl": "max-age=3600"}'),
        ('attachments', '.emptyFolderPlaceholder', NULL, NULL, NULL, '{"size": 0, "mimetype": "application/octet-stream"}'),
        ('avatars', 'big.bin', NULL, NULL, NULL, '{"size": ${CHUNK + 100}, "mimetype": "application/octet-stream", "cacheControl": "max-age=3600"}');
      CREATE POLICY "Users read their own files" ON storage.objects FOR SELECT TO authenticated USING (owner_id = (SELECT auth.uid())::text);`,
    );
    const dir = folder("lastgood-rebuild-files-");
    const dump = path.join(dir, "old.backup");
    execFileSync(path.join(PG.bin, "pg_dump"), [cluster.admin("filesold"), "--format=custom", "--no-owner", "--no-acl", "--file", dump]);
    // The files copy, laid out as the backup's storage copy saves it: <bucket>/<path>.
    const tree = path.join(dir, "tree");
    const big = Buffer.alloc(CHUNK + 100, 7);
    for (const [name, body] of [
      ["attachments/ada/notes.txt", Buffer.from("hello ada\n")],
      ["attachments/bob/Q1 & Q2 report.pdf", Buffer.from("%PDF-1.4\n")],
      ["attachments/.emptyFolderPlaceholder", Buffer.alloc(0)],
      ["avatars/big.bin", big],
    ]) {
      mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
      writeFileSync(path.join(tree, name), body);
    }
    const archive = path.join(dir, "files.tar");
    execFileSync("tar", ["-C", tree, "-cf", archive, "."]);
    const { keyFile, seal } = await keyed(dir);
    fixture = {
      dir,
      dump,
      archive,
      big,
      keyFile,
      database: await seal(dump, path.join(dir, "acme-notes-database-20261019T000000Z.backup.age")),
      files: await seal(archive, path.join(dir, "acme-notes-storage-20261019T000000Z.tar.age")),
    };
  });
  after(() => cluster?.stop());

  it("puts every file back with its type, cache setting and owner, carries on after a stop, and never writes over a file", async () => {
    const to = cluster.project("filesnew");
    const q = (text) => cluster.sql("filesnew", text);
    const storage = await fakeStorage({ key: KEY, sql: q });
    try {
      const env = { PATH: `${PG.bin}:${process.env.PATH}`, LASTGOOD_DATABASE_TO: to, LASTGOOD_SUPABASE_SECRET_KEY: KEY };
      const args = ["rebuild", "--key", fixture.keyFile, "--unchecked", "--database", fixture.database, "--files", fixture.files, "--files-to", storage.url];
      const first = await cli(args, env);
      const printed = first.stdout + first.stderr;
      assert.equal(first.status, 0, printed);
      assert.doesNotMatch(printed, /rebuild-test-key|rebuild-test-pass/, "neither the secret key nor the password is printed");
      assert.match(first.stdout, /The copy holds 4 files \(6291575 bytes\) in 2 buckets\./);
      assert.match(first.stdout, /Uploaded 4 files \(6291575 bytes\)\./);
      assert.match(first.stdout, /127\.0\.0\.1:\d+ holds every file in the copy at the size it was saved: 4 files/);
      assert.match(first.stdout, /A sample file of 9 bytes read back the same as the copy\./);
      assert.match(first.stdout, /Owners: set 2 of the 2 the database copy names, so policies that let users reach their own files still match\./);
      assert.match(first.stdout, /Open the copies\s+done\s+\d+ s\s+database and files/);
      assert.match(first.stdout, /Files\s+done\s+\d+ s\s+4 files in 2 buckets/);
      assert.match(first.stdout, /\nStill to do by hand\n  Database\n   1\. Grants come back as Supabase's defaults/);
      assert.doesNotMatch(first.stdout.slice(first.stdout.indexOf("Still to do by hand")), /storage\.objects/, "rows the files step puts back are not a to-do");
      assert.equal(storage.stats.resumable, 1, "the file over 6 MB went up in parts");
      assert.equal(storage.stats.standard, 3);

      const ada = storage.files.get("attachments/ada/notes.txt");
      assert.equal(String(ada.body), "hello ada\n");
      assert.equal(ada.type, "text/plain");
      assert.equal(ada.cache, "max-age=60");
      assert.equal(storage.files.get("attachments/bob/Q1 & Q2 report.pdf").type, "application/pdf");
      const big = storage.files.get("avatars/big.bin");
      assert.ok(big.body.equals(fixture.big));
      assert.equal(big.cache, "max-age=3600");
      assert.equal(q("SELECT owner_id FROM storage.objects WHERE name = 'ada/notes.txt'"), ADA);
      assert.equal(q("SELECT owner FROM storage.objects WHERE name = 'bob/Q1 & Q2 report.pdf'"), BOB);
      assert.equal(q("SELECT user_metadata->>'label' FROM storage.objects WHERE name = 'ada/notes.txt'"), "mine");
      assert.equal(q("SELECT count(*) FROM storage.objects WHERE owner IS NULL"), "2");
      assert.equal(q("SELECT count(*) FROM pg_policies WHERE policyname = 'Users read their own files'"), "1");

      // A second run with the database already back keeps every file and sends none again.
      const again = await cli([...args, "--skip", "database"], env);
      assert.equal(again.status, 0, again.stdout + again.stderr);
      assert.match(again.stdout, /Skipped: you said an earlier run restored it\./);
      assert.match(again.stdout, /4 files were already in 127\.0\.0\.1:\d+ at the same size, from an earlier run, and are kept\./);
      assert.doesNotMatch(again.stdout, /Uploaded/);
      assert.match(again.stdout, /Owners: set 0 of the 2 the database copy names, and 2 already had theirs from an earlier run/);
      assert.match(again.stdout, /Database\s+skipped\s+you said an earlier run restored it/);
      assert.equal(storage.stats.standard + storage.stats.resumable, 4);

      // A file whose owner someone changed is left as it is, and named.
      q(`UPDATE storage.objects SET owner = NULL, owner_id = '${ADA}' WHERE name = 'bob/Q1 & Q2 report.pdf'`);
      const owned = await cli([...args, "--skip", "database"], env);
      assert.equal(owned.status, 1);
      assert.match(owned.stdout, /1 file in 127\.0\.0\.1:\d+ already has an owner other than the database copy's \(attachments\/bob\/Q1 & Q2 report\.pdf\), so it was left as it is\./);
      assert.equal(q("SELECT owner_id FROM storage.objects WHERE name = 'bob/Q1 & Q2 report.pdf'"), ADA, "an owner already set is never changed");

      // A file at the same path with other bytes stops the step before anything is uploaded.
      storage.files.set("attachments/ada/notes.txt", { ...ada, body: Buffer.from("changed by hand\n") });
      const clash = await cli([...args, "--skip", "database"], env);
      assert.equal(clash.status, 1);
      assert.match(clash.stdout, /already has 1 file at the same path as the copy but a different size \(attachments\/ada\/notes\.txt\)\. Nothing was uploaded: rebuild never writes over a file\./);
    } finally {
      await storage.close();
    }
  });

  it("stops by name on a missing bucket, a refused key, or files larger than the new project takes", async () => {
    const to = cluster.project("filesnew2");
    const q = (text) => cluster.sql("filesnew2", text);
    const work = folder("lastgood-rebuild-files-work-");
    const run = (options) =>
      rebuildFiles({ archive: fixture.archive, dumpPath: fixture.dump, databaseTo: to, filesTo: options.url, key: options.key ?? KEY, work, say: () => {}, sleep: async () => {}, pgRestore: path.join(PG.bin, "pg_restore"), psql: path.join(PG.bin, "psql") });

    const empty = await fakeStorage({ key: KEY, sql: q });
    try {
      await assert.rejects(run({ url: empty.url }), /has no bucket called attachments, avatars, so nothing was uploaded\./);
      await assert.rejects(run({ url: empty.url, key: "sb_secret_wrong" }), /refused the key in LASTGOOD_SUPABASE_SECRET_KEY when listing the buckets/);
    } finally {
      await empty.close();
    }

    q("INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', false), ('avatars', 'avatars', true)");
    const small = await fakeStorage({ key: KEY, sql: q, limit: 9 });
    try {
      await assert.rejects(run({ url: small.url }), (error) => {
        assert.match(error.message, /Not every file went in: 1 file larger than the new project takes \(attachments\/ada\/notes\.txt \(10 bytes\)\)\./);
        assert.match(error.hint, /run this again with --skip database\. Files already uploaded are kept/);
        return true;
      });
      assert.equal(small.files.size, 3, "the files that fit are kept for the next run");
    } finally {
      await small.close();
    }

    // Supabase echoing the key back in a refusal never puts it in a message.
    q("DELETE FROM storage.objects");
    const echo = await fakeStorage({
      key: KEY,
      sql: q,
      refuse: (request, parts) => (request.method === "POST" && parts[0] === "object" && parts[1] !== "list" ? { status: 422, body: { statusCode: "422", message: `bad request with ${request.headers.authorization}` } } : null),
    });
    try {
      await assert.rejects(run({ url: echo.url }), (error) => {
        assert.match(error.message, /Supabase did not take/);
        assert.doesNotMatch(`${error.message} ${error.hint}`, /rebuild-test-key/);
        return true;
      });
    } finally {
      await echo.close();
    }
  });
});
