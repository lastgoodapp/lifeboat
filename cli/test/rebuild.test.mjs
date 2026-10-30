import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { clean, rebuildRestoreList, sortRestoreErrors, SUPABASE_SCHEMAS, tocEntry } from "../lib/rebuild-list.mjs";
import { CALL_TIMEOUT_MS, connection, duration, githubIsPublic, githubRepository, holds, noAnswer, openCopy, outsideName, readTarget, rebuildCode, rebuildDatabase, run, runSteps, shownGitUrl, StepError, takeOutLoginAfterFailure, timeLimit, todoList, todoMarkdown, withWorkFolder } from "../lib/rebuild.mjs";
import { CHUNK, checkSecretKey, copyBlock, copyRow, decodeCopyField, fileMeta, projectRef, rebuildFiles, restoreOwners, storageBase } from "../lib/rebuild-files.mjs";

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

/** Runs `task` with `bin` first on PATH, as the steps run git and psql by name. */
async function withPath(bin, task) {
  const path0 = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${path0}`;
  try {
    return await task();
  } finally {
    process.env.PATH = path0;
  }
}

const STAND_IN = [
  'const fs = require("node:fs");',
  "const args = process.argv.slice(2);",
  'const rules = JSON.parse(fs.readFileSync(`${process.argv[1]}.json`, "utf8"));',
  'const rule = rules.find((candidate) => new RegExp(candidate.match).test(args.join(" ")));',
  "if (!rule) {",
  '  process.stderr.write(`no answer for ${args.join(" ")}\\n`);',
  "  process.exitCode = 1;",
  "} else {",
  '  if (rule.save) fs.copyFileSync(args[args.indexOf(rule.save) + 1], `${process.argv[1]}.saved`);',
  '  process.stdout.write(rule.stdout ?? "");',
  // As pg_restore colours its prefixes when PG_COLOR is always, even into a pipe.
  '  const stderr = rule.stderr ?? "";',
  '  const coloured = stderr.replace(/^pg_restore: (error: )?/gm, (_, error) => `\\x1b[01mpg_restore: \\x1b[0m${error ? "\\x1b[01;31merror: \\x1b[0m" : ""}`);',
  '  process.stderr.write(process.env.PG_COLOR === "always" ? coloured : stderr);',
  "  process.exitCode = rule.code ?? 0;",
  "}",
].join("\n");

/**
 * A stand-in for a program the steps run, such as psql or pg_restore: it answers from the first rule whose `match`
 * fits its arguments, with that rule's `stdout`, `stderr` and exit `code`, and keeps a copy of the file named after
 * the rule's `save` option, at `<program>.saved`. Any other call fails.
 */
function standIn(dir, name, rules) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${STAND_IN}\n`, { mode: 0o755 });
  writeFileSync(`${file}.json`, JSON.stringify(rules));
  return file;
}

const HAS_PG_RESTORE = spawnSync("pg_restore", ["--version"]).status === 0;

/** What pg_restore 16 printed, shortened, when its connection was ended while it made the indexes, after every row was in. */
const LOST_PART_WAY = [
  'pg_restore: creating TABLE "public.notes"',
  'pg_restore: processing data for table "public.notes"',
  'pg_restore: creating INDEX "public.notes_i0"',
  'pg_restore: creating INDEX "public.notes_i1"',
  "pg_restore: error: could not execute query: FATAL:  terminating connection due to administrator command",
  "Command was: CREATE INDEX notes_i1 ON public.notes USING btree (((body || '1'::text)));",
  'pg_restore: creating INDEX "public.notes_i2"',
  "pg_restore: error: could not execute query: no connection to the server",
  "Command was: CREATE INDEX notes_i2 ON public.notes USING btree (((body || '2'::text)));",
  'pg_restore: creating ROW SECURITY "public.notes"',
  "pg_restore: error: could not execute query: no connection to the server",
  "Command was: ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;",
  'pg_restore: creating POLICY "public.notes own"',
  "pg_restore: error: could not execute query: no connection to the server",
  "Command was: CREATE POLICY own ON public.notes USING ((owner IS NOT NULL));",
  "pg_restore: warning: errors ignored on restore: 4",
].join("\n");

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

  it("comments out an extension the new project lacks or already has, and an unknown object in no schema, and names them", () => {
    const toc = [
      "20; 3079 17020 EXTENSION - postgis ",
      "21; 3079 17021 EXTENSION - pgcrypto ",
      "22; 3079 17022 EXTENSION - pg_cron ",
      "23; 2328 17023 FOREIGN DATA WRAPPER - stripe_wrapper postgres",
    ].join("\n");
    const plan = rebuildRestoreList(toc, { installed: ["pgcrypto"], available: ["pg_cron"] });
    assert.deepEqual(plan.kept.map((entry) => entry.id), ["22"]);
    assert.deepEqual(plan.unavailableExtensions, ["postgis"]);
    assert.deepEqual(plan.leftOut, ["foreign data wrapper stripe_wrapper"]);
    assert.deepEqual(plan.text.split("\n").map((line) => line.split(";")[0] || ";"), [";", ";", "22", ";"]);
  });

  it("leaves a schema the new project already had as it is, keeps the app's own publication, and keeps pg_restore's comment lines", () => {
    const toc = [
      ";",
      "; Archive created at 2026-10-17 00:00:00 UTC",
      "30; 2615 17030 SCHEMA - billing postgres",
      "31; 1259 17031 TABLE billing invoices postgres",
      "32; 6104 17032 PUBLICATION - app_changes postgres",
      "33; 1259 17033 TABLE public widgets postgres",
    ].join("\n");
    const plan = rebuildRestoreList(toc, { schemas: ["public", "billing"] });
    assert.deepEqual(plan.kept.map((entry) => entry.id), ["32", "33"]);
    assert.equal(
      plan.text,
      [
        ";",
        "; Archive created at 2026-10-17 00:00:00 UTC",
        ";30; 2615 17030 SCHEMA - billing postgres",
        ";31; 1259 17031 TABLE billing invoices postgres",
        "32; 6104 17032 PUBLICATION - app_changes postgres",
        "33; 1259 17033 TABLE public widgets postgres",
      ].join("\n"),
    );
  });

  it("moves the users, identities and buckets rows together, in that order, to where the first of them was", () => {
    const toc = [
      ";",
      "40; 1259 17040 TABLE public widgets postgres",
      "41; 0 17041 TABLE DATA storage buckets supabase_storage_admin",
      "42; 0 17042 TABLE DATA public widgets postgres",
      "43; 0 17043 TABLE DATA auth identities supabase_auth_admin",
      "44; 0 17044 TABLE DATA auth users supabase_auth_admin",
    ].join("\n");
    const plan = rebuildRestoreList(toc, { schemas: ["public", "auth", "storage"] });
    assert.deepEqual(plan.text.split("\n").map((line) => line.split(";")[0]), ["", "40", "44", "43", "41", "42"]);
  });

  it("sorts pg_restore's errors: Supabase's own objects already there, rows that failed, objects to add by hand", () => {
    // As pg_restore 16 to 18 print them with --verbose: the line naming an entry before its first error gives its kind,
    // name and owner without the schema, so a one-word name such as a function's reads like no entry at all.
    const stderr = [
      'pg_restore: creating TRIGGER "storage.objects update_objects_updated_at"',
      "pg_restore: while PROCESSING TOC:",
      "pg_restore: from TOC entry 3871; 2620 17010 TRIGGER objects update_objects_updated_at supabase_storage_admin",
      'pg_restore: error: could not execute query: ERROR:  trigger "update_objects_updated_at" for relation "objects" already exists',
      "Command was: CREATE TRIGGER update_objects_updated_at ...",
      'pg_restore: creating FUNCTION "public.uses_vault()"',
      "pg_restore: from TOC entry 3900; 1255 17011 FUNCTION uses_vault() postgres",
      'pg_restore: error: could not execute query: ERROR:  schema "vault" does not exist',
      'pg_restore: processing data for table "public.profiles"',
      "pg_restore: from TOC entry 4100; 0 17012 TABLE DATA profiles postgres",
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

  it("counts a connection lost part way as a failed restore, never as row-level security and policies to add by hand", () => {
    assert.deepEqual(sortRestoreErrors(LOST_PART_WAY), {
      failed: [
        "index public.notes_i1: FATAL: terminating connection due to administrator command",
        "index public.notes_i2: no connection to the server",
        "row security public.notes: no connection to the server",
        "policy public.notes own: no connection to the server",
      ],
      notRestored: [],
      already: 0,
    });
    // libpq's other words for a connection that has ended, each as the first error after a policy.
    for (const message of [
      "server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally\n\tbefore or while processing the request.",
      "SSL SYSCALL error: EOF detected",
      "SSL connection has been closed unexpectedly",
      "could not receive data from server: Connection reset by peer",
      "could not send data to server: Broken pipe",
      "connection to server was lost",
      "lost synchronization with server: got message type \"a\", length 1",
      "FATAL:  terminating connection due to idle-session timeout",
      "FATAL:  the database system is shutting down",
    ]) {
      const sorted = sortRestoreErrors(`pg_restore: creating POLICY "public.notes own"\npg_restore: error: could not execute query: ${message}`);
      assert.equal(sorted.failed.length, 1, message);
      assert.deepEqual(sorted.notRestored, [], message);
    }
    // An ordinary refusal on a policy is still one to add by hand.
    assert.deepEqual(sortRestoreErrors('pg_restore: creating POLICY "public.notes own"\npg_restore: error: could not execute query: ERROR:  function auth.uid() does not exist').notRestored, [
      "policy public.notes own: function auth.uid() does not exist",
    ]);
  });

  it("names an error that comes before any object by its message alone, as when pg_restore cannot connect", () => {
    const stderr = 'pg_restore: error: connection to server at "db.example.co" (192.0.2.1), port 5432 failed: FATAL:  password authentication failed for user "postgres"';
    assert.deepEqual(sortRestoreErrors(stderr), {
      failed: ['connection to server at "db.example.co" (192.0.2.1), port 5432 failed: FATAL: password authentication failed for user "postgres"'],
      notRestored: [],
      already: 0,
    });
  });

  it("never prints a connection string or password from a message", () => {
    assert.equal(clean('could not connect to postgresql://postgres:hunter2@db.example.co:5432/postgres password=hunter2'), "could not connect to postgresql://… password=…");
  });
});

describe("the steps", () => {
  it("says how to leave out a step that refuses to run twice, once it finished before a later one failed", async () => {
    const out = [];
    const again = "add --skip database: the database is back";
    const fail = async () => {
      throw new StepError("Not every file went in.", "Raise the limit, then run this again.");
    };
    await runSteps(
      [
        { name: "Code", run: async () => "pushed" },
        { name: "Database", again, run: async () => "restored" },
        { name: "Files", run: fail },
      ],
      (text) => out.push(text),
      () => 0,
    );
    assert.match(out.join(""), /\nRaise the limit, then run this again\.\n\nWhen you run it again, add --skip database: the database is back\.\n/);

    for (const [label, steps] of [
      ["all done", [{ name: "Database", again, run: async () => "restored" }]],
      ["skipped", [{ name: "Database", again, skip: "you said an earlier run restored it", run: async () => "restored" }, { name: "Files", run: fail }]],
      ["it failed itself", [{ name: "Database", again, run: fail }]],
      ["failed before it", [{ name: "Code", run: fail }, { name: "Database", again, run: async () => "restored" }]],
    ]) {
      const quiet = [];
      await runSteps(steps, (text) => quiet.push(text), () => 0);
      assert.doesNotMatch(quiet.join(""), /When you run it again/, label);
    }
  });

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
    assert.equal(
      text.slice(text.indexOf("\nRebuild summary\n"), text.indexOf("  Total")),
      [
        "",
        "Rebuild summary",
        "  Open the copies  done            2 s  code and database",
        "  Code             failed   1 min 15 s  git could not push to https://github.com/acme/notes.git: denied",
        "  Database         not run              not run, because Code failed",
        "",
      ].join("\n"),
      "every step's status, time and note start in the same column, set by the longest step name",
    );
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
    assert.equal(
      markdown,
      [
        "# Still to do by hand",
        "",
        "From lastgood rebuild, 2026-10-24T08:00:00.000Z. Names only: no value, key or password is in this file.",
        "",
        "## Code",
        "",
        "1. Set the default branch to main.",
        "",
        "## Edge Functions and settings",
        "",
        "This step stopped part way, so its list may be short. Run it again once the cause is fixed.",
        "",
        "2. Set these auth settings by hand: smtp_pass.",
        "",
        "## Vercel environment variables",
        "",
        "Not known yet: this step did not run. Run it, and it lists its own.",
        "",
        "## Every rebuild",
        "",
        "3. Point your domain at the new project.",
        "",
      ].join("\n"),
      "one blank line between groups, including after a group with nothing numbered",
    );
    assert.deepEqual(todoList([{ name: "Code", status: "done", todo: [] }], []), [], "nothing to do, no list");
  });

  it("print no by-hand list when nothing is left to do", async () => {
    const out = [];
    const list = [];
    const ok = await runSteps([{ name: "Code", run: async (say) => (say("Pushed 2 branches."), "pushed") }], (text) => out.push(text), () => 0, { list });
    assert.equal(ok, true);
    assert.doesNotMatch(out.join(""), /Still to do by hand/);
    assert.deepEqual(list, []);
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
    // A password pasted in as it is, with a raw %: a sentence that never repeats it, where an escaped one opens.
    assert.throws(
      () => connection("postgresql://postgres.abcdefghijklmnopqrst:Save50%off!@127.0.0.1:5432/postgres"),
      (error) =>
        error instanceof StepError &&
        error.message === "The password in the database address has a % the address cannot carry as it is. Write each % in the password as %25, then run this again.",
    );
    assert.equal(connection("postgresql://postgres.abcdefghijklmnopqrst:Save50%25off!@127.0.0.1:5432/postgres").env.PGPASSWORD, "Save50%off!");
    assert.equal(duration(59_400), "59 s");
    assert.equal(duration(60_000), "1 min 0 s");
  });

  it("asks GitHub, without a token, whether a repository is public", async () => {
    const answer = (status) => async () => ({ status });
    assert.equal(await githubIsPublic("acme/notes", answer(200)), true);
    assert.equal(await githubIsPublic("acme/notes", answer(404)), false);
    assert.equal(await githubIsPublic("acme/notes", answer(403)), null);
  });

  it("show a step that returns no note with an empty note, and an unexpected error by its message alone", async () => {
    const summary = async (step) => {
      const out = [];
      await runSteps([step], (text) => out.push(text), () => 0);
      return out.join("");
    };
    const quiet = await summary({ name: "Code", run: async () => {} });
    assert.match(quiet, /\n {2}Code {2}done {12}0 s {2}\n/);
    assert.doesNotMatch(quiet, /undefined/);
    const thrown = await summary({ name: "Files", run: async () => Promise.reject(new TypeError("fetch failed")) });
    assert.match(thrown, /\nFiles: failed after 0 s\. unexpected error: fetch failed\n/);
    // Something thrown that is not an Error is named as it is.
    const odd = await summary({ name: "Files", run: async () => Promise.reject("the disk is full") });
    assert.match(odd, /\nFiles: failed after 0 s\. unexpected error: the disk is full\n/);
  });

  it("run a program, saying when it is not installed and why another could not start", async () => {
    assert.deepEqual(await run("lastgood-no-such-program", ["--version"]), { code: 127, stdout: "", stderr: "lastgood-no-such-program is not installed." });
    const plain = path.join(folder("lastgood-rebuild-run-"), "not-a-program");
    writeFileSync(plain, "echo hi\n", { mode: 0o644 });
    const refused = await run(plain, []);
    assert.equal(refused.code, 127);
    assert.match(refused.stderr, /EACCES/);
    assert.doesNotMatch(refused.stderr, /not installed/);
    const killed = await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    assert.equal(killed.code, 1, "a program stopped by a signal has failed");
  });

  it("run a program and read its output whole, even a character the pipe splits in two", async () => {
    // 商 is three bytes in UTF-8: the program sends the first, waits, then the other two, on each stream.
    const split = [
      "-e",
      "for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0xe5])); setTimeout(() => { for (const s of [process.stdout, process.stderr]) s.write(Buffer.from([0x95, 0x86, 0x0a])); }, 100)",
    ];
    const result = await run(process.execPath, split);
    assert.equal(result.stdout, "商\n");
    assert.equal(result.stderr, "商\n");
  });

  it("run a program with nothing on its standard input, unless it may ask the customer something", async () => {
    const probe = ["-e", "const { fstatSync } = require('node:fs'); const s = fstatSync(0); process.stdout.write(`${s.dev}:${s.ino}`)"];
    const nothing = statSync("/dev/null");
    assert.equal((await run(process.execPath, probe)).stdout, `${nothing.dev}:${nothing.ino}`);
    const own = fstatSync(0);
    assert.equal((await run(process.execPath, probe, { interactive: true })).stdout, `${own.dev}:${own.ino}`, "git can ask for a login on this one");
  });

  it("name the copy's own option when its SHA-256 is missing or not one, as rebuild has one per copy", async () => {
    const dir = folder("lastgood-rebuild-flag-");
    const { keyFile, seal } = await keyed(dir);
    writeFileSync(path.join(dir, "db.backup"), "PGDMP\n");
    const copy = await seal(path.join(dir, "db.backup"), path.join(dir, "acme-notes-database-20261017T000000Z.backup.age"));
    const key = readFileSync(keyFile, "utf8").trim().split("\n").at(-1);
    const open = (more) => openCopy({ copy, key, work: folder("lastgood-rebuild-work-"), name: "database.backup", say: () => {}, flag: "--database-sha256", ...more });
    await assert.rejects(open({}), (error) => error.message.startsWith("Give the SHA-256 your backup recorded for this copy with --database-sha256. "));
    await assert.rejects(open({ sha256: "not-a-sha" }), { message: "--database-sha256 must be the 64-character SHA-256 from your download email or your login." });
    // The command passes each copy's own option.
    const to = "postgresql://postgres.abcdefghijklmnopqrst:pw@127.0.0.1:5432/postgres";
    const database = await cli(["rebuild", "--key", keyFile, "--database", copy, "--database-to", to]);
    assert.equal(database.status, 1);
    assert.match(database.stdout, /Open the copies: failed after 0 s\. Give the SHA-256 your backup recorded for this copy with --database-sha256\. /);
    const code = await cli(["rebuild", "--key", keyFile, "--code", copy, "--code-to", "https://github.com/acme/notes-new.git", "--code-sha256", "abc"]);
    assert.match(code.stdout, /Open the copies: failed after 0 s\. --code-sha256 must be the 64-character SHA-256/);
  });

  it("say in a sentence when the folder for the opened copies can't be made, and stop before any step", async () => {
    const dir = folder("lastgood-rebuild-tmp-");
    const { keyFile, seal } = await keyed(dir);
    writeFileSync(path.join(dir, "db.backup"), "PGDMP\n");
    const copy = await seal(path.join(dir, "db.backup"), path.join(dir, "acme-notes-database-20261017T000000Z.backup.age"));
    const gone = path.join(dir, "gone");
    const result = await cli(["rebuild", "--key", keyFile, "--unchecked", "--database", copy, "--database-to", "postgresql://postgres.abcdefghijklmnopqrst:pw@127.0.0.1:5432/postgres"], {
      TMPDIR: gone,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `A private folder for the opened copies could not be made in ${gone} (ENOENT). Set TMPDIR to a folder that exists, on a disk with room for the copies, then run this again.\n`);
    assert.equal(result.stdout, "");
  });

  it("remove the folder of opened copies when the command is stopped, by Ctrl-C, a closed terminal or kill", async () => {
    const lib = pathToFileURL(path.join(HERE, "..", "lib", "rebuild.mjs")).href;
    for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"]) {
      const script = [
        `import { withWorkFolder } from ${JSON.stringify(lib)};`,
        'import { writeFileSync } from "node:fs";',
        "await withWorkFolder(async (work) => {",
        '  writeFileSync(`${work}/database.backup`, "opened");',
        '  process.stdout.write(`${work}\\n`);',
        "  await new Promise(() => setInterval(() => {}, 1000));",
        "});",
      ].join("\n");
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TMPDIR: folder("lastgood-rebuild-stop-") }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      const work = await new Promise((resolve) =>
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (stdout.endsWith("\n")) resolve(stdout.trim());
        }),
      );
      assert.ok(existsSync(path.join(work, "database.backup")));
      const ended = new Promise((resolve) => child.on("close", (code, stopped) => resolve({ code, stopped })));
      child.kill(signal);
      assert.deepEqual(await ended, { code: null, stopped: signal });
      assert.equal(existsSync(work), false, `${signal} removes ${work}`);
    }
  });

  it("stop watching for Ctrl-C once the opened copies are gone, so a later one stops the command as usual", async () => {
    const before = process.listenerCount("SIGINT");
    let during = 0;
    await withWorkFolder(async () => {
      during = process.listenerCount("SIGINT");
    });
    assert.equal(during, before + 1);
    assert.equal(process.listenerCount("SIGINT"), before);
  });

  it("say when a copy was opened without a check, with its SHA-256", async () => {
    const dir = folder("lastgood-rebuild-open-");
    const { keyFile, seal } = await keyed(dir);
    writeFileSync(path.join(dir, "notes.txt"), "notes\n");
    const copy = await seal(path.join(dir, "notes.txt"), path.join(dir, "acme-notes-repo-20261017T000000Z.tar.gz.age"));
    const key = readFileSync(keyFile, "utf8").trim().split("\n").at(-1);
    const said = [];
    const out = await openCopy({ copy, key, unchecked: true, work: folder("lastgood-rebuild-work-"), name: "code.tar.gz", say: (line) => said.push(line) });
    assert.deepEqual(said, [`acme-notes-repo-20261017T000000Z.tar.gz.age opened without a check. Its SHA-256 is ${sha(copy)}.`]);
    assert.equal(readFileSync(out, "utf8"), "notes\n");
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
  it("pushes every branch and tag to an empty repository, keeps them on a rerun, and refuses a repository that holds anything else", async () => {
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

    // A rerun after a later step failed: the push is there, so the code step carries on without pushing.
    const again = await cli(["rebuild", "--key", keyFile, "--code", copy, "--code-sha256", sha(copy), "--code-to", target]);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /new\.git already holds the copy's 2 branches and 1 tag at the same commits, from an earlier run, so nothing was pushed\./);
    assert.match(again.stdout, /Code\s+done\s+\d+ s\s+2 branches and 1 tag already there/);
    assert.doesNotMatch(again.stdout, /Pushed /);
    assert.match(again.stdout, /The old default branch was main\./, "the by-hand list is the same");

    // Anything else there, a branch moved on or one more, and nothing is pushed.
    const main = execFileSync("git", ["-C", target, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
    for (const [change, undo] of [
      [["update-ref", "refs/heads/extra", main], ["update-ref", "-d", "refs/heads/extra"]],
      [["update-ref", "refs/heads/main", "refs/heads/agent/fix-login"], ["update-ref", "refs/heads/main", main]],
      [["update-ref", "-d", "refs/tags/v1.0.0"], null],
    ]) {
      execFileSync("git", ["-C", target, ...change]);
      const refused = await cli(["rebuild", "--key", keyFile, "--code", copy, "--code-sha256", sha(copy), "--code-to", target]);
      assert.equal(refused.status, 1, change.join(" "));
      assert.match(refused.stdout, /is not empty, so nothing was pushed\. Rebuild pushes only into a new, empty repository/, change.join(" "));
      if (undo) execFileSync("git", ["-C", target, ...undo]);
    }
    assert.deepEqual(execFileSync("git", ["-C", target, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim().split("\n").sort(), ["refs/heads/agent/fix-login", "refs/heads/main"], "nothing was pushed back");
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

  it("checks where a private repository's code goes: on GitHub it asks, and elsewhere it says to check", async () => {
    const dir = folder("lastgood-rebuild-private-");
    const archive = codeArchive(dir, { repository: { name: "notes", private: true, default_branch: "main" } });
    // git reads a GitHub address as a folder here, so the pushes stay on this machine.
    const remotes = folder("lastgood-rebuild-remotes-");
    for (const name of ["private-a", "private-b", "elsewhere"]) execFileSync("git", ["init", "--quiet", "--bare", path.join(remotes, "acme", `${name}.git`)]);
    const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(remotes).href}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" });
    try {
      const push = async (to, status) => {
        const said = [];
        const asked = [];
        const fetchImpl = async (url) => (asked.push(url), { status });
        await rebuildCode({ archive, to, work: folder("lastgood-rebuild-work-"), say: (line) => said.push(line), todo: () => {}, fetchImpl });
        return { said, asked };
      };

      const kept = await push("https://github.com/acme/private-a.git", 404);
      assert.deepEqual(kept.asked, ["https://api.github.com/repos/acme/private-a"]);
      assert.ok(kept.said.includes("Pushed 2 branches and 1 tag to https://github.com/acme/private-a.git."), kept.said.join("\n"));
      assert.equal(kept.said.some((line) => /GitHub could not say|Check the new one is private too/.test(line)), false, "GitHub says it is private, so there is nothing to add");

      const unknown = await push("https://github.com/acme/private-b.git", 403);
      assert.ok(unknown.said.some((line) => line.startsWith("GitHub could not say whether acme/private-b is private.")), unknown.said.join("\n"));
      assert.ok(unknown.said.includes("Pushed 2 branches and 1 tag to https://github.com/acme/private-b.git."));

      const local = await push(path.join(remotes, "acme", "elsewhere.git"), 200);
      assert.deepEqual(local.asked, [], "GitHub is not asked about an address that is not on GitHub");
      assert.ok(local.said.includes("The old repository was private. Check the new one is private too."), local.said.join("\n"));
      assert.equal(local.said.some((line) => /GitHub could not say/.test(line)), false);
    } finally {
      for (const [name, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("says a copy of a repository with no commits has nothing to push", async () => {
    const dir = folder("lastgood-rebuild-empty-");
    const copy = path.join(dir, "copy");
    mkdirSync(path.join(copy, "github"), { recursive: true });
    writeFileSync(path.join(copy, "github", "repository.json"), JSON.stringify({ name: "notes", private: false, default_branch: "main" }));
    const archive = path.join(dir, "code.tar.gz");
    execFileSync("tar", ["-C", copy, "-czf", archive, "."]);
    const target = path.join(dir, "new.git");
    execFileSync("git", ["init", "--quiet", "--bare", target]);
    const said = [];
    assert.equal(await rebuildCode({ archive, to: target, work: folder("lastgood-rebuild-work-"), say: (line) => said.push(line) }), "no commits in the copy");
    assert.deepEqual(said, ["This copy holds no commits, because the repository had none when it was copied. Nothing to push."]);
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

  it("takes the old default branch from the copy when GitHub's record has none, and lets git ask for a login only when it reaches the new repository", async () => {
    const dir = folder("lastgood-rebuild-head-");
    const archive = codeArchive(dir, { repository: { name: "notes", private: false } });
    const target = path.join(dir, "new.git");
    execFileSync("git", ["init", "--quiet", "--bare", target]);
    // A git that notes whether it may prompt for each command, then runs the real one.
    const bin = folder("lastgood-rebuild-git-");
    const log = path.join(bin, "calls.log");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$GIT_TERMINAL_PROMPT $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const todo = [];
    await withPath(bin, () => rebuildCode({ archive, to: target, work: folder("lastgood-rebuild-work-"), say: () => {}, todo: (line) => todo.push(line) }));
    assert.match(todo[0], /^The old default branch was agent\/fix-login\. If GitHub shows another, set it under Settings, then Branches\.$/, "the branch the copy's HEAD names");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const remote = calls.filter((line) => / (ls-remote|push) /.test(line));
    assert.equal(remote.length, 3, calls.join("\n"));
    assert.ok(remote.every((line) => line.startsWith("1 ")), calls.join("\n"));
    assert.ok(calls.filter((line) => !remote.includes(line)).every((line) => line.startsWith("0 ")), calls.join("\n"));
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
        INSERT INTO public.notes VALUES (1, 'hello');
        CREATE TABLE public.orders (id int PRIMARY KEY, buyer uuid REFERENCES auth.users (id));
        INSERT INTO public.orders VALUES (1, '00000000-0000-4000-8000-000000000001');`,
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
      assert.doesNotMatch(result.stdout, /pointed at it/, "a key that does not cascade but holds no row of the login's is no reason to stop, or to say anything");
      assert.match(result.stdout, /\n\s+Database\s+done\s+\d+ s\s+1 user\n/, "nothing to add by hand, so the note says only the users");
      const q = (text) => cluster.sql("fresh2", text);
      assert.equal(q("SELECT string_agg(email, ',') FROM auth.users"), "ada@example.invalid");
      assert.equal(q("SELECT count(*) FROM auth.identities"), "1");
      assert.equal(q("SELECT count(*) FROM pg_policies WHERE policyname LIKE 'lastgood_backup%'"), "0");
      assert.equal(q("SELECT body FROM public.notes"), "hello");
      assert.equal(q("SELECT count(*) FROM public.orders"), "1");
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
      assert.doesNotMatch(result.stdout, /reference cleared/, "a key that cascades is not also named as one cleared");
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

  it("names what a project that is not empty holds, says nothing of a storage login it was not given, and leaves no password behind", async () => {
    const cluster = await startCluster();
    const saved = { path: process.env.PATH, password: process.env.PGPASSWORD };
    try {
      cluster.sql("postgres", "CREATE DATABASE plainold OWNER rebuilder");
      cluster.sqlFile("plainold", path.join(FIXTURE, "fresh-project.sql"));
      cluster.sql(
        "plainold",
        `INSERT INTO auth.users (id, email, encrypted_password, raw_app_meta_data) VALUES ('00000000-0000-4000-8000-000000000001', 'ada@example.invalid', '$2a$10$x', '{}');
        INSERT INTO auth.identities (provider_id, user_id, identity_data, provider)
          SELECT id::text, id, jsonb_build_object('sub', id::text, 'email', email), 'email' FROM auth.users;
        CREATE TABLE public.notes (id int PRIMARY KEY, body text);
        INSERT INTO public.notes VALUES (1, 'hello');`,
      );
      const dir = folder("lastgood-rebuild-plain-");
      const dumpPath = path.join(dir, "old.backup");
      execFileSync(path.join(PG.bin, "pg_dump"), [cluster.admin("plainold"), "--format=custom", "--no-owner", "--no-acl", "--file", dumpPath]);
      const to = cluster.project("fresh5");
      process.env.PATH = `${PG.bin}:${saved.path}`;
      delete process.env.PGPASSWORD;
      const tools = { pgRestore: path.join(PG.bin, "pg_restore"), psql: path.join(PG.bin, "psql") };
      const attempt = (said = []) => rebuildDatabase({ dumpPath, to, work: folder("lastgood-rebuild-work-"), say: (line) => said.push(line), todo: (line) => said.push(line), ...tools });

      cluster.sql("fresh5", "CREATE TABLE public.leftover (id int)");
      await assert.rejects(attempt(), /^Error: 127\.0\.0\.1\/fresh5 is not empty: it has 1 tables and views \(public\.leftover\)\. Nothing was written\./);
      cluster.sql("fresh5", "DROP TABLE public.leftover; INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-000000000002', 'early@example.invalid')");
      await assert.rejects(attempt(), /^Error: 127\.0\.0\.1\/fresh5 is not empty: it has 1 users\. Nothing was written\./);
      cluster.sql("fresh5", "DELETE FROM auth.users");

      const said = [];
      assert.equal(await attempt(said), "1 user");
      assert.equal(said.some((line) => /storage login/.test(line)), false, said.join("\n"));
      assert.equal(process.env.PGPASSWORD, undefined, "the connection's password is not left in this process's environment");
      assert.equal(cluster.sql("fresh5", "SELECT body FROM public.notes"), "hello");

      // A copy holding nothing of Supabase's own: nothing of Supabase's was already there, so nothing is said of it.
      cluster.sql("postgres", "CREATE DATABASE apponly OWNER rebuilder");
      cluster.sql("apponly", "CREATE TABLE public.items (id int PRIMARY KEY); INSERT INTO public.items VALUES (1);");
      const appOnly = path.join(dir, "apponly.backup");
      execFileSync(path.join(PG.bin, "pg_dump"), [cluster.admin("apponly"), "--format=custom", "--no-owner", "--no-acl", "--file", appOnly]);
      const appSaid = [];
      await rebuildDatabase({ dumpPath: appOnly, to: cluster.project("fresh6"), work: folder("lastgood-rebuild-work-"), say: (line) => appSaid.push(line), todo: (line) => appSaid.push(line), ...tools });
      assert.equal(appSaid.some((line) => /already in the new project/.test(line)), false, appSaid.join("\n"));
      assert.equal(cluster.sql("fresh6", "SELECT count(*) FROM public.items"), "1");
    } finally {
      process.env.PATH = saved.path;
      if (saved.password === undefined) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = saved.password;
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

describe("lastgood rebuild: database, with stand-ins for psql and pg_restore", () => {
  const TO = "postgresql://rebuilder@127.0.0.1:5432/fresh";
  const TOC = [
    ";",
    "; Archive created at 2026-10-17 00:00:00 UTC",
    "3001; 1259 17101 TABLE public notes postgres",
    "3002; 0 17102 TABLE DATA public notes postgres",
    "3003; 0 17103 TABLE DATA vault secrets supabase_admin",
    "3004; 0 17104 TABLE DATA auth one_time_tokens supabase_auth_admin",
    "3005; 0 17105 TABLE DATA auth sessions supabase_auth_admin",
    "",
  ].join("\n");
  const CATALOG = { schemas: ["public", "auth", "storage", "vault"], installed: [], available: [], bypassesRls: true, hasUsers: true, hasBuckets: true };
  const copyOf = (table, rows) => `COPY ${table} (id) FROM stdin;\n${rows.map((row) => `${row}\n`).join("")}\\.\n`;

  /** pg_restore and psql for a copy holding TOC and a new project that is empty unless `tables` says otherwise. */
  function tools({ restore = {}, tables = [], notesRestored = "2" } = {}) {
    const bin = folder("lastgood-rebuild-tools-");
    const pgRestore = standIn(bin, "pg_restore", [
      { match: "^--version$", stdout: "pg_restore (PostgreSQL) 17.2\n" },
      { match: "^--list ", stdout: TOC },
      { match: "--use-list", save: "--use-list", ...restore },
      { match: "-n public -t notes ", stdout: copyOf("public.notes", [1, 2]) },
      { match: "-n vault -t secrets ", stdout: copyOf("vault.secrets", [1, 2]) },
      { match: "-n auth -t one_time_tokens ", stdout: copyOf("auth.one_time_tokens", [1]) },
      // Rows that could not all be read: what pg_restore printed before it stopped is not counted.
      { match: "-n auth -t sessions ", stdout: "COPY auth.sessions (id) FROM stdin;\n1\n", stderr: "pg_restore: error: could not read from input file: end of file\n", code: 1 },
    ]);
    const psql = standIn(bin, "psql", [
      { match: "'bypassesRls'", stdout: `${JSON.stringify(CATALOG)}\n` },
      { match: "'tables'", stdout: `${JSON.stringify({ tables, users: 0, buckets: 0 })}\n` },
      { match: "pg_total_relation_size", stdout: "8192\n" },
      { match: 'SELECT count\\(\\*\\) FROM "public"\\."notes"$', stdout: `${notesRestored}\n` },
    ]);
    return { bin, pgRestore, psql };
  }

  function restore({ bin, pgRestore, psql }, said = [], todo = []) {
    const work = folder("lastgood-rebuild-work-");
    return withPath(bin, () => rebuildDatabase({ dumpPath: path.join(bin, "copy.backup"), to: TO, work, say: (line) => said.push(line), todo: (line) => todo.push(line), pgRestore, psql }));
  }

  it("says what Supabase had already and what stays behind, lists only what needs a hand, and gives pg_restore the list as planned", async () => {
    const already = [
      'pg_restore: creating TRIGGER "storage.objects update_objects_updated_at"',
      'pg_restore: error: could not execute query: ERROR:  trigger "update_objects_updated_at" for relation "objects" already exists',
      'pg_restore: creating POLICY "storage.objects Public read"',
      'pg_restore: error: could not execute query: ERROR:  policy "Public read" for table "objects" already exists',
      "pg_restore: warning: errors ignored on restore: 2",
    ].join("\n");
    const stand = tools({ restore: { stderr: already, code: 1 } });
    const said = [];
    const todo = [];
    assert.equal(await restore(stand, said, todo), "restored");
    assert.deepEqual(said, [
      "127.0.0.1/fresh is empty. Restoring into it.",
      "Restored the app's schema and the rows of 1 table.",
      "2 triggers and policies of Supabase's own were already in the new project, as expected.",
      "Left out 1 row of Supabase's auth.one_time_tokens.",
    ]);
    assert.deepEqual(todo, [
      "Left out 2 rows of Supabase's vault.secrets: Vault secrets are sealed to the old project's key. Add them again in the new project.",
      "Grants come back as Supabase's defaults: the copy has none, so any grant the app changed by hand needs setting again.",
    ]);
    assert.equal(readFileSync(`${stand.pgRestore}.saved`, "utf8"), TOC.replace(/^(300[345];)/gm, ";$1"), "Supabase's rows commented out, every other line as it was");
  });

  it("stops, and says to start again in a new project, when the connection is lost after the rows went in", async () => {
    const stand = tools({ restore: { stderr: LOST_PART_WAY, code: 1 } });
    const todo = [];
    await assert.rejects(restore(stand, [], todo), (error) => {
      assert.equal(error.message, "Restoring failed: index public.notes_i1: FATAL: terminating connection due to administrator command (and 3 more).");
      assert.match(error.hint, /^The new project now holds part of the app\. Delete it, make a new empty project/);
      return true;
    });
    assert.deepEqual(todo.filter((line) => line.startsWith("Not restored")), [], "nothing is left to add by hand");
  });

  it("lists a function it could not make for adding by hand, rather than stopping, as pg_restore names it", async () => {
    // pg_restore's own line for the entry gives the function without its schema; the line before it has the schema.
    const stderr = [
      'pg_restore: creating FUNCTION "public.uses_vault()"',
      "pg_restore: while PROCESSING TOC:",
      "pg_restore: from TOC entry 3900; 1255 17011 FUNCTION uses_vault() postgres",
      'pg_restore: error: could not execute query: ERROR:  schema "vault" does not exist',
      "Command was: CREATE FUNCTION public.uses_vault() RETURNS text LANGUAGE sql AS $$ SELECT vault.read() $$;",
      "",
      "",
      "pg_restore: warning: errors ignored on restore: 1",
    ].join("\n");
    const todo = [];
    assert.equal(await restore(tools({ restore: { stderr, code: 1 } }), [], todo), "1 thing to add by hand");
    assert.equal(todo[0], 'Not restored, add it by hand: function public.uses_vault(): schema "vault" does not exist');
  });

  it("reads pg_restore's errors when the customer's PG_COLOR is always, which would colour them even into a pipe", async () => {
    const already = [
      'pg_restore: creating TRIGGER "storage.objects update_objects_updated_at"',
      'pg_restore: error: could not execute query: ERROR:  trigger "update_objects_updated_at" for relation "objects" already exists',
      "pg_restore: warning: errors ignored on restore: 1",
    ].join("\n");
    const colour = process.env.PG_COLOR;
    process.env.PG_COLOR = "always";
    try {
      const said = [];
      assert.equal(await restore(tools({ restore: { stderr: already, code: 1 } }), said), "restored");
      assert.ok(said.includes("1 trigger or policy of Supabase's own was already in the new project, as expected."), said.join("\n"));
    } finally {
      if (colour === undefined) delete process.env.PG_COLOR;
      else process.env.PG_COLOR = colour;
    }
  });

  it("stops on rows that did not go in, naming the first and how many more, and on a pg_restore that failed without an error it names", async () => {
    const rowError = (table, reason) => [`pg_restore: processing data for table "public.${table}"`, `pg_restore: error: COPY failed for table "${table}": ERROR:  ${reason}`];
    const notes = rowError("notes", 'invalid input syntax for type integer: "x"');
    const two = [...notes, ...rowError("tags", 'duplicate key value violates unique constraint "tags_pkey"'), "pg_restore: warning: errors ignored on restore: 2"].join("\n");
    await assert.rejects(restore(tools({ restore: { stderr: two, code: 1 } })), (error) => {
      assert.equal(error.message, 'Restoring failed: table data public.notes: COPY failed for table "notes": ERROR: invalid input syntax for type integer: "x" (and 1 more).');
      assert.match(error.hint, /^The new project now holds part of the app\. Delete it/);
      return true;
    });
    const one = [...notes, "pg_restore: warning: errors ignored on restore: 1"].join("\n");
    await assert.rejects(restore(tools({ restore: { stderr: one, code: 1 } })), { message: 'Restoring failed: table data public.notes: COPY failed for table "notes": ERROR: invalid input syntax for type integer: "x".' });
    await assert.rejects(restore(tools({ restore: { stderr: "pg_restore: [archiver] unexpected end of file\n", code: 1 } })), { message: "pg_restore failed: pg_restore: [archiver] unexpected end of file" });
  });

  it("stops when a table's rows did not all come back, naming the table", async () => {
    await assert.rejects(restore(tools({ notesRestored: "1" })), (error) => {
      assert.equal(error.message, "Row count mismatch for public.notes: restored 1, dump 2.");
      assert.match(error.hint, /the restore did not match the copy/);
      return true;
    });
  });

  it("names the first three tables of a project that is not empty, and how many there are", async () => {
    await assert.rejects(restore(tools({ tables: ["public.a", "public.b", "public.c", "public.d"] })), {
      message: "127.0.0.1/fresh is not empty: it has 4 tables and views (public.a, public.b, public.c, …). Nothing was written. Rebuild restores only into a new, empty Supabase project, so it never writes over data.",
    });
  });

  it("looks for tables in every schema the new project has besides Supabase's, and in public when it has none", async () => {
    const read = (schemas, counts) => {
      const bin = folder("lastgood-rebuild-tools-");
      standIn(bin, "psql", [
        { match: "'bypassesRls'", stdout: `${JSON.stringify({ ...CATALOG, schemas })}\n` },
        // As Postgres answers a query with an empty list.
        { match: "IN \\(\\)", stderr: 'ERROR:  syntax error at or near ")"\n', code: 1 },
        ...counts.map(([list, tables]) => ({ match: `IN \\(${list}\\)`, stdout: `${JSON.stringify({ tables, users: 0, buckets: 0 })}\n` })),
      ]);
      return withPath(bin, () => readTarget(connection(TO)));
    };
    const billing = await read(["public", "billing", "auth", "storage", "pg_toast"], [["'public', 'billing'", ["billing.invoices"]], ["'public'", []]]);
    assert.deepEqual([billing.appSchemas, billing.tables], [["public", "billing"], ["billing.invoices"]]);
    const noPublic = await read(["auth", "storage"], [["'public'", []]]);
    assert.deepEqual([noPublic.appSchemas, noPublic.tables], [[], []]);
  });

  it("names the rows that keep LastGood's storage login in, counting them", async () => {
    const bin = folder("lastgood-rebuild-tools-");
    standIn(bin, "psql", [
      { match: "FROM pg_constraint", stdout: '[{"schema": "public", "table": "profiles", "column": "id", "action": "a"}]\n' },
      { match: 'FROM "public"\\."profiles" WHERE "id" IN', stdout: "2\n" },
    ]);
    const todo = [];
    await withPath(bin, () => takeOutLoginAfterFailure(connection(TO), SUPABASE_SCHEMAS, () => {}, (line) => todo.push(line)));
    assert.equal(todo.length, 1);
    assert.match(todo[0], /^LastGood's storage login from the old project is still in the new one, because public\.profiles \(2 rows\) point at it with a foreign key that does not cascade\./);
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
    assert.throws(() => checkSecretKey(undefined), /Set LASTGOOD_SUPABASE_SECRET_KEY/, "as when the variable is not set at all");
    assert.throws(() => checkSecretKey("sb_publishable_abc"), /holds the publishable key/);
    assert.throws(() => checkSecretKey(jwt("anon")), /is not a secret key/);
  });

  it("reads storage.objects rows as pg_dump writes them, and only header-safe types and cache settings", () => {
    assert.equal(decodeCopyField("\\N"), null);
    assert.equal(decodeCopyField("a\\tb\\\\c\\nd\\101"), "a\tb\\c\ndA");
    assert.equal(decodeCopyField("\\x41\\x7e!"), "A~!");
    const block = copyBlock(
      ["SET x = 1;", "COPY storage.objects (id, bucket_id, name, owner, metadata) FROM stdin;", "1\tdocs\ta\\tb.txt\t\\N\t{\"mimetype\": \"text/plain\", \"cacheControl\": \"max-age=60\"}", "\\.", ""].join("\n"),
      "storage.objects",
    );
    assert.deepEqual(block.columns, ["id", "bucket_id", "name", "owner", "metadata"]);
    const row = copyRow(block.columns, block.lines[0]);
    assert.equal(row.name, "a\tb.txt");
    assert.equal(row.owner, null);
    assert.deepEqual(copyRow(["bucket_id", "name", "owner"], "docs\ta.txt"), { bucket_id: "docs", name: "a.txt", owner: null }, "a row short of fields reads the rest as empty");
    assert.deepEqual(fileMeta(row), { type: "text/plain", cache: "max-age=60", maxAge: "60" });
    assert.deepEqual(fileMeta({ metadata: '{"mimetype": "text/plain\\r\\nX-Evil: 1"}' }), { type: "application/octet-stream", cache: null, maxAge: null });
    assert.deepEqual(fileMeta(undefined), { type: "application/octet-stream", cache: null, maxAge: null });
  });

  it("reads the storage.objects block wherever it is in pg_restore's output, and only that block", () => {
    const own = "COPY storage.objects (bucket_id, name) FROM stdin;";
    assert.deepEqual(copyBlock([own, "docs\ta.txt", "\\.", ""].join("\n"), "storage.objects"), { columns: ["bucket_id", "name"], lines: ["docs\ta.txt"] }, "on the first line");
    const after = ["COPY public.notes (id) FROM stdin;", "1", "\\.", own, "docs\tb.txt", "\\.", ""].join("\n");
    assert.deepEqual(copyBlock(after, "storage.objects"), { columns: ["bucket_id", "name"], lines: ["docs\tb.txt"] }, "right after another table's block");
    assert.equal(copyBlock("COPY storage.objects (bucket_id, name) FROM '/tmp/rows';\n", "storage.objects"), null, "only a block read from stdin");
    assert.deepEqual(copyBlock([own, "docs\tc.txt", "docs\td.txt"].join("\n"), "storage.objects"), { columns: ["bucket_id", "name"], lines: ["docs\tc.txt", "docs\td.txt"] }, "to the end, when the block has no end mark");
  });

  it("refuses a files copy with anything but a folder per bucket at its top, before any call", async () => {
    const dir = folder("lastgood-rebuild-stray-");
    const copy = path.join(dir, "copy");
    mkdirSync(path.join(copy, "attachments"), { recursive: true });
    writeFileSync(path.join(copy, "attachments", "a.txt"), "a\n");
    writeFileSync(path.join(copy, "stray.txt"), "not a bucket\n");
    const archive = path.join(dir, "files.tar");
    execFileSync("tar", ["-C", copy, "-cf", archive, "."]);
    await assert.rejects(
      rebuildFiles({ archive, dumpPath: "unused", databaseTo: "postgresql://u@127.0.0.1/x", filesTo: "http://127.0.0.1:9", key: "sb_secret_x", work: folder("lastgood-rebuild-work-"), say: () => {} }),
      /The files copy holds something other than one folder per bucket, which a LastGood backup never writes\. It was not used\.$/,
    );
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
 * storage.objects row with no owner, as an upload with the secret key does. An upload that does not say x-upsert: false is
 * refused, so rebuild is seen asking never to write over a file. With `cutFirstPart`, the first part of each resumable
 * upload is kept but answered with a 500, as when the connection drops after Supabase stored it. With `shortFirstPart`,
 * only that many bytes of each resumable upload's first part are kept, and the answer says so; with `noOffset`, a part
 * is answered without saying how much of the file is kept.
 */
async function fakeStorage({ key, sql, limit = Infinity, refuse = () => null, cutFirstPart = false, shortFirstPart = 0, noOffset = false }) {
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
    if (refused) return send(refused.status, refused.body, refused.headers);
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
      if (request.headers["x-upsert"] !== "false") return send(400, { statusCode: "400", error: "upsert", message: "Uploads must not write over a file" });
      const [bucket, ...rest] = parts.slice(1);
      if (files.has(`${bucket}/${rest.join("/")}`)) return send(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      if (body.length > limit) return send(400, { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" });
      stats.standard += 1;
      keep(bucket, rest.join("/"), body, request.headers["content-type"], request.headers["cache-control"] ?? "no-cache");
      return send(200, { Key: `${bucket}/${rest.join("/")}` });
    }
    if (area === "upload" && action === "resumable" && parts.length === 2 && request.method === "POST") {
      if (request.headers["x-upsert"] !== "false") return send(400, { statusCode: "400", error: "upsert", message: "Uploads must not write over a file" });
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
      const part = shortFirstPart && upload.received.length === 0 ? body.subarray(0, shortFirstPart) : body;
      upload.received.push(part);
      if (cutFirstPart && !upload.cut) {
        upload.cut = true;
        return send(500, { statusCode: "500", error: "internal", message: "The connection was cut" });
      }
      const now = offset + part.length;
      if (now === upload.length) {
        stats.resumable += 1;
        keep(upload.meta.bucketName, upload.meta.objectName, Buffer.concat(upload.received), upload.meta.contentType, upload.meta.cacheControl ? `max-age=${upload.meta.cacheControl}` : "no-cache");
      }
      return send(204, undefined, noOffset ? {} : { "Upload-Offset": String(now) });
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

  it("says to add --skip database when the files step stops after the database went back in the same run", async () => {
    const to = cluster.project("filesrerun");
    const storage = await fakeStorage({ key: KEY, sql: (text) => cluster.sql("filesrerun", text), limit: 9 });
    try {
      const env = { PATH: `${PG.bin}:${process.env.PATH}`, LASTGOOD_DATABASE_TO: to, LASTGOOD_SUPABASE_SECRET_KEY: KEY };
      const args = ["rebuild", "--key", fixture.keyFile, "--unchecked", "--database", fixture.database, "--files", fixture.files, "--files-to", storage.url];
      const first = await cli(args, env);
      assert.equal(first.status, 1, first.stdout + first.stderr);
      assert.match(first.stdout, /Database\s+done/);
      assert.match(first.stdout, /\nRaise the new project's upload size limit .* then run this again\. Files already uploaded are kept and not sent again\.\n\nWhen you run it again, add --skip database: the database is back, and the step refuses a project that is not empty\.\n/);
      const again = await cli([...args, "--skip", "database"], env);
      assert.equal(again.status, 1, "the file is still too large");
      assert.doesNotMatch(again.stdout, /When you run it again/, "the command already leaves the database out");
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
        assert.match(error.hint, /run this again\. Files already uploaded are kept/);
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

  it("names files the database copy has no record of, and says once when it has no file records at all", { timeout: 120_000 }, async () => {
    const dir = folder("lastgood-rebuild-unrecorded-");
    const tree = path.join(dir, "tree");
    mkdirSync(tree);
    execFileSync("tar", ["-xf", fixture.archive, "-C", tree]);
    writeFileSync(path.join(tree, "attachments", "added-after.txt"), "late\n");
    const extraArchive = path.join(dir, "files.tar");
    execFileSync("tar", ["-C", tree, "-cf", extraArchive, "."]);
    const emptyDump = path.join(dir, "empty.backup");
    execFileSync(path.join(PG.bin, "pg_dump"), [cluster.admin("postgres"), "--format=custom", "--no-owner", "--no-acl", "--file", emptyDump]);

    const runIn = async (database, archive, dumpPath) => {
      const to = cluster.project(database);
      cluster.sql(database, "INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', false), ('avatars', 'avatars', true)");
      const storage = await fakeStorage({ key: KEY, sql: (text) => cluster.sql(database, text) });
      const todo = [];
      try {
        await rebuildFiles({ archive, dumpPath, databaseTo: to, filesTo: storage.url, key: KEY, work: folder("lastgood-rebuild-files-work-"), say: () => {}, todo: (line) => todo.push(line), sleep: async () => {}, pgRestore: path.join(PG.bin, "pg_restore"), psql: path.join(PG.bin, "psql") });
        return { todo, files: storage.files };
      } finally {
        await storage.close();
      }
    };

    const extra = await runIn("filesnew5", extraArchive, fixture.dump);
    assert.deepEqual(extra.todo, ["1 file in the files copy has no record in the database copy, most likely added between the two, so it goes up as application/octet-stream, with no owner."]);
    assert.equal(extra.files.get("attachments/added-after.txt").type, "application/octet-stream");
    assert.equal(extra.files.get("attachments/ada/notes.txt").type, "text/plain", "the recorded files keep their types");

    const bare = await runIn("filesnew6", fixture.archive, emptyDump);
    assert.deepEqual(bare.todo, ["The database copy has no records of the files, so each goes up as application/octet-stream, with no owner. Set their types and owners by hand if the app relies on them."]);
    assert.equal(bare.files.get("attachments/ada/notes.txt").type, "application/octet-stream");
  });

  it("waits out a rate limit, goes on with a large file from where Supabase got to, and stops on one that does not move", { timeout: 120_000 }, async () => {
    const runIn = (database, url, waits = []) => {
      const to = cluster.project(database);
      cluster.sql(database, "INSERT INTO storage.buckets (id, name, public) VALUES ('attachments', 'attachments', false), ('avatars', 'avatars', true)");
      return rebuildFiles({ archive: fixture.archive, dumpPath: fixture.dump, databaseTo: to, filesTo: url, key: KEY, work: folder("lastgood-rebuild-files-work-"), say: () => {}, sleep: async (ms) => waits.push(ms), pgRestore: path.join(PG.bin, "pg_restore"), psql: path.join(PG.bin, "psql") });
    };

    let bucketCalls = 0;
    const flaky = await fakeStorage({
      key: KEY,
      sql: (text) => cluster.sql("filesnew3", text),
      cutFirstPart: true,
      refuse: (request, parts) =>
        parts[0] === "bucket" && (bucketCalls += 1) === 1 ? { status: 429, body: { statusCode: "429", error: "too_many_requests", message: "Slow down" }, headers: { "Retry-After": "3600" } } : null,
    });
    try {
      const waits = [];
      await runIn("filesnew3", flaky.url, waits);
      assert.equal(bucketCalls, 2, "the bucket list is asked again after the rate limit");
      assert.ok(waits.length >= 2, "a wait before each retry");
      assert.equal(waits[0], 60_000, "a Retry-After of an hour waits a minute");
      assert.ok(flaky.files.get("avatars/big.bin").body.equals(fixture.big), "the large file is whole after its first part was cut off");
      assert.equal(flaky.stats.resumable, 1);
    } finally {
      await flaky.close();
    }

    const stuck = await fakeStorage({
      key: KEY,
      sql: (text) => cluster.sql("filesnew4", text),
      refuse: (request) => (request.method === "PATCH" ? { status: 409, body: { statusCode: "409", error: "Conflict", message: "Offset mismatch" } } : null),
    });
    try {
      // A 409 counts as another upload having put the file there first, so the size check after the uploads names it.
      await assert.rejects(runIn("filesnew4", stuck.url), /does not hold 1 file at the size it was saved \(avatars\/big\.bin\)\./);
      assert.equal(stuck.files.has("avatars/big.bin"), false);
      assert.equal(stuck.files.size, 3, "the files that went in are kept for the next run");
    } finally {
      await stuck.close();
    }
  });
});

describe("lastgood rebuild: files, against a stand-in Storage API", () => {
  const KEY = "sb_secret_stand-in-key";
  const DATABASE = "postgresql://rebuilder@127.0.0.1:5432/fresh";
  const NO_RECORDS = "The database copy has no records of the files, so each goes up as application/octet-stream, with no owner. Set their types and owners by hand if the app relies on them.";
  const ADA = "00000000-0000-4000-8000-000000000001";
  const BOB = "00000000-0000-4000-8000-000000000002";
  const BIG = Buffer.alloc(CHUNK + 100, 7);
  /** The new project's buckets, answered without a database; the row an upload adds is kept nowhere. */
  const buckets = (text) => (text.startsWith("SELECT") ? JSON.stringify(["attachments", "avatars"].map((id) => ({ id, name: id }))) : "");

  /** A files copy as the backup's storage copy saves it, `<bucket>/<path>`, from `{ path: contents }`. */
  function filesCopy(files) {
    const dir = folder("lastgood-rebuild-files-copy-");
    const tree = path.join(dir, "tree");
    mkdirSync(path.join(tree, "attachments"), { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
      writeFileSync(path.join(tree, name), body);
    }
    const archive = path.join(dir, "files.tar");
    execFileSync("tar", ["-C", tree, "-cf", archive, "."]);
    return archive;
  }

  /**
   * The files step against a stand-in Storage API made with `storage`'s options and set up by `before`, with a
   * pg_restore that reads the copy and finds no file records unless one is given. Gives back the stand-in and what the step returned
   * or threw.
   */
  async function upload(archive, { storage: storageOptions = {}, before = () => {}, ...options } = {}) {
    const storage = await fakeStorage({ key: KEY, sql: buckets, ...storageOptions });
    try {
      before(storage);
      const work = folder("lastgood-rebuild-files-work-");
      const result = await rebuildFiles({ archive, dumpPath: "unused", databaseTo: DATABASE, filesTo: storage.url, key: KEY, work, say: () => {}, sleep: async () => {}, pgRestore: "true", psql: "false", ...options }).catch((error) => error);
      return { storage, result, host: new URL(storage.url).host };
    } finally {
      await storage.close();
    }
  }

  it("has nothing to upload from a copy with no files", async () => {
    const said = [];
    const { result } = await upload(filesCopy({}), { say: (line) => said.push(line) });
    assert.equal(result, "no files in the copy");
    assert.deepEqual(said, ["The copy holds 0 files (0 bytes) in 1 bucket."]);
  });

  it("stops on files already there at another size, naming them in order", async () => {
    const archive = filesCopy({ "attachments/a/x": "x\n", "attachments/a.txt": "a\n", "attachments/b.txt": "b\n", "attachments/c.txt": "c\n" });
    const before = (storage) => {
      for (const name of ["a/x", "a.txt", "b.txt", "c.txt"]) storage.files.set(`attachments/${name}`, { body: Buffer.from("changed\n"), type: "text/plain", cache: "no-cache" });
    };
    const { storage, result } = await upload(archive, { before });
    assert.ok(result instanceof StepError);
    assert.match(result.message, /already has 4 files at the same path as the copy but a different size \(attachments\/a\.txt, attachments\/a\/x, attachments\/b\.txt and 1 more\)\. Nothing was uploaded/);
    assert.equal(storage.stats.standard, 0);
  });

  it("keeps a file already there at the same size, and says so", async () => {
    const said = [];
    const todo = [];
    const before = (storage) => storage.files.set("attachments/a.txt", { body: Buffer.from("a\n"), type: "text/plain", cache: "no-cache" });
    const { result, host } = await upload(filesCopy({ "attachments/a.txt": "a\n", "attachments/b.txt": "b\n" }), { before, say: (line) => said.push(line), todo: (line) => todo.push(line) });
    assert.equal(result, "2 files in 1 bucket");
    assert.ok(said.includes(`1 file was already in ${host} at the same size, from an earlier run, and is kept.`), said.join("\n"));
    assert.ok(said.includes("Uploaded 1 file (2 bytes)."), said.join("\n"));
    assert.deepEqual(todo, [NO_RECORDS]);
  });

  it("stops before any upload when pg_restore can't read the database copy, even one that printed rows before it stopped", async () => {
    const pgRestore = standIn(folder("lastgood-rebuild-tools-"), "pg_restore", [
      {
        match: "--data-only",
        stdout: `COPY storage.objects (bucket_id, name, owner, metadata) FROM stdin;\nattachments\ta.txt\t${ADA}\t{"mimetype": "text/plain"}\n`,
        stderr: "pg_restore: error: could not read from input file: end of file\n",
        code: 1,
      },
    ]);
    const todo = [];
    const { storage, result } = await upload(filesCopy({ "attachments/a.txt": "a\n" }), { pgRestore, todo: (line) => todo.push(line) });
    assert.ok(result instanceof StepError);
    assert.equal(result.message, "pg_restore could not read the database copy, so no file was uploaded: pg_restore: error: could not read from input file: end of file");
    assert.match(result.hint, /needs pg_restore from that version or later: install the PostgreSQL client tools, version 17 or newer, then run this again\.$/);
    assert.deepEqual(todo, []);
    assert.equal(storage.files.size, 0);
    // A copy from a newer PostgreSQL than the pg_restore installed, and no pg_restore at all, stop the same way.
    const newer = standIn(folder("lastgood-rebuild-tools-"), "pg_restore", [{ match: "--data-only", stderr: "pg_restore: error: unsupported version (1.16) in file header\n", code: 1 }]);
    const old = await upload(filesCopy({ "attachments/a.txt": "a\n" }), { pgRestore: newer });
    assert.equal(old.result.message, "pg_restore could not read the database copy, so no file was uploaded: pg_restore: error: unsupported version (1.16) in file header");
    assert.equal(old.storage.files.size, 0);
    const missing = await upload(filesCopy({ "attachments/a.txt": "a\n" }), { pgRestore: "lastgood-no-such-pg-restore" });
    assert.equal(missing.result.message, "pg_restore could not read the database copy, so no file was uploaded: lastgood-no-such-pg-restore is not installed.");
  });

  it("names the files whose owner was already set to someone else, and sets no owner from a copy that names none", async () => {
    const tools = folder("lastgood-rebuild-tools-");
    const block = [
      "COPY storage.objects (bucket_id, name, owner, owner_id, metadata) FROM stdin;",
      `attachments\tada/notes.txt\t${ADA}\t${ADA}\t{"mimetype": "text/plain"}`,
      `attachments\tbob/notes.txt\t${BOB}\t${BOB}\t{"mimetype": "text/plain"}`,
      "\\.",
      "",
    ].join("\n");
    const pgRestore = standIn(tools, "pg_restore", [{ match: "--data-only", stdout: block }]);
    const types = '{"bucket_id": "text", "name": "text", "owner": "uuid", "owner_id": "text", "user_metadata": "jsonb", "metadata": "jsonb"}\n';
    const psql = standIn(tools, "psql", [
      { match: "--command", stdout: types },
      { match: "--file", stdout: '0\n{"matched": 0, "differ": ["attachments/ada/notes.txt", "attachments/bob/notes.txt"]}\n' },
    ]);
    const { result, host } = await upload(filesCopy({ "attachments/ada/notes.txt": "hello ada\n", "attachments/bob/notes.txt": "hello bob\n" }), { pgRestore, psql });
    assert.ok(result instanceof StepError);
    assert.equal(result.message, `2 files in ${host} already have an owner other than the database copy's (attachments/ada/notes.txt, attachments/bob/notes.txt), so they were left as they are.`);

    const noOwners = { columns: ["bucket_id", "name", "metadata"], lines: ['attachments\ta.txt\t{"mimetype": "text/plain"}'] };
    const owners = await restoreOwners({ target: connection(DATABASE), block: noOwners, uploaded: new Set(["attachments/a.txt"]), work: folder("lastgood-rebuild-files-work-"), psql });
    assert.deepEqual(owners, { expected: 0, updated: 0, matched: 0, differ: [] });
  });

  it("names why Storage refused a file: too large when it gave no status of its own, or by the error it sent", async () => {
    const refusing = (status, body) => ({ storage: { refuse: (request, parts) => (request.method === "POST" && parts[0] === "object" && parts[1] !== "list" ? { status, body } : null) } });
    const tooLarge = await upload(filesCopy({ "attachments/a.txt": "a\n" }), refusing(413, "Payload Too Large"));
    assert.equal(tooLarge.result.message, "Not every file went in: 1 file larger than the new project takes (attachments/a.txt (2 bytes)).");
    const named = await upload(filesCopy({ "attachments/a.txt": "a\n" }), refusing(422, { statusCode: "422", error: "invalid_mime_type" }));
    assert.equal(named.result.message, "Not every file went in: 1 file Supabase did not take (attachments/a.txt: invalid_mime_type).");
  });

  it("stops when a file read back is not the copy's", async () => {
    const refuse = (request, parts) => (request.method === "GET" && parts[1] === "authenticated" ? { status: 200, body: "other bytes" } : null);
    const { result } = await upload(filesCopy({ "attachments/a.txt": "a\n" }), { storage: { refuse } });
    assert.ok(result instanceof StepError);
    assert.equal(result.message, "A file read back from attachments does not match the copy.");
  });

  it("waits as long as Storage asks before it asks again", async () => {
    const asked = [];
    const slowDown = { status: 429, body: { statusCode: "429", error: "too_many_requests", message: "Slow down" }, headers: { "Retry-After": "0.2" } };
    const refuse = (request, parts) => (parts[0] === "bucket" && asked.push(Date.now()) === 1 ? slowDown : null);
    const { result } = await upload(filesCopy({ "attachments/a.txt": "a\n" }), { storage: { refuse }, sleep: undefined });
    assert.equal(result, "1 file in 1 bucket");
    assert.equal(asked.length, 2);
    assert.ok(asked[1] - asked[0] >= 150, `asked again after ${asked[1] - asked[0]} ms`);
  });

  it("names a large file Supabase would not start, would not say where to send, or refused a part of", async () => {
    const archive = filesCopy({ "attachments/big.bin": BIG });
    const refusing = (method, start, answer) => ({ storage: { refuse: (request, parts) => (request.method === method && parts[0] === "upload" && (parts.length === 2) === start ? answer : null) } });
    const tooLarge = await upload(archive, refusing("POST", true, { status: 413, body: { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" } }));
    assert.equal(tooLarge.result.message, "Not every file went in: 1 file larger than the new project takes (attachments/big.bin (6291556 bytes)).");
    const nowhere = await upload(archive, refusing("POST", true, { status: 201 }));
    assert.equal(nowhere.result.message, "Not every file went in: 1 file Supabase did not take (attachments/big.bin: Supabase did not say where to send the file).");
    const part = await upload(archive, refusing("PATCH", false, { status: 422, body: { statusCode: "422", error: "invalid", message: "The part was refused" } }));
    assert.equal(part.result.message, "Not every file went in: 1 file Supabase did not take (attachments/big.bin: The part was refused).");
  });

  it("goes on with a large file from where Supabase says it got to, or from the end of the part when it does not say", async () => {
    const archive = filesCopy({ "attachments/big.bin": BIG });
    const short = await upload(archive, { storage: { shortFirstPart: 1000 } });
    assert.equal(short.result, "1 file in 1 bucket");
    assert.ok(short.storage.files.get("attachments/big.bin").body.equals(BIG));
    let parts = 0;
    const silent = await upload(archive, { storage: { noOffset: true, refuse: (request) => ((parts += request.method === "PATCH" ? 1 : 0), null) } });
    assert.equal(silent.result, "1 file in 1 bucket");
    assert.ok(silent.storage.files.get("attachments/big.bin").body.equals(BIG));
    assert.equal(parts, 2, "each part sent once");
  });
});

describe("lastgood rebuild: API calls", () => {
  it("gives a call a minute, and a second more for every 64 KiB it sends", () => {
    assert.equal(CALL_TIMEOUT_MS, 60_000);
    assert.equal(timeLimit(), 60_000);
    assert.equal(timeLimit(0), 60_000);
    assert.equal(timeLimit(1), 61_000);
    assert.equal(timeLimit(65_536), 61_000);
    assert.equal(timeLimit(65_537), 62_000);
    assert.equal(timeLimit(20 * 1024 * 1024), 380_000, "a 20 MiB bundle gets about six minutes");
  });

  it("says whether a call ran out of time or never got through", () => {
    const late = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    assert.equal(noAnswer(late, 61_000, "Vercel"), "nothing came back within 61 seconds");
    assert.equal(noAnswer(new TypeError("fetch failed"), 61_000, "Supabase"), "Supabase could not be reached");
    assert.equal(noAnswer(undefined, 60_000, "Vercel"), "Vercel could not be reached");
  });

  it("reads a setting back as set when what is there now holds everything sent, part by part", () => {
    const now = { site_url: "https://notes.example", mailer_otp_exp: 3600, features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: true } }, regions: ["syd1"] };
    assert.equal(holds(now, { site_url: "https://notes.example" }), true);
    assert.equal(holds(now, { features: { imageTransformation: { enabled: true } } }), true, "a part of a nested setting");
    assert.equal(holds(now, { regions: ["syd1"] }), true);
    assert.equal(holds(now, {}), true);
    assert.equal(holds(now, { site_url: "https://other.example" }), false);
    assert.equal(holds(now, { features: { imageTransformation: { enabled: false } } }), false);
    assert.equal(holds(now, { regions: ["syd1", "iad1"] }), false, "a list must match whole");
    assert.equal(holds(now, { regions: [] }), false);
    assert.equal(holds(now, { missing: null }), false, "a setting not there is not one set to null");
    assert.equal(holds({ resourceConfig: null }, { resourceConfig: { fluid: true } }), false);
    assert.equal(holds({ resourceConfig: "fluid" }, { resourceConfig: { fluid: true } }), false);
    assert.equal(holds(null, { site_url: "https://notes.example" }), false);
    assert.equal(holds({ mailer_otp_exp: "3600" }, { mailer_otp_exp: 3600 }), false, "the same value only");
  });
});
