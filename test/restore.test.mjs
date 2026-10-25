import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

const POSTGIS_TOC = `;
; Selected TOC Entries:
;
7; 2615 16384 SCHEMA - extensions postgres
2; 3079 16385 EXTENSION - postgis
3; 3079 16386 EXTENSION - pg_graphql
224; 1259 17467 TABLE public places postgres
4108; 0 16707 TABLE DATA extensions spatial_ref_sys postgres
4268; 0 17467 TABLE DATA public places postgres
`;

const POSTGIS_SQL = `CREATE SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
CREATE TABLE public.places (
    id bigint NOT NULL,
    geom extensions.geometry(Point,4326)
);
`;

const PLAIN_TOC = `;
3; 3079 16386 EXTENSION - pg_graphql
224; 1259 17467 TABLE public places postgres
4268; 0 17467 TABLE DATA public places postgres
`;

const PLAIN_SQL = `CREATE TABLE public.places (
    id bigint NOT NULL
);
`;

/**
 * Fakes for docker, psql, pg_restore and aws. The fake database offers PostGIS only after
 * docker starts a postgis/ image, and pg_restore fails the way FlipPro did when it does not.
 */
function fakes(dir, { toc, sql, target, dockerRun, dumpKey, download, authCopy = {}, authRestored = {}, codeKey = "", codeArchive = "", setupKey = "", setupArchive = "", storageKeys = [], storageArchive = "", dumpRows = {}, missing = [] }) {
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(dir, "dump.toc"), toc);
  writeFileSync(path.join(dir, "dump.schema.sql"), sql);
  writeFileSync(path.join(dir, "target"), target);
  for (const name of ["docker.log", "psql.log", "restore.log"]) writeFileSync(path.join(dir, name), "");
  // Supabase Auth rows in the dump, as pg_restore -a prints them, and the counts the restored database answers.
  for (const [table, copy] of Object.entries(authCopy)) writeFileSync(path.join(dir, `copy.auth.${table}`), copy);
  for (const [key, count] of Object.entries(authRestored)) writeFileSync(path.join(dir, `restored.${key}`), `${count}\n`);
  // Other tables' rows in the dump, keyed "schema.table", and the tables the restored database turns out not to have.
  for (const [table, copy] of Object.entries(dumpRows)) writeFileSync(path.join(dir, `copy.${table}`), copy);
  // The restored-table check answers by position in the list: the TOC's TABLE DATA entries, in order.
  const loaded = String(toc)
    .split("\n")
    .map((line) => /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line))
    .filter(Boolean)
    .map((match) => `${match[1]}.${match[2]}`);
  writeFileSync(path.join(dir, "restored.states"), loaded.map((table, index) => `${index} ${missing.includes(table) ? "missing" : "rows"}\n`).join(""));
  const scripts = {
    docker: `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/docker.log"
case "$1" in
  rm) exit 0 ;;
  run)
    if [ "${dockerRun}" != "ok" ]; then
      echo "docker: Error response from daemon: no space left on device" >&2
      exit 125
    fi
    for arg in "$@"; do image="$arg"; done
    case "$image" in postgis/*) echo postgis > "${dir}/target" ;; esac
    echo fake-container-id
    exit 0 ;;
esac
exit 1
`,
    psql: `#!/bin/sh
printf '%s\\n' "$1" >> "${dir}/psql.log"
sql=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--command" ] && sql="$arg"
  prev="$arg"
done
case "$sql" in
  "SHOW server_version_num") echo 170006 ;;
  "SELECT 1") echo 1 ;;
  "SELECT name FROM pg_available_extensions")
    echo plpgsql
    if [ "$(cat "${dir}/target")" = postgis ]; then printf '%s\\n' postgis postgis_raster postgis_topology postgis_sfcgal; fi ;;
  "SELECT nspname FROM pg_namespace") printf '%s\\n' public pg_catalog ;;
  "SELECT extname FROM pg_extension") echo plpgsql ;;
  *pg_total_relation_size*) echo 8192 ;;
  "SELECT count(*) FROM public.places") echo 2 ;;
  "SELECT count(*) FROM auth.users") cat "${dir}/restored.users" ;;
  "SELECT count(*) FROM auth.identities") cat "${dir}/restored.identities" ;;
  # The users check leaves LastGood's storage login out, so its queries end with that condition.
  "SELECT count(*) FROM auth.users WHERE encrypted_password IS NOT NULL AND encrypted_password <> '' AND email IS DISTINCT FROM 'lastgood-backup@lastgood.invalid'") cat "${dir}/restored.withPassword" ;;
  "SELECT count(*) FROM auth.users WHERE email IS DISTINCT FROM 'lastgood-backup@lastgood.invalid'") cat "${dir}/restored.users" ;;
  "SELECT count(*) FROM auth.identities WHERE user_id NOT IN (SELECT id FROM auth.users WHERE email = 'lastgood-backup@lastgood.invalid')") cat "${dir}/restored.identities" ;;
  "SELECT current_database();") echo restore ;;
  *to_regclass*) cat "${dir}/restored.states" ;;
esac
exit 0
`,
    pg_restore: `#!/bin/sh
case "$1" in
  --version) echo "pg_restore (PostgreSQL) 17.6"; exit 0 ;;
  --list)
    for last; do :; done
    # The restore must read the dump itself, never ciphertext or a damaged copy.
    [ "$(cat "$last")" = dump ] || { echo "pg_restore: error: input file does not appear to be a valid archive" >&2; exit 1; }
    cat "${dir}/dump.toc"; exit 0 ;;
  --schema-only)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--file" ]; then cp "${dir}/dump.schema.sql" "$2"; exit 0; fi
      shift
    done
    exit 1 ;;
  --dbname)
    printf '%s\\n' "$2" >> "${dir}/restore.log"
    if grep -q "EXTENSION - postgis" "${dir}/dump.toc" && [ "$(cat "${dir}/target")" != postgis ]; then
      echo 'pg_restore: error: could not execute query: ERROR:  type "extensions.geometry" does not exist' >&2
      exit 1
    fi
    exit 0 ;;
  -a)
    if [ -f "${dir}/copy.$3.$5" ]; then cat "${dir}/copy.$3.$5"; exit 0; fi
    echo "COPY $3.$5 (id) FROM stdin;"
    [ "$5" = places ] && printf '1\\n2\\n'
    echo '\\.'
    exit 0 ;;
esac
exit 1
`,
    pg_dump: `#!/bin/sh
[ "$1" = "--version" ] && echo "pg_dump (PostgreSQL) 17.6"
exit 0
`,
    // The bucket holds the dump under db/ and, when a test gives them, a code copy under repo/ and a setup copy under setup/.
    aws: `#!/bin/sh
case " $* " in
  *" s3api "*"/repo/ "*) ${codeKey ? `echo '{"Contents":[{"Key":"${codeKey}"}]}'` : `echo '{"Contents":[]}'`} ;;
  *" s3api "*"/setup/ "*) ${setupKey ? `echo '{"Contents":[{"Key":"${setupKey}"}]}'` : `echo '{"Contents":[]}'`} ;;
  *" s3api "*"/storage/ "*) echo '${JSON.stringify({ Contents: storageKeys.map((Key) => ({ Key })) })}' ;;
  *" s3api "*) echo '{"Contents":[{"Key":"${dumpKey}"}]}' ;;
${codeKey ? `  *" s3://lastgood-backups-ap-southeast-2/${codeKey} "*)
    for last; do :; done
    cp "${codeArchive}" "$last" ;;
` : ""}${setupKey ? `  *" s3://lastgood-backups-ap-southeast-2/${setupKey} "*)
    for last; do :; done
    cp "${setupArchive}" "$last" ;;
` : ""}${storageArchive ? `  *" s3://lastgood-backups-ap-southeast-2/"*"/storage/"*)
    for last; do :; done
    cp "${storageArchive}" "$last" ;;
` : ""}  *" s3 cp "*)
    for last; do :; done
    if [ -n "${download}" ]; then cp "${download}" "$last"; else printf 'dump' > "$last"; fi ;;
esac
exit 0
`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

function runRestoreTest({
  toc = POSTGIS_TOC,
  sql = POSTGIS_SQL,
  target = "stock",
  dockerRun = "ok",
  dumpKey = "lifeboat/db/20261017T000000Z.backup",
  download = "",
  env = {},
  authCopy = {},
  authRestored = {},
  codeKey = "",
  codeArchive = "",
  setupKey = "",
  setupArchive = "",
  storageKeys = [],
  storageArchive = "",
  dumpRows = {},
  missing = [],
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-restore-test-"));
  const bin = fakes(dir, { toc, sql, target, dockerRun, dumpKey, download, authCopy, authRestored, codeKey, codeArchive, setupKey, setupArchive, storageKeys, storageArchive, dumpRows, missing });
  const work = path.join(dir, "work");
  const runner = path.join(dir, "runner");
  mkdirSync(work);
  mkdirSync(runner);
  writeFileSync(path.join(runner, "lifeboat-restore-url"), "postgresql://postgres:throwaway@localhost:5432/restore");
  const result = spawnSync("bash", [RUN], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      LIFEBOAT_MODE: "restore-test",
      LIFEBOAT_PG_BIN: bin,
      POSTGRES_MAJOR: "17",
      RUNNER_TEMP: runner,
      RESTORE_DATABASE_URL: "postgresql://postgres:throwaway@localhost:5432/restore",
      S3_BUCKET: "lastgood-backups-ap-southeast-2",
      S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
      LIFEBOAT_ENCRYPT: "false",
      CHECKIN_SECRET: "",
      LIFEBOAT_WORKDIR: work,
      LIFEBOAT_RESTORE_WAIT_TRIES: "2",
      LIFEBOAT_RESTORE_WAIT_SECONDS: "0",
      ...env,
    },
    encoding: "utf8",
  });
  const read = (name) => readFileSync(path.join(dir, name), "utf8");
  return { result, docker: read("docker.log"), psql: read("psql.log"), restores: read("restore.log"), work };
}

const CONTAINER = {
  LIFEBOAT_RESTORE_CONTAINER: "lifeboat-restore",
  LIFEBOAT_RESTORE_POSTGIS_IMAGE: "postgis/postgis:17-3.5",
};

test("a PostGIS dump on the stock image replaces the container and restores", () => {
  const { result, docker, restores, work } = runRestoreTest({ env: CONTAINER });
  assert.equal(result.status, 0, result.stderr);
  const switchLines = result.stdout.split("\n").filter((line) => line.includes("Replacing container"));
  assert.deepEqual(switchLines, [
    "The dump uses PostGIS (extension postgis; type extensions.geometry) and the restore database does not offer postgis. Replacing container lifeboat-restore with postgis/postgis:17-3.5.",
  ]);
  assert.match(docker, /^rm -f lifeboat-restore$/m);
  assert.match(
    docker,
    /^run -d --name lifeboat-restore -e POSTGRES_PASSWORD=throwaway -e POSTGRES_DB=restore -p 5432:5432 --tmpfs \/docker-entrypoint-initdb\.d postgis\/postgis:17-3\.5$/m,
  );
  assert.match(result.stdout, /The restore database offers postgis\./);
  assert.match(result.stdout, /Restore list skipped extensions: pg_graphql\./);
  assert.match(result.stdout, /Row count matched for public\.places: 2\./);
  assert.doesNotMatch(result.stdout, /spatial_ref_sys/);
  assert.equal(restores.trim(), "postgresql://postgres:throwaway@localhost:5432/restore");
  assert.equal(existsSync(path.join(work, "restore.schema.sql")), false);
  const printed = `${result.stdout}${result.stderr}`.split("\n").filter((line) => !line.startsWith("::add-mask::"));
  assert.doesNotMatch(printed.join("\n"), /unit-test-secret-not-real/);
});

test("the PostGIS image is chosen from the Postgres major when the workflow names none", () => {
  const { result, docker } = runRestoreTest({
    env: { LIFEBOAT_RESTORE_CONTAINER: "lifeboat-restore", POSTGRES_MAJOR: "15" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(docker, /postgis\/postgis:15-3\.5$/m);
});

test("without a container to replace, a PostGIS dump fails before restoring and names PostGIS", () => {
  const { result, docker, restores } = runRestoreTest();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The dump uses PostGIS/);
  assert.match(result.stderr, /LIFEBOAT_RESTORE_CONTAINER/);
  assert.match(result.stderr, /stopped before restoring/);
  assert.doesNotMatch(result.stderr, /does not exist/);
  assert.equal(docker, "");
  assert.equal(restores, "");
});

test("a PostGIS image that does not start fails the restore test and names PostGIS", () => {
  const { result, restores } = runRestoreTest({ env: CONTAINER, dockerRun: "fail" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The dump uses PostGIS, and the PostGIS image postgis\/postgis:17-3\.5 did not start/);
  assert.equal(restores, "");
});

test("a dump without PostGIS keeps the stock image and its extension warnings", () => {
  const { result, docker } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, env: CONTAINER });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(docker, "");
  assert.doesNotMatch(result.stdout, /PostGIS/);
  assert.match(result.stdout, /Restore list skipped extensions: pg_graphql\./);
});

test("a target that already offers PostGIS is not replaced", () => {
  const { result, docker } = runRestoreTest({ target: "postgis", env: CONTAINER });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(docker, "");
  assert.match(result.stdout, /The dump uses PostGIS \(extension postgis; type extensions\.geometry\)\. The restore database offers postgis\./);
});

/** A real age key pair and a real age copy of the fake dump, made with the age CLI the action installs. */
function ageCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-age-copy-"));
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const keyText = readFileSync(keyFile, "utf8");
  const privateKey = keyText.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-1"));
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  const plain = path.join(dir, "dump.backup");
  const copy = path.join(dir, "dump.backup.age");
  writeFileSync(plain, "dump");
  execFileSync("age", ["--encrypt", "--recipient", publicKey, "--output", copy, plain]);
  return { dir, keyText, privateKey, publicKey, copy };
}

const AGE_KEY = "lifeboat/db/20261018T000000Z.backup.age";

function printed(result) {
  return `${result.stdout}${result.stderr}`
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

test("an age copy restores with LIFEBOAT_PRIVATE_KEY, and the key never reaches the log", () => {
  const { privateKey, copy } = ageCopy();
  const { result, restores, work } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(restores.trim(), "postgresql://postgres:throwaway@localhost:5432/restore");
  assert.match(result.stdout, /Row count matched for public\.places: 2\./);
  assert.match(result.stdout, new RegExp(`::add-mask::${privateKey}`));
  assert.doesNotMatch(printed(result), new RegExp(privateKey));
  assert.equal(existsSync(path.join(work, "identity.txt")), false);
  assert.equal(existsSync(path.join(work, "restore.download")), false);
});

test("a whole age key file works as LIFEBOAT_PRIVATE_KEY", () => {
  const { keyText, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: keyText },
  });
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, damage] of [
  ["a changed byte", (bytes) => { bytes[bytes.length - 20] ^= 0x01; return bytes; }],
  ["a cut-short copy", (bytes) => bytes.subarray(0, bytes.length - 10)],
  ["a changed header", (bytes) => { const text = bytes.toString("latin1"); return Buffer.from(text.replace("X25519 ", "X25519  "), "latin1"); }],
]) {
  test(`${name} fails the restore test before anything is restored`, () => {
    const { privateKey, copy, dir } = ageCopy();
    const damaged = path.join(dir, "damaged.age");
    const original = readFileSync(copy);
    const changed = damage(Buffer.from(original));
    assert.notDeepEqual(changed, original);
    writeFileSync(damaged, changed);
    const { result, restores, work } = runRestoreTest({
      toc: PLAIN_TOC,
      sql: PLAIN_SQL,
      dumpKey: AGE_KEY,
      download: damaged,
      env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not open with LIFEBOAT_PRIVATE_KEY/);
    assert.match(result.stderr, /It was not restored/);
    assert.equal(restores, "");
    assert.equal(existsSync(path.join(work, "restore.backup")), false);
    assert.equal(existsSync(path.join(work, "identity.txt")), false);
    assert.doesNotMatch(printed(result), new RegExp(privateKey));
  });
}

test("an age copy made for a different key does not restore", () => {
  const { copy } = ageCopy();
  const other = ageCopy();
  const { result, restores } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: other.privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /made for a different key/);
  assert.equal(restores, "");
});

test("an age copy without LIFEBOAT_PRIVATE_KEY says what is missing", () => {
  const { copy } = ageCopy();
  const { result, restores } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_ENCRYPTION_PASSPHRASE: "older-passphrase-here" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set LIFEBOAT_PRIVATE_KEY/);
  assert.equal(restores, "");
});

test("a passphrase copy from before the key pair still restores", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-enc-copy-"));
  const plain = path.join(dir, "dump.backup");
  const copy = path.join(dir, "dump.backup.enc");
  writeFileSync(plain, "dump");
  const env = { ...process.env, LIFEBOAT_ENCRYPTION_PASSPHRASE: "older-passphrase-here" };
  execFileSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:LIFEBOAT_ENCRYPTION_PASSPHRASE", "-in", plain, "-out", copy], { env });
  const { privateKey } = ageCopy();
  const { result, restores } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: "lifeboat/db/20261016T000000Z.backup.enc",
    download: copy,
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_ENCRYPTION_PASSPHRASE: "older-passphrase-here", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(restores.trim(), "postgresql://postgres:throwaway@localhost:5432/restore");
});

test("with encryption on, a plain copy someone else put in the bucket is not restored", () => {
  const { privateKey } = ageCopy();
  const { result, restores } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: "lifeboat/db/20991231T000000Z.backup",
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /20991231T000000Z\.backup, is not encrypted/);
  assert.match(result.stderr, /It was not restored/);
  assert.equal(restores, "");
});

const AUTH_TOC = `${PLAIN_TOC}
230; 1259 17500 TABLE auth users supabase_auth_admin
231; 1259 17510 TABLE auth identities supabase_auth_admin
4270; 0 17500 TABLE DATA auth users supabase_auth_admin
4271; 0 17510 TABLE DATA auth identities supabase_auth_admin
`;
const AUTH_COPY = {
  users: "COPY auth.users (instance_id, id, email, encrypted_password, raw_user_meta_data) FROM stdin;\n\\N\tu1\ta@example.invalid\t$2a$10$hash1\t{}\n\\N\tu2\tb@example.invalid\t$2a$10$hash2\t{\"x\": \"tab\\there\"}\n\\N\tu3\toauth@example.invalid\t\t{}\n\\.\n",
  identities: "COPY auth.identities (id, user_id, provider) FROM stdin;\ni1\tu1\temail\ni2\tu2\temail\ni3\tu3\tgithub\n\\.\n",
};

test("the test restore proves the users came back: accounts, password hashes and identities", () => {
  const { result } = runRestoreTest({
    toc: AUTH_TOC,
    sql: PLAIN_SQL,
    authCopy: AUTH_COPY,
    authRestored: { users: 3, withPassword: 2, identities: 3 },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Users restored: 3 accounts, 2 with a password, 3 sign-in identities, matching the dump\./);
  assert.doesNotMatch(result.stdout + result.stderr, /example\.invalid|\$2a\$/);
});

test("users missing from the test restore fail it, by count and never by name", () => {
  const { result } = runRestoreTest({
    toc: AUTH_TOC,
    sql: PLAIN_SQL,
    authCopy: AUTH_COPY,
    authRestored: { users: 3, withPassword: 1, identities: 3 },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Users did not come back: the dump has 2 accounts with a password, the test restore has 1\./);
  assert.doesNotMatch(result.stdout + result.stderr, /example\.invalid|\$2a\$/);
});

test("a table that did not load for an extension outside the list is named in the log, and the restore still passes", () => {
  const toc = `${PLAIN_TOC}4290; 0 17700 TABLE DATA audit pgaudit_log postgres\n`;
  const { result } = runRestoreTest({
    toc,
    sql: PLAIN_SQL,
    dumpRows: { "audit.pgaudit_log": "COPY audit.pgaudit_log (id, entry) FROM stdin;\n1\tlogged\n2\tlogged\n\\.\n" },
    missing: ["audit.pgaudit_log"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not checked by this test restore: audit\.pgaudit_log \(2 rows in the dump\), because it did not load, most likely for an extension this database does not offer\./);
  assert.doesNotMatch(result.stdout, /public\.places \(/);
});

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

/**
 * A code copy as the backup makes it: code.bundle and github/*.json in one tar.gz, encrypted with age when a
 * public key is given. `damage` changes the bundle's bytes before it is packed; `empty` leaves the bundle out.
 */
/**
 * tar arguments that add a name outside the folder an archive opens into, as only a hand-made archive could hold:
 * -P keeps a ".." or absolute name as it is.
 */
function outsideNames(dir, outside) {
  if (!outside) return [];
  const evil = path.join(dir, "evil.txt");
  writeFileSync(evil, "evil\n");
  return ["-P", outside === "absolute" ? evil : "../evil.txt"];
}

function codeCopy({ publicKey = "", damage = null, empty = false, outside = "", link = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-code-copy-"));
  const pack = path.join(dir, "pack");
  mkdirSync(path.join(pack, "github"), { recursive: true });
  if (!empty) {
    const repo = path.join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "app.txt"), "main\n".repeat(200));
    git(repo, "add", "app.txt");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "tag", "-a", "v1.0.0", "-m", "first release");
    git(repo, "checkout", "-q", "-b", "agent/never-merged");
    writeFileSync(path.join(repo, "agent.txt"), "agent\n");
    git(repo, "add", "agent.txt");
    git(repo, "commit", "-q", "-m", "agent work");
    git(repo, "checkout", "-q", "main");
    git(repo, "bundle", "create", "-q", path.join(pack, "code.bundle"), "--all");
    if (damage) writeFileSync(path.join(pack, "code.bundle"), damage(readFileSync(path.join(pack, "code.bundle"))));
  }
  const lists = {
    "repository.json": { full_name: "acme/notes" },
    "issues.json": [{ number: 1 }, { number: 2, pull_request: {} }],
    "issue-comments.json": [{ id: 1 }],
    "pulls.json": [{ number: 2 }],
    "review-comments.json": [{ id: 3 }],
  };
  for (const [file, value] of Object.entries(lists)) writeFileSync(path.join(pack, "github", file), JSON.stringify(value));
  if (link) symlinkSync("/etc/hostname", path.join(pack, "github", "aaa-link"));
  const archive = path.join(dir, "code.tar.gz");
  const extra = outsideNames(dir, outside);
  execFileSync("tar", [...extra.slice(0, 1), "-czf", archive, "-C", pack, ".", ...extra.slice(1)]);
  if (!publicKey) return archive;
  execFileSync("age", ["--encrypt", "--recipient", publicKey, "--output", `${archive}.age`, archive]);
  return `${archive}.age`;
}

const CODE_KEY = "lifeboat/repo/20261018T000000Z.tar.gz";

test("the test restore loads the newest code copy too: every ref clones back and git fsck passes", () => {
  const { result } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, codeKey: CODE_KEY, codeArchive: codeCopy() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Code: 2 branches and 1 tags cloned back out of 20261018T000000Z\.tar\.gz, and git fsck found no damage\. GitHub: 1 issues, 1 pull requests, 2 comments read back\./,
  );
});

test("an age code copy opens with the same key as the database copy", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result, work } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    codeKey: `${CODE_KEY}.age`,
    codeArchive: codeCopy({ publicKey }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Code: 2 branches and 1 tags cloned back/);
  assert.doesNotMatch(printed(result), new RegExp(privateKey));
  assert.equal(existsSync(path.join(work, "code-restore")), false, "nothing readable is left on the runner");
  assert.equal(existsSync(path.join(work, "identity.txt")), false);
});

test("a damaged code bundle fails the test restore and says the code did not restore", () => {
  const damaged = codeCopy({
    damage: (bytes) => {
      const changed = Buffer.from(bytes);
      for (let i = changed.length - 200; i < changed.length - 30; i += 1) changed[i] ^= 0x55;
      return changed;
    },
  });
  const { result, work } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, codeKey: CODE_KEY, codeArchive: damaged });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /20261018T000000Z\.tar\.gz.*(did not clone|git fsck found damaged objects).*The code copy did not restore\./);
  assert.equal(existsSync(path.join(work, "code-restore")), false);
});

test("an age code copy made for a different key does not restore", () => {
  const { privateKey, copy } = ageCopy();
  const other = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    codeKey: `${CODE_KEY}.age`,
    codeArchive: codeCopy({ publicKey: other.publicKey }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not open with LIFEBOAT_PRIVATE_KEY/);
});

test("with encryption on, a plain code copy someone else put in the bucket is not restored", () => {
  const { privateKey, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    codeKey: CODE_KEY,
    codeArchive: codeCopy(),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The newest code copy, 20261018T000000Z\.tar\.gz, is not encrypted/);
});

test("damaged GitHub metadata in the code copy fails the test restore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-code-copy-"));
  mkdirSync(path.join(dir, "github"));
  writeFileSync(path.join(dir, "github", "repository.json"), "{}");
  writeFileSync(path.join(dir, "github", "issues.json"), "[{");
  const archive = path.join(dir, "code.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "github"]);
  const { result } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, codeKey: CODE_KEY, codeArchive: archive });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /issues\.json in the code copy did not read back/);
});

test("a code copy of a repository with no commits passes and says so", () => {
  const { result } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, codeKey: CODE_KEY, codeArchive: codeCopy({ empty: true }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /holds no commits, because the repository had none when it was copied/);
});

test("without a code copy yet, the test restore loads the database and says the code was not checked", () => {
  const { result } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No code copy under lifeboat\/repo\/ yet, so this test restore loaded the database only\./);
});

/** A Supabase setup copy as the backup writes it: one function's files, the settings and the database extras. */
function setupCopy({ publicKey = "", damage = null, outside = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-setup-copy-"));
  const pack = path.join(dir, "pack");
  const source = "Deno.serve(() => new Response('hi'));\n";
  mkdirSync(path.join(pack, "functions", "hello", "files"), { recursive: true });
  writeFileSync(path.join(pack, "functions", "hello", "files", "index.ts"), source);
  writeFileSync(
    path.join(pack, "functions", "hello", "source.json"),
    JSON.stringify({ slug: "hello", format: "files", entrypoint_path: "index.ts", files: [{ path: "index.ts", saved: "files/index.ts", bytes: Buffer.byteLength(source) }] }),
  );
  const files = {
    "functions.json": [{ slug: "hello" }],
    "auth-config.json": { site_url: "https://notes.example" },
    "auth-third-party.json": [],
    "storage-config.json": { fileSizeLimit: 52428800 },
    "buckets.json": [{ id: "avatars" }],
    "cron-jobs.json": [{ jobid: 1, jobname: "nightly-digest" }],
    "database-webhooks.json": [],
    "vault-secret-names.json": [{ name: "stripe_webhook" }],
  };
  for (const [file, value] of Object.entries(files)) writeFileSync(path.join(pack, file), JSON.stringify(value));
  damage?.(pack);
  const archive = path.join(dir, "setup.tar.gz");
  const extra = outsideNames(dir, outside);
  execFileSync("tar", [...extra.slice(0, 1), "-czf", archive, "-C", pack, ".", ...extra.slice(1)]);
  if (!publicKey) return archive;
  execFileSync("age", ["--encrypt", "--recipient", publicKey, "--output", `${archive}.age`, archive]);
  return `${archive}.age`;
}

const SETUP_KEY = "lifeboat/setup/20261018T000000Z.tar.gz.age";

test("the test restore reads the newest Supabase setup copy back: every function file at its size, and every setting", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result, work } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    setupKey: SETUP_KEY,
    setupArchive: setupCopy({ publicKey }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Supabase setup: 1 Edge Functions, auth and storage settings, 1 cron jobs, 0 database webhooks and 1 Vault secret names read back out of 20261018T000000Z\.tar\.gz\.age, every function file at the size it was saved\./,
  );
  assert.doesNotMatch(printed(result), new RegExp(privateKey));
  assert.equal(existsSync(path.join(work, "setup-restore")), false, "nothing readable is left on the runner");
  assert.equal(existsSync(path.join(work, "setup-restore.tar.gz")), false);
});

test("a setup copy with a function file cut short fails the test restore and names the file", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    setupKey: SETUP_KEY,
    setupArchive: setupCopy({ publicKey, damage: (pack) => writeFileSync(path.join(pack, "functions", "hello", "files", "index.ts"), "Deno") }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /files\/index\.ts in the hello function did not read back at the size it was saved\. \(20261018T000000Z\.tar\.gz\.age\)/);
});

test("a setup copy missing a settings file fails the test restore", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    setupKey: SETUP_KEY,
    setupArchive: setupCopy({ publicKey, damage: (pack) => rmSync(path.join(pack, "auth-config.json")) }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /auth-config\.json in the Supabase setup copy did not read back\./);
});

test("a setup copy holding a link is not extracted, so the check can never follow it outside the folder", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result, work } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    setupKey: SETUP_KEY,
    setupArchive: setupCopy({
      publicKey,
      damage: (pack) => {
        const file = path.join(pack, "functions", "hello", "files", "index.ts");
        rmSync(file);
        symlinkSync("/etc/hostname", file);
      },
    }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The Supabase setup copy 20261018T000000Z\.tar\.gz\.age holds something other than plain files and folders, such as a link, which this workflow never writes\. It was not restored\./);
  assert.equal(existsSync(path.join(work, "setup-restore")), false, "nothing was extracted");
});

test("a plain setup copy is never restored, because the workflow only copies the setup encrypted", () => {
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    setupKey: "lifeboat/setup/20261018T000000Z.tar.gz",
    setupArchive: setupCopy(),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The newest Supabase setup copy, 20261018T000000Z\.tar\.gz, is not encrypted, but this workflow only ever copies the setup encrypted, so it did not make it\. It was not restored\./);
});

test("without a setup copy yet, the test restore says Edge Functions and settings were not checked", () => {
  const { result } = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No Supabase setup copy under lifeboat\/setup\/ yet, so this test restore did not check Edge Functions or settings\./);
});

/** A files copy as an encrypted backup writes it: one folder per bucket, tarred from the storage root. */
function filesCopy({ publicKey = "", damage = null, outside = "" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-files-copy-"));
  const root = path.join(dir, "storage");
  mkdirSync(path.join(root, "avatars", "users"), { recursive: true });
  mkdirSync(path.join(root, "invoices"), { recursive: true });
  writeFileSync(path.join(root, "avatars", "users", "ada.png"), "a picture of Ada");
  writeFileSync(path.join(root, "avatars", "users", "bo.png"), "a picture of Bo");
  writeFileSync(path.join(root, "invoices", "2026-10.pdf"), "an invoice");
  damage?.(root);
  const archive = path.join(dir, "storage.tar");
  // Sorted, so a test can say which file comes first.
  const extra = outsideNames(dir, outside);
  execFileSync("tar", [...extra.slice(0, 1), "--sort=name", "-cf", archive, "-C", root, ".", ...extra.slice(1)]);
  if (!publicKey) return archive;
  execFileSync("age", ["--encrypt", "--recipient", publicKey, "--output", `${archive}.age`, archive]);
  return `${archive}.age`;
}

const FILES_KEY = "lifeboat/storage/20261018T000000Z.tar.age";

test("the test restore opens the newest files copy: every entry lists and a sample file reads back at its size (B5)", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result, work } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    // A file an earlier unencrypted run synced sits in a folder below; it is never taken for a copy.
    storageKeys: ["lifeboat/storage/20261017T000000Z.tar.age", FILES_KEY, "lifeboat/storage/zz-bucket/old.tar"],
    storageArchive: filesCopy({ publicKey }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Files: 3 files in 2 buckets listed out of 20261018T000000Z\.tar\.age, and a sample file of 16 bytes read back at the size it was saved\./,
  );
  assert.doesNotMatch(printed(result), new RegExp(privateKey));
  assert.doesNotMatch(printed(result), /a picture of Ada/, "no file's contents are printed");
  for (const left of ["storage-restore", "storage-restore.tar", "storage.download"]) {
    assert.equal(existsSync(path.join(work, left)), false, `${left} is not left on the runner`);
  }
});

test("a files copy holding a link is not extracted, so the check can never follow it outside the folder", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result, work } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({ publicKey, damage: (root) => symlinkSync("/etc/hostname", path.join(root, "avatars", "aaa-link")) }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The files copy 20261018T000000Z\.tar\.age holds something other than plain files and folders, such as a link, which this workflow never writes\. It was not restored\./);
  assert.equal(existsSync(path.join(work, "storage-restore")), false, "nothing was extracted");
});

test("a code, setup or files copy naming a path outside its folder, or a code copy holding a link, is not extracted", () => {
  const code = (codeArchive) => runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, codeKey: CODE_KEY, codeArchive });
  const dotted = code(codeCopy({ outside: "dotted" }));
  assert.notEqual(dotted.result.status, 0);
  assert.match(dotted.result.stderr, /The code copy 20261018T000000Z\.tar\.gz names a path outside its own folder, which this workflow never writes\. It was not restored\./);
  assert.equal(existsSync(path.join(dotted.work, "code-restore")), false, "nothing was extracted");
  const linked = code(codeCopy({ link: true }));
  assert.notEqual(linked.result.status, 0);
  assert.match(linked.result.stderr, /The code copy 20261018T000000Z\.tar\.gz holds something other than plain files and folders, such as a link, which this workflow never writes\. It was not restored\./);
  assert.equal(existsSync(path.join(linked.work, "code-restore")), false, "nothing was extracted");

  const { privateKey, publicKey, copy } = ageCopy();
  const encrypted = { toc: PLAIN_TOC, sql: PLAIN_SQL, dumpKey: AGE_KEY, download: copy, env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey } };
  const setup = runRestoreTest({ ...encrypted, setupKey: SETUP_KEY, setupArchive: setupCopy({ publicKey, outside: "dotted" }) });
  assert.notEqual(setup.result.status, 0);
  assert.match(setup.result.stderr, /The Supabase setup copy 20261018T000000Z\.tar\.gz\.age names a path outside its own folder, which this workflow never writes\. It was not restored\./);
  assert.equal(existsSync(path.join(setup.work, "setup-restore")), false, "nothing was extracted");
  const files = runRestoreTest({ ...encrypted, storageKeys: [FILES_KEY], storageArchive: filesCopy({ publicKey, outside: "absolute" }) });
  assert.notEqual(files.result.status, 0);
  assert.match(files.result.stderr, /The files copy 20261018T000000Z\.tar\.age names a path outside its own folder, which this workflow never writes\. It was not restored\./);
  assert.equal(existsSync(path.join(files.work, "storage-restore")), false, "nothing was extracted");
});

test("a files copy that is not an archive fails the test restore", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const dir = mkdtempSync(path.join(tmpdir(), "lg-files-bad-"));
  writeFileSync(path.join(dir, "storage.tar"), "not a tar archive at all");
  execFileSync("age", ["--encrypt", "--recipient", publicKey, "--output", path.join(dir, "storage.tar.age"), path.join(dir, "storage.tar")]);
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: path.join(dir, "storage.tar.age"),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The files copy 20261018T000000Z\.tar\.age is not a readable archive\. It was not restored\./);
});

test("a plain files archive beside encrypted copies is never restored, because this app encrypts every copy", () => {
  const { privateKey, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: ["lifeboat/storage/20261018T000000Z.tar"],
    storageArchive: filesCopy(),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /The newest files copy, 20261018T000000Z\.tar, is not encrypted, but this app encrypts every copy, so this workflow did not make it\. It was not restored\./);
});

test("an empty files copy opens and says it lists no files", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({ publicKey, damage: (root) => {
      rmSync(path.join(root, "avatars"), { recursive: true });
      rmSync(path.join(root, "invoices", "2026-10.pdf"));
    } }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Files: 20261018T000000Z\.tar\.age opened and lists no files\./);
});

test("without a files copy yet, or with files copied unencrypted, the test restore says the files were not opened", () => {
  const { privateKey, copy } = ageCopy();
  const encrypted = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(encrypted.result.status, 0, encrypted.result.stderr);
  assert.match(encrypted.result.stdout, /No files copy under lifeboat\/storage\/ yet, so this test restore did not check the files\./);
  const plain = runRestoreTest({ toc: PLAIN_TOC, sql: PLAIN_SQL, storageKeys: ["lifeboat/storage/avatars/ada.png"] });
  assert.equal(plain.result.status, 0, plain.result.stderr);
  assert.match(plain.result.stdout, /Files: this app copies its files one by one without encryption, so this test restore did not open a files copy\./);
});

test("an empty file, such as the dashboard's folder placeholder, is passed over for the sample (D17)", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  // The Supabase dashboard leaves an empty .emptyFolderPlaceholder in a folder made there, and it sorts first in it.
  const placeholder = (root) => writeFileSync(path.join(root, "avatars", "users", ".emptyFolderPlaceholder"), "");
  const withPlaceholder = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({ publicKey, damage: placeholder }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(withPlaceholder.result.status, 0, withPlaceholder.result.stderr);
  // ada.png, "a picture of Ada", is the first file that holds any bytes.
  assert.match(
    withPlaceholder.result.stdout,
    /Files: 4 files in 2 buckets listed out of 20261018T000000Z\.tar\.age, and a sample file of 16 bytes read back at the size it was saved\./,
  );
  const onlyEmpty = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({
      publicKey,
      damage: (root) => {
        rmSync(path.join(root, "avatars", "users"), { recursive: true });
        rmSync(path.join(root, "invoices", "2026-10.pdf"));
        writeFileSync(path.join(root, "invoices", ".emptyFolderPlaceholder"), "");
      },
    }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(onlyEmpty.result.status, 0, onlyEmpty.result.stderr);
  assert.match(
    onlyEmpty.result.stdout,
    /Files: 1 file in 2 buckets listed out of 20261018T000000Z\.tar\.age\. Every file with a plain name is empty, so none was read back as a sample\./,
  );
});

test("the sample is found past any run of empty files, without reading the archive again for each one (#145)", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  const { result } = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({
      publicKey,
      damage: (root) => {
        rmSync(path.join(root, "avatars"), { recursive: true });
        // Sixty dashboard folders, each with only its empty placeholder, all sorting before the one real file.
        for (let index = 0; index < 60; index += 1) {
          const folder = path.join(root, "invoices", String(index).padStart(4, "0"));
          mkdirSync(folder);
          writeFileSync(path.join(folder, ".emptyFolderPlaceholder"), "");
        }
      },
    }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(result.status, 0, result.stderr);
  // invoices/2026-10.pdf, "an invoice".
  assert.match(
    result.stdout,
    /Files: 61 files in 1 bucket listed out of 20261018T000000Z\.tar\.age, and a sample file of 10 bytes read back at the size it was saved\./,
  );
});

test("a file whose name tar's list escapes is passed over for the sample, and a copy with only such names still lists", () => {
  const { privateKey, publicKey, copy } = ageCopy();
  // "0\\odd.png" sorts first, and tar lists its backslash escaped, so that name would not match the stored one.
  const odd = (root) => writeFileSync(path.join(root, "avatars", "0\\odd.png"), "odd");
  const mixed = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({ publicKey, damage: odd }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(mixed.result.status, 0, mixed.result.stderr);
  assert.match(mixed.result.stdout, /Files: 4 files in 2 buckets listed out of 20261018T000000Z\.tar\.age, and a sample file of 16 bytes read back at the size it was saved\./);
  const onlyOdd = runRestoreTest({
    toc: PLAIN_TOC,
    sql: PLAIN_SQL,
    dumpKey: AGE_KEY,
    download: copy,
    storageKeys: [FILES_KEY],
    storageArchive: filesCopy({
      publicKey,
      damage: (root) => {
        rmSync(path.join(root, "avatars", "users"), { recursive: true });
        rmSync(path.join(root, "invoices"), { recursive: true });
        odd(root);
      },
    }),
    env: { LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: privateKey },
  });
  assert.equal(onlyOdd.result.status, 0, onlyOdd.result.stderr);
  assert.match(onlyOdd.result.stdout, /Files: 1 file in 1 bucket listed out of 20261018T000000Z\.tar\.age\. No file has a plain enough name to read back as a sample\./);
});
