import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OTHER_EXTENSION, skippedTableCounts } from "../scripts/restore-list.mjs";

// The monthly test restore against a real Postgres server and a dump shaped like a Supabase project
// (fixtures/supabase). Only the bucket is faked. Runs where Postgres 16 or newer server binaries are installed.

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");
const FIXTURE = path.join(import.meta.dirname, "fixtures", "supabase");
const DUMP_KEY = "lifeboat/db/20261017T000000Z.backup";
const TOOLS = ["initdb", "pg_ctl", "psql", "pg_restore", "pg_dump"];

/** Server binaries new enough to read the fixture (made by pg_dump 16), and who runs the server. */
function findPostgres() {
  const candidates = [process.env.LIFEBOAT_TEST_PG_BIN, ...[18, 17, 16].map((major) => `/usr/lib/postgresql/${major}/bin`)];
  for (const bin of candidates.filter(Boolean)) {
    if (!TOOLS.every((tool) => existsSync(path.join(bin, tool)))) continue;
    const version = spawnSync(path.join(bin, "pg_restore"), ["--version"], { encoding: "utf8" }).stdout ?? "";
    const major = Number(/(\d+)/.exec(version)?.[1]);
    if (!(major >= 16)) continue;
    // initdb refuses root, so as root the throwaway server runs as the postgres user, in its home folder.
    if (process.getuid?.() !== 0) return { bin, major, base: tmpdir() };
    const entry = spawnSync("getent", ["passwd", "postgres"], { encoding: "utf8" }).stdout?.trim().split(":") ?? [];
    if (entry.length < 6 || !existsSync(entry[5])) continue;
    return { bin, major, base: entry[5], user: { uid: Number(entry[2]), gid: Number(entry[3]) } };
  }
  return null;
}

const PG = findPostgres();
const SKIP = PG ? false : "no Postgres 16 or newer server binaries (initdb, pg_ctl) on this machine";

function asServer(command, args) {
  return spawnSync(path.join(PG.bin, command), args, { encoding: "utf8", ...(PG.user ?? {}) });
}

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

/** A throwaway cluster with an empty `restore` database, like the restore-test job's service container. */
async function startCluster() {
  const dir = mkdtempSync(path.join(PG.base, "lg-pg-"));
  if (PG.user) chownSync(dir, PG.user.uid, PG.user.gid);
  const data = path.join(dir, "data");
  const port = await freePort();
  const init = asServer("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync"]);
  assert.equal(init.status, 0, init.stderr);
  const start = asServer("pg_ctl", ["-D", data, "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "-l", path.join(dir, "server.log"), "-w", "start"]);
  assert.equal(start.status, 0, start.stderr);
  const url = (database) => `postgresql://postgres@127.0.0.1:${port}/${database}`;
  sql(url("postgres"), "CREATE DATABASE restore");
  return {
    url: url("restore"),
    stop() {
      asServer("pg_ctl", ["-D", data, "-m", "immediate", "stop"]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function sql(url, text) {
  return execFileSync(path.join(PG.bin, "psql"), [url, "--no-psqlrc", "-Atq", "-v", "ON_ERROR_STOP=1", "-c", text], { encoding: "utf8" }).trim();
}

function sqlFile(url, file) {
  execFileSync(path.join(PG.bin, "psql"), [url, "--no-psqlrc", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8", stdio: "pipe" });
}

/** A stand-in for LastGood's check-in endpoint that keeps each body it receives. */
async function checkinServer() {
  const checkins = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      checkins.push(JSON.parse(body));
      response.writeHead(202).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, checkins };
}

/** run.sh in restore-test mode with the real Postgres tools. The bucket holds the fixture dump and no code copy. */
async function runRestoreTest(restoreUrl) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-restore-pg-"));
  const bin = path.join(dir, "bin");
  const work = path.join(dir, "work");
  const runner = path.join(dir, "runner");
  for (const folder of [bin, work, runner]) mkdirSync(folder);
  writeFileSync(
    path.join(bin, "aws"),
    `#!/bin/sh
case " $* " in
  *" s3api "*"/db/ "*) echo '{"Contents":[{"Key":"${DUMP_KEY}"}]}' ;;
  *" s3api "*) echo '{"Contents":[]}' ;;
  *" s3 cp "*) for last; do :; done; cp "${path.join(FIXTURE, "dump.backup")}" "$last" ;;
esac
exit 0
`,
  );
  chmodSync(path.join(bin, "aws"), 0o755);
  const api = await checkinServer();
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          LIFEBOAT_MODE: "restore-test",
          LIFEBOAT_PG_BIN: PG.bin,
          POSTGRES_MAJOR: String(PG.major),
          RUNNER_TEMP: runner,
          RESTORE_DATABASE_URL: restoreUrl,
          S3_BUCKET: "lastgood-backups-ap-southeast-2",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          LIFEBOAT_ENCRYPT: "false",
          LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
          CHECKIN_SECRET: "unit-test-checkin-secret",
          CHECKIN_URL: `http://127.0.0.1:${api.port}/checkin`,
          LIFEBOAT_WORKDIR: work,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, checkins: api.checkins };
  } finally {
    api.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What the restored database holds, by the counts and objects a Supabase app needs back. */
function restoredShape(url) {
  return {
    users: sql(url, "SELECT count(*) FROM auth.users"),
    identities: sql(url, "SELECT count(*) FROM auth.identities"),
    objects: sql(url, "SELECT count(*) FROM storage.objects"),
    profiles: sql(url, "SELECT count(*) FROM public.profiles"),
    signUpTrigger: sql(url, "SELECT count(*) FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass"),
    policies: sql(url, "SELECT string_agg(policyname, ', ' ORDER BY policyname) FROM pg_policies"),
    rls: sql(url, "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.listings'::regclass"),
    published: sql(url, "SELECT string_agg(schemaname || '.' || tablename, ', ') FROM pg_publication_tables WHERE pubname = 'supabase_realtime'"),
    listingCounts: sql(url, "SELECT count(*) FROM public.listing_counts"),
  };
}

const EXPECTED_SHAPE = {
  users: "12",
  identities: "12",
  objects: "5",
  profiles: "12",
  signUpTrigger: "1",
  policies: "Owners manage their listings, Profiles are viewable by everyone, Signed-in users read avatars, Users update their own profile",
  rls: "t",
  published: "public.messages",
  listingCounts: "12",
};

test("a Supabase-shaped dump passes the test restore on stock Postgres, skipping only the Supabase-only extensions", { skip: SKIP }, async () => {
  const cluster = await startCluster();
  try {
    const result = await runRestoreTest(cluster.url);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Restore list skipped extensions: pg_graphql, pg_net, pgjwt, pgsodium, supabase_vault\./);
    // Their comments are skipped with them, so pg_restore never warns that the extension does not exist.
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /extension "\w+" does not exist/);
    assert.match(result.stdout, /Row count matched for public\.profiles: 12\./);
    assert.match(result.stdout, /Users restored: 12 accounts, 9 with a password, 12 sign-in identities, matching the dump\./);
    assert.deepEqual(restoredShape(cluster.url), EXPECTED_SHAPE);
    // Tables an extension owns come back only where the extension does: here Vault's secrets do not.
    assert.equal(sql(cluster.url, "SELECT to_regclass('vault.secrets') IS NULL"), "t");
    // So the pass says so: in the job log by table, and in the check-in by extension, counts only.
    assert.match(result.stdout, /Not checked by this test restore: vault\.secrets \(1 rows in the dump\), because this database does not offer supabase_vault\./);
    assert.equal(result.checkins.length, 1);
    assert.equal(result.checkins[0].kind, "restore-test");
    assert.equal(result.checkins[0].ok, true);
    assert.deepEqual(result.checkins[0].notChecked, [{ extension: "supabase_vault", tables: 1, rows: 1 }]);
    assert.doesNotMatch(JSON.stringify(result.checkins[0]), /not-a-real-secret|stripe|vault\.secrets/);
  } finally {
    cluster.stop();
  }
});

test("into a target set up like the Supabase image, the dump's Auth and Storage tables replace the image's", { skip: SKIP }, async () => {
  const cluster = await startCluster();
  try {
    sqlFile(cluster.url, path.join(FIXTURE, "image.sql"));
    assert.equal(sql(cluster.url, "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'is_anonymous'"), "0");
    const result = await runRestoreTest(cluster.url);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Throwaway schemas to drop: auth, realtime, storage\./);
    assert.match(result.stdout, /Throwaway publications to drop: supabase_realtime\./);
    assert.match(result.stdout, /Users restored: 12 accounts, 9 with a password, 12 sign-in identities, matching the dump\./);
    assert.deepEqual(restoredShape(cluster.url), EXPECTED_SHAPE);
    // The dump's newer columns, not the image's older tables.
    assert.equal(sql(cluster.url, "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'is_anonymous'"), "1");
    assert.equal(sql(cluster.url, "SELECT count(*) FROM storage.objects WHERE path_tokens[2] = 'avatar.png'"), "5");
  } finally {
    cluster.stop();
  }
});

test("the not-checked count reads odd names from the dump itself and finds tables missing or emptied on a real server", { skip: SKIP }, async () => {
  const cluster = await startCluster();
  const dir = mkdtempSync(path.join(tmpdir(), "lg-odd-names-"));
  try {
    const source = cluster.url.replace(/\/restore$/, "/postgres");
    sql(
      source,
      [
        'CREATE SCHEMA audit; CREATE SCHEMA "My Schema"',
        "CREATE TABLE public.notes (id int); INSERT INTO public.notes VALUES (1), (2)",
        'CREATE TABLE public."Mixed" (id int)',
        'CREATE TABLE public."Odd Name" (id int); INSERT INTO public."Odd Name" VALUES (1), (2)',
        'CREATE TABLE "My Schema".plain (x text); INSERT INTO "My Schema".plain VALUES (\'a\')',
        'CREATE TABLE public."we""ird.na me" (id int); INSERT INTO public."we""ird.na me" VALUES (5)',
        "CREATE TABLE audit.pgaudit_log (entry text); INSERT INTO audit.pgaudit_log VALUES ('one'), ('two'), ('three')",
      ].join("; "),
    );
    const dumpPath = path.join(dir, "db.dump");
    execFileSync(path.join(PG.bin, "pg_dump"), ["-Fc", "-f", dumpPath, source]);
    const list = execFileSync(path.join(PG.bin, "pg_restore"), ["-l", dumpPath], { encoding: "utf8" });
    // pg_restore lists names unquoted, so these lines cannot be split back into a schema and a table.
    assert.match(list, /TABLE DATA public Odd Name postgres/);
    assert.match(list, /TABLE DATA My Schema plain postgres/);
    execFileSync(path.join(PG.bin, "pg_restore"), ["-d", cluster.url, dumpPath]);
    // What a tolerated warning can leave: one table gone, one with its definition but none of its rows.
    sql(cluster.url, 'DROP TABLE audit.pgaudit_log; DROP TABLE public."we""ird.na me"; DELETE FROM public."Odd Name"');
    const lines = [];
    const totals = await skippedTableCounts({
      toc: list,
      skipped: { extensions: [] },
      list,
      dumpPath,
      pgRestore: path.join(PG.bin, "pg_restore"),
      psql: path.join(PG.bin, "psql"),
      databaseUrl: cluster.url,
      log: (line) => lines.push(line),
    });
    assert.deepEqual(totals, [{ extension: OTHER_EXTENSION, tables: 3, rows: 6 }]);
    const logged = lines.join("");
    assert.match(logged, /audit\.pgaudit_log \(3 rows in the dump\), because it did not load/);
    assert.match(logged, /public\."we""ird\.na me" \(1 rows in the dump\), because it did not load/);
    assert.match(logged, /public\."Odd Name" \(2 rows in the dump\), because its rows did not load/);
    // An empty table that was empty in the dump too, and the tables that came back whole, are not counted.
    assert.doesNotMatch(logged, /Mixed|notes|plain/);
    assert.doesNotMatch(logged, /one|two|three/);
    // Nothing from the dump ran as SQL: every table the restore left is still there.
    assert.equal(sql(cluster.url, "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public', 'My Schema')"), "4");
  } finally {
    cluster.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
