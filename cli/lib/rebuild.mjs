import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { countMetadata } from "./lifeboat/github-metadata.mjs";
import { countCopyRows, STORAGE_LOGIN_EMAIL, verifyAuthUsers, verifySampleCounts } from "./lifeboat/restore-list.mjs";
import { restoreCopy, RestoreError } from "./restore.mjs";
import { clean, rebuildRestoreList, SUPABASE_SCHEMAS, sortRestoreErrors } from "./rebuild-list.mjs";

/**
 * Rebuilding an app from its copies into new accounts, on the customer's own computer (R4). Each step says what it
 * did and how long it took (R5). The copies are opened here with the customer's key, and their contents go only to
 * the repository and the database the customer names. Nothing goes to LastGood.
 *
 * A step never writes over anything: the repository and the database must be new and empty, so a run cannot damage
 * an app that is already there.
 */

export class StepError extends Error {
  /** `hint` says how to carry on, for the summary. */
  constructor(message, hint = "") {
    super(message);
    this.hint = hint;
  }
}

/** Runs a program and gathers what it printed. Never throws on a non-zero exit: the caller reads `code`. */
export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: [options.interactive ? "inherit" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: error.code === "ENOENT" ? `${command} is not installed.` : String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** "4 s", "1 min 12 s". */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * Runs the steps in order, timing each, and prints a summary. A failed step stops the ones after it, which are listed
 * as not run, so the customer knows exactly what is done. A step with `skip` set is one the customer said an earlier
 * run finished; it is listed as skipped with that reason. Returns true when every step that ran finished.
 *
 * Each step gets `say` for its progress and `todo` for what the customer must still do by hand: a todo line is printed
 * where it happens and again in one numbered list after the summary, with `options.always` (what rebuild never does)
 * at the end. The list's entries also go into `options.list`, for a file. Names only: a step never puts a value in one.
 */
export async function runSteps(steps, write = (text) => process.stdout.write(text), now = () => Date.now(), options = {}) {
  const results = [];
  let stopped = null;
  const started = now();
  for (const step of steps) {
    if (step.skip) {
      results.push({ name: step.name, status: "skipped", ms: 0, note: step.skip, todo: [] });
      write(`\n== ${step.name} ==\nSkipped: ${step.skip}.\n`);
      continue;
    }
    if (stopped) {
      results.push({ name: step.name, status: "not run", ms: 0, note: `not run, because ${stopped} failed`, todo: [] });
      continue;
    }
    write(`\n== ${step.name} ==\n`);
    const begin = now();
    const todo = [];
    const say = (line) => write(`${line}\n`);
    try {
      const note = await step.run(say, (line) => {
        todo.push(line);
        say(line);
      });
      const ms = now() - begin;
      results.push({ name: step.name, status: "done", ms, note: note ?? "", todo });
      write(`${step.name}: done in ${duration(ms)}.\n`);
    } catch (error) {
      const ms = now() - begin;
      const message = error instanceof StepError || error instanceof RestoreError ? error.message : `unexpected error: ${clean(error?.message ?? error)}`;
      results.push({ name: step.name, status: "failed", ms, note: message, hint: error?.hint ?? "", todo });
      write(`${step.name}: failed after ${duration(ms)}. ${message}\n`);
      stopped = step.name;
    }
  }
  const total = now() - started;
  const width = Math.max(...results.map((result) => result.name.length));
  write("\nRebuild summary\n");
  for (const result of results) {
    write(`  ${result.name.padEnd(width)}  ${result.status.padEnd(7)}  ${result.status === "not run" || result.status === "skipped" ? "".padStart(10) : duration(result.ms).padStart(10)}  ${result.note}\n`);
  }
  write(`  Total ${duration(total)}.\n`);
  const failure = results.find((result) => result.status === "failed");
  if (failure?.hint) write(`\n${failure.hint}\n`);
  const list = todoList(results, options.always ?? []);
  if (list.length > 0) {
    write("\nStill to do by hand\n");
    let number = 0;
    for (const group of list) {
      write(`  ${group.name}\n`);
      if (group.unknown) write(`     ${group.unknown}\n`);
      for (const item of group.items) write(`  ${String((number += 1)).padStart(2)}. ${item}\n`);
    }
  }
  if (options.list) options.list.push(...list);
  return !failure;
}

/**
 * The by-hand list, grouped by step: what each step that ran named, a word for one that did not run or stopped part
 * way, and `always` last. A step with nothing to add is left out.
 */
export function todoList(results, always) {
  const groups = [];
  for (const result of results) {
    if (result.status === "skipped") continue;
    const unknown =
      result.status === "not run"
        ? "Not known yet: this step did not run. Run it, and it lists its own."
        : result.status === "failed"
          ? "This step stopped part way, so its list may be short. Run it again once the cause is fixed."
          : "";
    if (result.todo.length === 0 && !unknown) continue;
    groups.push({ name: result.name, unknown, items: result.todo });
  }
  if (always.length > 0) groups.push({ name: "Every rebuild", unknown: "", items: always });
  return groups;
}

/** The by-hand list as Markdown, for --todo. */
export function todoMarkdown(list, when = new Date()) {
  const lines = ["# Still to do by hand", "", `From lastgood rebuild, ${when.toISOString()}. Names only: no value, key or password is in this file.`, ""];
  let number = 0;
  for (const group of list) {
    lines.push(`## ${group.name}`, "");
    if (group.unknown) lines.push(group.unknown, "");
    for (const item of group.items) lines.push(`${(number += 1)}. ${item}`);
    if (group.items.length > 0) lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A git URL as it may be printed: with any user name or token taken out. */
export function shownGitUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return String(url).replace(/^[^@/]+@/, "");
  }
}

/** `owner/repo` when the URL is a github.com repository, else null. */
export function githubRepository(url) {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (ssh) return ssh[1];
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Whether GitHub shows `owner/repo` to anyone: an unauthenticated read answers 200 for a public repository and 404
 * for a private one. Null when GitHub could not be asked.
 */
export async function githubIsPublic(repository, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lastgood-cli" },
    });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

async function git(args, options = {}) {
  return run("git", args, { ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: options.interactive ? "1" : "0" } });
}

function refLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("^{}"));
}

/** A name in an archive that would land outside the folder it is opened into: an absolute path, or one with a ".." part. */
export function outsideName(name) {
  return name.startsWith("/") || name.split("/").includes("..");
}

/**
 * Checks an opened copy's archive before anything comes out of it: it must list, hold only plain files and folders
 * (a link could point outside the folder it is opened into), and name nothing outside that folder. tar refuses an
 * absolute or ".." name by default, but the check does not lean on that.
 */
export async function checkArchive(archive, what, { gzip = false } = {}) {
  const listing = await run("tar", [gzip ? "-tvzf" : "-tvf", archive]);
  const names = await run("tar", [gzip ? "-tzf" : "-tf", archive]);
  if (listing.code !== 0 || names.code !== 0) throw new StepError(`The ${what} copy is not a readable archive.`);
  if (listing.stdout.split("\n").some((line) => line && !/^[d-]/.test(line))) {
    throw new StepError(`The ${what} copy holds something other than plain files and folders, which a LastGood backup never writes. It was not used.`);
  }
  const outside = names.stdout.split("\n").filter((name) => name && outsideName(name));
  if (outside.length > 0) {
    throw new StepError(`The ${what} copy names a path outside its own folder (${clean(outside[0])}), which a LastGood backup never writes. It was not used.`);
  }
}

/** Pushes every branch and tag in an opened code copy to an empty repository. */
export async function rebuildCode({ archive, to, work, say, todo = say, fetchImpl = fetch }) {
  // git would read an address starting with "-" as an option, such as --upload-pack, which runs a command.
  if (String(to).startsWith("-")) throw new StepError(`The --code-to address starts with "-", so nothing was pushed. Give the new repository's URL.`);
  const dir = path.join(work, "code");
  await rm(dir, { recursive: true, force: true });
  await checkArchive(archive, "code", { gzip: true });
  await mkdir(dir, { recursive: true });
  const extract = await run("tar", ["-xzf", archive, "-C", dir, "--no-same-owner"]);
  if (extract.code !== 0) throw new StepError("The code copy did not open.");

  let repository = null;
  try {
    repository = JSON.parse(await readFile(path.join(dir, "github", "repository.json"), "utf8"));
  } catch {
    repository = null;
  }
  let metadata = null;
  try {
    metadata = countMetadata(path.join(dir, "github"));
  } catch {
    metadata = null;
  }

  const bundle = path.join(dir, "code.bundle");
  const hasBundle = await stat(bundle).then((info) => info.isFile(), () => false);
  if (!hasBundle) {
    say("This copy holds no commits, because the repository had none when it was copied. Nothing to push.");
    return "no commits in the copy";
  }
  const mirror = path.join(dir, "mirror.git");
  const clone = await git(["clone", "--mirror", "--quiet", bundle, mirror]);
  if (clone.code !== 0) throw new StepError(`The code bundle did not clone: ${clean(clone.stderr)}`);
  const fsck = await git(["-C", mirror, "fsck", "--full", "--no-progress"]);
  if (fsck.code !== 0) throw new StepError("git fsck found damaged objects in the code copy, so it was not pushed.");
  const heads = refLines((await git(["-C", mirror, "for-each-ref", "--format=%(refname)", "refs/heads"])).stdout);
  const tags = refLines((await git(["-C", mirror, "for-each-ref", "--format=%(refname)", "refs/tags"])).stdout);
  const head = (await git(["-C", mirror, "symbolic-ref", "--short", "HEAD"])).stdout.trim();
  const refs = `${counted(heads.length, "branch", "branches")} and ${counted(tags.length, "tag")}`;
  say(`The copy holds ${refs}, and git fsck found no damage.`);

  const shown = shownGitUrl(to);
  const wasPrivate = repository?.private === true || repository?.visibility === "private" || repository?.visibility === "internal";
  const onGithub = githubRepository(to);
  if (wasPrivate && onGithub) {
    const isPublic = await githubIsPublic(onGithub, fetchImpl);
    if (isPublic === true) {
      throw new StepError(
        `${onGithub} is public, and the old repository was private, so the code was not pushed. Make ${onGithub} private on GitHub, then run this again.`,
      );
    }
    if (isPublic === null) {
      say(
        `GitHub could not say whether ${onGithub} is private. Without a login it answers 60 such checks an hour from each internet address, so on a shared network they may be used up. The old repository was private: check the new one is too.`,
      );
    }
  } else if (wasPrivate) {
    say("The old repository was private. Check the new one is private too.");
  }

  const remote = await git(["ls-remote", "--", to], { interactive: true });
  if (remote.code !== 0) throw new StepError(`git could not reach ${shown}: ${clean(remote.stderr)}`, "Check the address, and that this computer can push to it with your own git login.");
  if (refLines(remote.stdout).length > 0) {
    throw new StepError(`${shown} is not empty, so nothing was pushed. Rebuild pushes only into a new, empty repository, so it never writes over code.`);
  }
  const push = await git(["-C", mirror, "push", "--quiet", "--", to, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"], { interactive: true });
  if (push.code !== 0) throw new StepError(`git could not push to ${shown}: ${clean(push.stderr)}`);
  const after = refLines((await git(["ls-remote", "--heads", "--tags", "--", to], { interactive: true })).stdout);
  if (after.length !== heads.length + tags.length) {
    throw new StepError(`${shown} has ${after.length} branches and tags after the push, not the ${heads.length + tags.length} in the copy.`);
  }
  say(`Pushed ${refs} to ${shown}.`);
  const oldDefault = typeof repository?.default_branch === "string" ? repository.default_branch : head.replace(/^refs\/heads\//, "");
  if (oldDefault) todo(`The old default branch was ${oldDefault}. If GitHub shows another, set it under Settings, then Branches.`);
  if (metadata) {
    todo(
      `Issues and pull requests are not recreated: the copy holds ${counted(metadata.issues, "issue")}, ${counted(metadata.pullRequests, "pull request")} and ${counted(metadata.comments, "comment")} as JSON, in its github folder (open it with lastgood restore).`,
    );
  }
  return `${refs} pushed`;
}

/**
 * A connection string for the tools without its password, which goes in PGPASSWORD instead, so it never shows in a
 * process list. `shown` is safe to print.
 */
export function connection(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new StepError("The database address is not a postgresql:// connection string. Copy it from the new project's Connect button in Supabase.");
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new StepError("The database address is not a postgresql:// connection string. Copy it from the new project's Connect button in Supabase.");
  }
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;
  return { url: parsed.toString(), env, shown: `${parsed.hostname}${parsed.pathname}` };
}

async function psqlJson(target, sql) {
  const result = await run("psql", [target.url, "--no-psqlrc", "--tuples-only", "--no-align", "--quiet", "--set", "ON_ERROR_STOP=1", "--command", sql], {
    env: target.env,
  });
  if (result.code !== 0) throw new StepError(`The new database answered: ${clean(result.stderr || "psql failed.")}`);
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : null;
}

/**
 * LastGood's storage login from the old project, out of the new one: its password is in the old repository's secrets.
 * Rows in the app's own tables that point straight at it by a foreign key are counted first, so each one that goes with
 * it (a cascade) or is cleared (set null or default) is named. A key that would refuse the delete stops the step, naming
 * its table, so the login is never left in the new project without a word. `notApp` names the schemas that are not the
 * app's: Supabase's own and any the new project had already.
 */
export async function removeStorageLogin(target, notApp, say) {
  const keys =
    (await psqlJson(
      target,
      `SELECT coalesce(json_agg(json_build_object('schema', n.nspname, 'table', t.relname, 'column', a.attname, 'action', c.confdeltype)), '[]')
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass AND cardinality(c.conkey) = 1
        AND n.nspname NOT IN (${sqlList(notApp)})`,
    )) ?? [];
  const pointing = [];
  for (const key of keys) {
    const count = await psqlJson(
      target,
      `SELECT count(*) FROM ${quoteIdent(key.schema)}.${quoteIdent(key.table)} WHERE ${quoteIdent(key.column)} IN (SELECT id FROM auth.users WHERE email = '${STORAGE_LOGIN_EMAIL}')`,
    );
    if (count > 0) pointing.push({ ...key, rows: count, name: `${key.schema}.${key.table}` });
  }
  const refusing = pointing.filter((key) => key.action === "a" || key.action === "r");
  if (refusing.length > 0) {
    throw new StepError(
      `LastGood's storage login from the old project is still in the new one, because ${refusing.map((key) => `${key.name} (${counted(key.rows, "row")})`).join(", ")} point${refusing.length === 1 && refusing[0].rows === 1 ? "s" : ""} at it with a foreign key that does not cascade. Its password is in the old repository's secrets.`,
      `Delete those rows, then delete the user ${STORAGE_LOGIN_EMAIL} in Supabase under Authentication. The database is otherwise back.`,
    );
  }
  const removed = await psqlJson(
    target,
    `WITH login AS (SELECT id FROM auth.users WHERE email = '${STORAGE_LOGIN_EMAIL}'),
      identities AS (DELETE FROM auth.identities WHERE user_id IN (SELECT id FROM login) RETURNING 1),
      users AS (DELETE FROM auth.users WHERE id IN (SELECT id FROM login) RETURNING 1)
    SELECT json_build_object('users', (SELECT count(*) FROM users), 'identities', (SELECT count(*) FROM identities))`,
  );
  if (!(removed?.users > 0)) return;
  say("LastGood's storage login from the old project was left out. Connecting the new project makes a new one.");
  const went = pointing.filter((key) => key.action === "c").map((key) => `${key.name} (${counted(key.rows, "row")})`);
  const cleared = pointing.filter((key) => key.action === "n" || key.action === "d").map((key) => `${key.name}.${key.column} (${counted(key.rows, "row")})`);
  if (went.length > 0) say(`The app's rows that pointed at it went with it, as their foreign keys cascade: ${went.join(", ")}, and any rows that cascade from those.`);
  if (cleared.length > 0) say(`The app's rows that pointed at it were kept, with the reference cleared: ${cleared.join(", ")}.`);
}

/**
 * After a restore that failed part way: takes the storage login out if it can, and when it cannot, says so as a line
 * to act on rather than letting the restore's own failure hide it.
 */
export async function takeOutLoginAfterFailure(target, notApp, say, todo = say) {
  try {
    await removeStorageLogin(target, notApp, say);
  } catch (error) {
    const reason = error instanceof StepError ? error.message : `LastGood's storage login from the old project could not be taken out (${clean(error?.message ?? error)}).`;
    todo(`${reason.replace(/[.\s]*$/, ".")} Deleting the new project, as the summary says, takes it out too; otherwise delete the user ${STORAGE_LOGIN_EMAIL} in Supabase under Authentication.`);
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqlList(names) {
  return names.map((name) => `'${String(name).replace(/'/g, "''")}'`).join(", ");
}

/** What the new project already has, read before anything is written. */
export async function readTarget(target) {
  const catalog = await psqlJson(
    target,
    `SELECT json_build_object(
      'schemas', (SELECT coalesce(json_agg(nspname), '[]') FROM pg_namespace),
      'installed', (SELECT coalesce(json_agg(extname), '[]') FROM pg_extension),
      'available', (SELECT coalesce(json_agg(name), '[]') FROM pg_available_extensions),
      'bypassesRls', (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
      'hasUsers', to_regclass('auth.users') IS NOT NULL,
      'hasBuckets', to_regclass('storage.buckets') IS NOT NULL)`,
  );
  const appSchemas = catalog.schemas.filter((name) => !SUPABASE_SCHEMAS.includes(name) && !name.startsWith("pg_"));
  // Postgres resolves every table a query names before it runs, so a table the project lacks is left out of the query.
  const counts = await psqlJson(
    target,
    `SELECT json_build_object(
      'tables', (SELECT coalesce(json_agg(n.nspname || '.' || c.relname), '[]') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname IN (${sqlList(appSchemas.length ? appSchemas : ["public"])})),
      'users', ${catalog.hasUsers ? "(SELECT count(*) FROM auth.users)" : "NULL"},
      'buckets', ${catalog.hasBuckets ? "(SELECT count(*) FROM storage.buckets)" : "NULL"})`,
  );
  return { ...catalog, appSchemas, ...counts };
}

/** Rows a table had in the dump, read from the dump itself. */
async function dumpRows(pgRestore, dumpPath, table) {
  const [schema, name] = table.split(".");
  const result = await run(pgRestore, ["-a", "-n", schema, "-t", name, "-f", "-", dumpPath]);
  return result.code === 0 ? countCopyRows(result.stdout) : null;
}

/**
 * Restores an opened database copy into a new, empty Supabase project: the app's schemas as they were dumped, and
 * from Supabase's own schemas only the users, their sign-in identities, the buckets, and the app's triggers and
 * policies on Supabase's tables. Then checks rows and users against the dump.
 */
export async function rebuildDatabase({ dumpPath, to, work, say, todo = say, pgRestore = "pg_restore", psql = "psql" }) {
  const target = connection(to);
  const version = await run(pgRestore, ["--version"]);
  if (version.code !== 0) throw new StepError("pg_restore is not installed. Install the PostgreSQL client tools, version 17 or newer, then run this again.");
  const list = await run(pgRestore, ["--list", dumpPath]);
  if (list.code !== 0) {
    throw new StepError(`pg_restore could not read the database copy: ${clean(list.stderr)}`, `${version.stdout.trim()} is installed. A copy made by a newer PostgreSQL needs pg_restore from that version or later.`);
  }

  const before = await readTarget(target);
  if (before.tables.length > 0 || before.users > 0 || before.buckets > 0) {
    const what = [
      before.tables.length > 0 ? `${before.tables.length} tables and views (${before.tables.slice(0, 3).join(", ")}${before.tables.length > 3 ? ", …" : ""})` : "",
      before.users > 0 ? `${before.users} users` : "",
      before.buckets > 0 ? `${before.buckets} storage buckets` : "",
    ].filter(Boolean);
    throw new StepError(
      `${target.shown} is not empty: it has ${what.join(", ")}. Nothing was written. Rebuild restores only into a new, empty Supabase project, so it never writes over data.`,
    );
  }
  const hasUsers = /^\d+; \d+ \d+ TABLE DATA auth users /m.test(list.stdout);
  if (hasUsers && before.users === null) {
    throw new StepError(`${target.shown} has no Supabase Auth (auth.users), so the app's users have nowhere to go. Nothing was written. Restore into a new Supabase project.`);
  }
  // Supabase turns on row-level security for auth.users, so only a role that bypasses it can put the users back.
  if (!before.bypassesRls && hasUsers) {
    throw new StepError(
      "This connection's role cannot bypass row-level security, which Supabase turns on for auth.users, so the users could not be restored. Nothing was written.",
      "Use the new project's own connection string, for its postgres role, from the Connect button in Supabase.",
    );
  }
  say(`${target.shown} is empty. Restoring into it.`);

  const plan = rebuildRestoreList(list.stdout, before);
  const listPath = path.join(work, "rebuild.list");
  await writeFile(listPath, plan.text.endsWith("\n") ? plan.text : `${plan.text}\n`, { mode: 0o600 });
  // --verbose names each object before pg_restore makes it, so an error can be tied to the object it came from.
  const restore = await run(pgRestore, ["--verbose", "--no-owner", "--no-acl", "--use-list", listPath, "--dbname", target.url, dumpPath], { env: target.env });
  const sorted = sortRestoreErrors(restore.stderr);

  const skipped = { schemas: [...new Set([...SUPABASE_SCHEMAS, ...before.schemas.filter((name) => name !== "public")])] };
  // LastGood's storage login from the old project stays behind: its password is in the old repository's secrets. A
  // restore that failed part way still takes it out before it stops.
  const failure =
    sorted.failed.length > 0
      ? new StepError(
          `Restoring failed: ${sorted.failed[0]}${sorted.failed.length > 1 ? ` (and ${sorted.failed.length - 1} more)` : ""}.`,
          "The new project now holds part of the app. Delete it, make a new empty project, and run this again once the cause is fixed.",
        )
      : restore.code !== 0 && sorted.notRestored.length === 0 && sorted.already === 0
        ? new StepError(`pg_restore failed: ${clean(restore.stderr || "no reason given")}`)
        : null;
  if (failure) {
    if (hasUsers) await takeOutLoginAfterFailure(target, skipped.schemas, say, todo);
    throw failure;
  }
  say(`Restored the app's schema and the rows of ${counted(plan.kept.filter((entry) => entry.desc === "TABLE DATA").length, "table")}.`);
  if (plan.storageLoginPolicies.length > 0) say(`Left out the storage login's policies: ${plan.storageLoginPolicies.join(", ")}.`);

  // Checked against the copy while the login is still there, so a row of the app's that cascades from it (such as its
  // profile) is still counted as the dump counts it. The users check leaves the login out on both sides.
  const toc = list.stdout;
  const verify = { toc, skipped, dumpPath, psql, pgRestore, databaseUrl: target.url };
  const env = process.env.PGPASSWORD;
  if (target.env.PGPASSWORD) process.env.PGPASSWORD = target.env.PGPASSWORD;
  let users = null;
  let mismatch = null;
  try {
    await verifySampleCounts(verify);
    users = await verifyAuthUsers({ ...verify, label: "the new project" });
  } catch (error) {
    mismatch = new StepError(`${clean(error?.message ?? error)}`, "Check the new project before you use it: the restore did not match the copy.");
  } finally {
    if (env === undefined) delete process.env.PGPASSWORD;
    else process.env.PGPASSWORD = env;
  }
  if (hasUsers) await removeStorageLogin(target, skipped.schemas, say);
  if (mismatch) throw mismatch;

  for (const line of sorted.notRestored) todo(`Not restored, add it by hand: ${line}`);
  if (sorted.already > 0) {
    say(`${counted(sorted.already, "trigger or policy", "triggers and policies")} of Supabase's own ${sorted.already === 1 ? "was" : "were"} already in the new project, as expected.`);
  }
  if (plan.unavailableExtensions.length > 0) {
    todo(`Extensions this project does not offer, left out: ${plan.unavailableExtensions.join(", ")}.`);
  }
  if (plan.eventTriggers.length > 0) todo(`Event triggers need a superuser, left out: ${plan.eventTriggers.join(", ")}.`);
  for (const table of plan.supabaseRows) {
    if (QUIET_ROWS.has(table)) continue;
    const rows = await dumpRows(pgRestore, dumpPath, table);
    if (!rows) continue;
    (BY_HAND_ROWS.has(table) ? todo : say)(`Left out ${counted(rows, "row")} of Supabase's ${table}${SUPABASE_ROW_NOTES[table] ? `: ${SUPABASE_ROW_NOTES[table]}` : "."}`);
  }
  todo("Grants come back as Supabase's defaults: the copy has none, so any grant the app changed by hand needs setting again.");
  const notes = [];
  if (users) notes.push(counted(users.users, "user"));
  if (sorted.notRestored.length > 0) notes.push(`${counted(sorted.notRestored.length, "thing")} to add by hand`);
  return notes.join(", ") || "restored";
}

/** Supabase's own bookkeeping, which a new project keeps for itself and the customer need not hear about. */
const QUIET_ROWS = new Set([
  "auth.schema_migrations",
  "auth.audit_log_entries",
  "auth.flow_state",
  "auth.instances",
  "realtime.schema_migrations",
  "realtime.subscription",
  "storage.migrations",
]);

/** "1 table", "6 tables". */
export function counted(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Supabase's rows left out that leave the customer something to do; the rest are only reported. */
const BY_HAND_ROWS = new Set(["auth.mfa_factors", "vault.secrets", "cron.job", "supabase_migrations.schema_migrations"]);

/** Why some of Supabase's rows stay behind, and what that means for the customer. */
const SUPABASE_ROW_NOTES = {
  "storage.objects": "the files themselves are not in the database copy. The files step puts them back from the files copy, with their owners.",
  "auth.sessions": "everyone signs in again on the new project.",
  "auth.refresh_tokens": "everyone signs in again on the new project.",
  "auth.mfa_factors": "users who had a second sign-in step set it up again. Until then they sign in with their password alone.",
  "vault.secrets": "Vault secrets are sealed to the old project's key. Add them again in the new project.",
  "cron.job": "scheduled jobs: add them again with pg_cron in the new project.",
  "supabase_migrations.schema_migrations": "the Supabase CLI's migration history. If you use migrations, mark them applied with supabase migration repair.",
};

/** A private folder for opened copies, removed when `task` finishes, whatever happens. */
export async function withWorkFolder(task) {
  const work = await mkdtemp(path.join(tmpdir(), "lastgood-rebuild-"));
  try {
    return await task(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Opens a copy into the work folder, checked against its recorded SHA-256 unless the customer said not to. */
export async function openCopy({ copy, key, sha256, unchecked, work, name, say }) {
  const out = path.join(work, name);
  const result = await restoreCopy({ copy, key, sha256: sha256 ?? null, unchecked, out });
  say(result.checked ? `${path.basename(copy)} matches the SHA-256 your backup recorded, and opened.` : `${path.basename(copy)} opened without a check. Its SHA-256 is ${result.sha256}.`);
  return out;
}
