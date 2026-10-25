import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  authTablesInToc,
  authUserCounts,
  copyColumns,
  copyBlocks,
  copyCounter,
  OTHER_EXTENSION,
  restoredTables,
  skippedTableCounts,
  skippedTables,
  STORAGE_LOGIN_EMAIL,
  verifyAuthUsers,
} from "../scripts/restore-list.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

const TOC = `;
; Selected TOC Entries:
;
230; 1259 17500 TABLE auth users supabase_auth_admin
231; 1259 17510 TABLE auth identities supabase_auth_admin
224; 1259 17467 TABLE public notes postgres
4270; 0 17500 TABLE DATA auth users supabase_auth_admin
4271; 0 17510 TABLE DATA auth identities supabase_auth_admin
4268; 0 17467 TABLE DATA public notes postgres
`;

// Three accounts: two with a password hash, one that signs in with GitHub. One value holds an escaped tab.
const USERS_COPY = [
  "COPY auth.users (instance_id, id, email, encrypted_password, raw_user_meta_data) FROM stdin;",
  "\\N\tu1\ta@users.test\t$2a$10$hash-one\t{}",
  '\\N\tu2\tb@users.test\t$2a$10$hash-two\t{"note": "tab\\there"}',
  "\\N\tu3\toauth@users.test\t\t{}",
  "\\.",
  "",
].join("\n");
const IDENTITIES_COPY = ["COPY auth.identities (id, user_id, provider) FROM stdin;", "i1\tu1\temail", "i2\tu2\temail", "i3\tu3\tgithub", "\\.", ""].join("\n");

/** A fake spawn that answers pg_restore -a -t <table>, sending stdout in small chunks that cut lines in half. */
function fakeSpawn(outputs) {
  return (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const table = args[args.indexOf("-t") + 1];
    const text = outputs[table] ?? "";
    setImmediate(() => {
      for (let i = 0; i < text.length; i += 7) child.stdout.emit("data", Buffer.from(text.slice(i, i + 7)));
      child.emit("close", 0);
    });
    return child;
  };
}

test("COPY headers give their column names", () => {
  assert.deepEqual(copyColumns('COPY auth.users (id, "encrypted_password", email) FROM stdin;'), ["id", "encrypted_password", "email"]);
  assert.deepEqual(copyColumns("not a copy line"), []);
});

test("the counter counts rows and non-empty values, and treats \\N and empty as no password", () => {
  const counter = copyCounter("encrypted_password");
  for (const line of USERS_COPY.split("\n")) counter.line(line);
  assert.deepEqual(counter.result(), { rows: 3, withValue: 2, hasColumn: true, skipped: [] });
  const none = copyCounter("encrypted_password");
  none.line("nothing here");
  assert.equal(none.result(), null);
});

test("the TOC says which auth tables came with their rows", () => {
  assert.deepEqual(authTablesInToc(TOC), { usersTable: true, usersData: true, identitiesData: true });
  assert.deepEqual(authTablesInToc("224; 1259 1 TABLE public notes postgres\n"), {
    usersTable: false,
    usersData: false,
    identitiesData: false,
  });
});

test("counts survive rows split across stream chunks", async () => {
  const counts = await authUserCounts({
    toc: TOC,
    dumpPath: "dump.backup",
    pgRestore: "pg_restore",
    spawnImpl: fakeSpawn({ users: USERS_COPY, identities: IDENTITIES_COPY }),
  });
  assert.deepEqual(counts, { users: 3, withPassword: 2, identities: 3 });
});

test("LastGood's storage login is never counted as one of the app's users, nor its sign-in identity", async () => {
  const users = USERS_COPY.replace("\\.", `\\N\tu9\t${STORAGE_LOGIN_EMAIL}\t$2a$10$login-hash\t{}\n\\.`);
  const identities = IDENTITIES_COPY.replace("\\.", "i9\tu9\temail\n\\.");
  assert.ok(users.includes(STORAGE_LOGIN_EMAIL) && identities.includes("i9"));
  const counts = await authUserCounts({ toc: TOC, dumpPath: "d", pgRestore: "pg_restore", spawnImpl: fakeSpawn({ users, identities }) });
  assert.deepEqual(counts, { users: 3, withPassword: 2, identities: 3 });
  // The address is the one setup makes.
  const setup = readFileSync(path.join(import.meta.dirname, "..", "..", "lib", "supabase", "storage-login.ts"), "utf8");
  assert.ok(setup.includes(`export const STORAGE_LOGIN_EMAIL = "${STORAGE_LOGIN_EMAIL}";`));
});

test("a database without Supabase Auth gives no counts, and auth.users without its rows is an error", async () => {
  assert.equal(await authUserCounts({ toc: "224; 1259 1 TABLE public notes postgres\n", dumpPath: "d", pgRestore: "x" }), null);
  // Someone's own auth.users table, without Supabase's password column, is not Supabase Auth.
  const own = await authUserCounts({
    toc: TOC,
    dumpPath: "d",
    pgRestore: "x",
    spawnImpl: fakeSpawn({ users: "COPY auth.users (id, name) FROM stdin;\n1\tx\n\\.\n" }),
  });
  assert.equal(own, null);
  await assert.rejects(
    authUserCounts({ toc: "230; 1259 1 TABLE auth users supabase_auth_admin\n", dumpPath: "d", pgRestore: "x" }),
    /none of its rows/,
  );
});

// Vault's secrets and pg_cron's jobs live in their extensions' own schemas, with no TABLE entry of their own.
const EXTENSION_TOC = `;
6; 3079 16388 EXTENSION - supabase_vault postgres
3; 3079 16385 EXTENSION - pg_cron postgres
4268; 0 17467 TABLE DATA public notes postgres
4280; 0 17600 TABLE DATA vault secrets supabase_admin
4281; 0 17610 TABLE DATA cron job supabase_admin
4282; 0 17620 TABLE DATA cron job_run_details supabase_admin
4283; 0 17630 TABLE DATA cron Odd Name supabase_admin
`;

test("tables left out with an extension are counted per extension, and their rows never leave the counter", async () => {
  const skipped = { extensions: ["pg_cron", "supabase_vault", "not_listed"] };
  const shape = ({ extension, schema, table, plain }) => ({ extension, schema, table, plain });
  assert.deepEqual(skippedTables(EXTENSION_TOC, skipped).map(shape), [
    { extension: "supabase_vault", schema: "vault", table: "secrets", plain: true },
    { extension: "pg_cron", schema: "cron", table: "job", plain: true },
    { extension: "pg_cron", schema: "cron", table: "job_run_details", plain: true },
    // pg_restore prints names unquoted, so a name with a space is read from the dump's COPY line instead.
    { extension: "pg_cron", schema: "cron", table: "Odd Name", plain: false },
  ]);
  assert.deepEqual(skippedTables(EXTENSION_TOC, { extensions: [] }), []);

  const asked = [];
  const outputs = {
    secrets: "COPY vault.secrets (id, name, secret) FROM stdin;\nv1\tstripe\tnot-a-real-secret\nv2\tresend\tnot-a-real-secret\n\\.\n",
    job: "COPY cron.job (jobid, schedule, command) FROM stdin;\n1\t0 3 * * *\tSELECT 1\n\\.\n",
    job_run_details: "COPY cron.job_run_details (runid) FROM stdin;\n\\.\n",
  };
  const answer = fakeSpawn(outputs);
  const spawnImpl = (command, args) => {
    if (args.includes("-L")) {
      asked.push(`list: ${readFileSync(args[args.indexOf("-L") + 1], "utf8").trim()}`);
      return fakeSpawn({ "": 'SET client_encoding = \'UTF8\';\nCOPY cron."Odd Name" (id) FROM stdin;\n7\n\\.\n' })(command, ["-t", ""]);
    }
    asked.push(`${args[args.indexOf("-n") + 1]}.${args[args.indexOf("-t") + 1]}`);
    return answer(command, args);
  };
  // The lines go to a log the test holds; replacing process.stdout.write would swallow the test runner's own report.
  const lines = [];
  const totals = await skippedTableCounts({
    toc: EXTENSION_TOC,
    skipped,
    dumpPath: "d",
    pgRestore: "pg_restore",
    spawnImpl,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(asked, ["vault.secrets", "cron.job", "cron.job_run_details", "list: 4283; 0 17630 TABLE DATA cron Odd Name supabase_admin"]);
  assert.deepEqual(totals, [
    { extension: "pg_cron", tables: 3, rows: 2 },
    { extension: "supabase_vault", tables: 1, rows: 2 },
  ]);
  assert.match(lines.join(""), /Not checked by this test restore: vault\.secrets \(2 rows in the dump\), because this database does not offer supabase_vault\./);
  assert.match(lines.join(""), /Not checked by this test restore: cron\."Odd Name" \(1 rows in the dump\), because this database does not offer pg_cron\./);
  assert.doesNotMatch(lines.join(""), /not-a-real-secret|stripe/);
});

/** A psql that answers the restored-table query with these lines, and keeps each query it was asked. */
function fakePsql(queries, answer) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(answer(queries.length)));
      child.emit("close", 0);
    });
    return child;
  };
}

test("COPY blocks are counted by the quoted name pg_dump wrote, even when a line break splits the header", () => {
  const counter = copyBlocks();
  const stream = [
    "SET client_encoding = 'UTF8';",
    'COPY "My Schema".plain (x) FROM stdin;',
    "a",
    "\\.",
    'COPY public."we""ird.na me" (id) FROM stdin;',
    "5",
    "6",
    "\\.",
    'COPY public."two',
    'lines" (id) FROM stdin;',
    "1",
    "\\.",
    "SELECT pg_catalog.setval('public.seq', 3, true);",
  ];
  for (const line of stream) counter.line(line);
  assert.deepEqual(counter.result(), [
    { name: '"My Schema".plain', schema: "My Schema", rows: 1 },
    { name: 'public."we""ird.na me"', schema: "public", rows: 2 },
    { name: 'public."two\nlines"', schema: "public", rows: 1 },
  ]);
});

test("a table the list loaded that is missing afterwards, or empty while the dump has rows, is counted under other", async () => {
  // The list as filtered: Vault's data commented out, the rest loaded. pgaudit_log stands for a table an extension
  // outside the action's list owns, whose load failed with only a warning; drafts loaded without its rows.
  const list = `;
4268; 0 17467 TABLE DATA public notes postgres
;4280; 0 17600 TABLE DATA vault secrets supabase_admin
4290; 0 17700 TABLE DATA audit pgaudit_log postgres
4291; 0 17710 TABLE DATA public Odd Name postgres
4292; 0 17720 TABLE DATA public drafts postgres
4293; 0 17730 TABLE DATA public empty postgres
`;
  const queries = [];
  const lists = [];
  const psql = fakePsql(queries, () => "0 rows\n1 missing\n2 empty\n3 empty\n4 empty\n");
  const dump = fakeSpawn({
    pgaudit_log: "COPY audit.pgaudit_log (id, entry) FROM stdin;\n1\tsecret-ish\n2\tmore\n3\tthird\n\\.\n",
    drafts: "COPY public.drafts (id) FROM stdin;\n1\n2\n\\.\n",
    empty: "COPY public.empty (id) FROM stdin;\n\\.\n",
  });
  const spawnImpl = (command, args) => {
    if (command === "psql") {
      queries.push(args[args.indexOf("--command") + 1]);
      return psql();
    }
    if (args.includes("-L")) {
      lists.push(readFileSync(args[args.indexOf("-L") + 1], "utf8").trim());
      return fakeSpawn({ "": 'COPY public."Odd Name" (id) FROM stdin;\n1\n2\n\\.\n' })(command, ["-t", ""]);
    }
    return dump(command, args);
  };
  const lines = [];
  const totals = await skippedTableCounts({
    toc: EXTENSION_TOC,
    skipped: { extensions: [] },
    list,
    dumpPath: "d",
    pgRestore: "pg_restore",
    psql: "psql",
    databaseUrl: "postgres://localhost/restore",
    spawnImpl,
    log: (line) => lines.push(line),
  });
  // Only the odd name's own line goes to pg_restore, so it picks the entry by dump ID.
  assert.deepEqual(lists, ["4291; 0 17710 TABLE DATA public Odd Name postgres"]);
  assert.equal(queries.length, 1);
  const hex = (text) => Buffer.from(text).toString("hex");
  for (const name of ['"public"."notes"', '"audit"."pgaudit_log"', '"public"."drafts"', 'public."Odd Name"']) {
    assert.ok(queries[0].includes(hex(name)), name);
  }
  // Names reach the query only as hex, so nothing from the dump is run as SQL.
  assert.doesNotMatch(queries[0], /pgaudit_log|Odd Name|drafts/);
  assert.deepEqual(totals, [{ extension: OTHER_EXTENSION, tables: 3, rows: 7 }]);
  const logged = lines.join("");
  assert.match(logged, /Not checked by this test restore: audit\.pgaudit_log \(3 rows in the dump\), because it did not load, most likely for an extension this database does not offer\./);
  assert.match(logged, /Not checked by this test restore: public\.drafts \(2 rows in the dump\), because its rows did not load\./);
  assert.match(logged, /Not checked by this test restore: public\."Odd Name" \(2 rows in the dump\), because its rows did not load\./);
  assert.doesNotMatch(logged, /public\.empty|public\.notes|secret-ish/);
});

test("an odd-named table pg_restore gives no COPY block for is still counted, so nothing falls through", async () => {
  const list = "4291; 0 17710 TABLE DATA public Odd Name postgres\n";
  const spawnImpl = (command, args) =>
    command === "psql" ? fakePsql([], () => "")() : fakeSpawn({})(command, args.includes("-L") ? [] : args);
  const lines = [];
  const totals = await skippedTableCounts({
    toc: list,
    skipped: { extensions: [] },
    list,
    dumpPath: "d",
    pgRestore: "pg_restore",
    psql: "psql",
    databaseUrl: "postgres://localhost/restore",
    spawnImpl,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(totals, [{ extension: OTHER_EXTENSION, tables: 1, rows: 0 }]);
  assert.match(lines.join(""), /a table whose name could not be read from the dump, because it could not be checked/);
});

test("the restored-table check asks in batches small enough for one psql argument, and keeps the order", async () => {
  // The longest names Postgres allows, every character a quote, so each doubles when quoted.
  const longest = `"${'""'.repeat(63)}"`;
  const names = Array.from({ length: 250 }, () => `${longest}.${longest}`);
  const queries = [];
  const psql = fakePsql(queries, (count) => (count === 3 ? "49 missing\n" : count === 2 ? "0 empty\n" : ""));
  const spawnImpl = (_command, args) => {
    queries.push(args[args.indexOf("--command") + 1]);
    return psql();
  };
  const states = await restoredTables(names, { psql: "psql", databaseUrl: "postgres://localhost/restore", spawnImpl });
  assert.equal(queries.length, 3);
  assert.ok(queries.every((query) => query.length < 64 * 1024), String(Math.max(...queries.map((query) => query.length))));
  assert.equal(states.length, 250);
  assert.equal(states[100], "empty");
  assert.equal(states[249], "missing");
  assert.equal(states.filter((state) => state === "rows").length, 248);
});

test("the restore check compares each count with the dump", async () => {
  const answers = { users: "3", withPassword: "2", identities: "3" };
  const spawnImpl = (command, args) => {
    if (command === "pg_restore") return fakeSpawn({ users: USERS_COPY, identities: IDENTITIES_COPY })(command, args);
    const sql = args[args.indexOf("--command") + 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const key = sql.includes("identities") ? "identities" : sql.includes("encrypted_password") ? "withPassword" : "users";
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(`${answers[key]}\n`));
      child.emit("close", 0);
    });
    return child;
  };
  const options = { toc: TOC, dumpPath: "d", pgRestore: "pg_restore", psql: "psql", databaseUrl: "postgresql://x", spawnImpl };
  assert.deepEqual(await verifyAuthUsers(options), { users: 3, withPassword: 2, identities: 3 });
  answers.identities = "1";
  await assert.rejects(verifyAuthUsers(options), /the dump has 3 sign-in identities, the test restore has 1/);
  // The restored database is counted the same way, without the storage login.
  answers.identities = "3";
  const asked = [];
  const askedSpawn = (command, args) => {
    if (command !== "pg_restore") asked.push(args[args.indexOf("--command") + 1]);
    return spawnImpl(command, args);
  };
  await verifyAuthUsers({ ...options, spawnImpl: askedSpawn });
  assert.equal(asked.length, 3);
  for (const sql of asked) assert.ok(sql.includes(STORAGE_LOGIN_EMAIL), sql);
});

function fakeTools(dir, toc) {
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  writeFileSync(path.join(dir, "toc.txt"), toc);
  writeFileSync(path.join(dir, "copy.users"), USERS_COPY);
  writeFileSync(path.join(dir, "copy.identities"), IDENTITIES_COPY);
  const scripts = {
    pg_dump: `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then printf 'dump' > "$2"; exit 0; fi
  shift
done
exit 1
`,
    pg_restore: `#!/bin/sh
table=""
prev=""
for arg in "$@"; do
  [ "$arg" = "--list" ] && { cat "${dir}/toc.txt"; exit 0; }
  [ "$prev" = "-t" ] && table="$arg"
  prev="$arg"
done
cat "${dir}/copy.$table"
`,
    aws: `#!/bin/sh
case " $* " in
  *" s3api "*) printf '%s\\n' '{"Contents":[]}' ;;
  *" s3 cp "*)
    for last; do :; done
    touch "${uploads}/$(basename "$last")"
    ;;
esac
exit 0
`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(path.join(dir, name), body);
    chmodSync(path.join(dir, name), 0o755);
  }
  return uploads;
}

async function backup(toc) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-users-"));
  const uploads = fakeTools(dir, toc);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const checkins = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      checkins.push(JSON.parse(body));
      response.writeHead(202).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("bash", [RUN], {
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          LIFEBOAT_MODE: "backup",
          DATABASE_URL: "postgres://example.invalid/db",
          S3_BUCKET: "bucket",
          S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
          S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
          LIFEBOAT_ENCRYPT: "false",
          LIFEBOAT_MANAGE_RETENTION: "false",
          LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
          CHECKIN_SECRET: "unit-test-checkin-secret",
          CHECKIN_URL: `http://127.0.0.1:${server.address().port}/checkin`,
          LIFEBOAT_WORKDIR: work,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    return { ...result, uploads, checkins, work };
  } finally {
    server.close();
  }
}

test("a backup reports its users on their own line and in the check-in, and never prints one", async () => {
  const run = await backup(TOC);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Users: 3 accounts, 2 with a password, 3 sign-in identities\./);
  assert.doesNotMatch(run.stdout + run.stderr, /users\.test|\$2a\$/);
  assert.equal(run.checkins[0].authUsers, 3);
  assert.equal(run.checkins[0].authUsersWithPassword, 2);
  assert.equal(run.checkins[0].authIdentities, 3);
  assert.equal(existsSync(path.join(run.work, "backup.toc")), false);
});

test("auth.users without its rows fails the run after the copies are up", async () => {
  const run = await backup("230; 1259 17500 TABLE auth users supabase_auth_admin\n");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /none of its rows.*Everything else this run copies was uploaded first\./);
  assert.equal(readdirSync(run.uploads).length, 1, "the database copy still went up");
  assert.equal(run.checkins[0].ok, false);
  assert.equal(run.checkins[0].authUsers, null);
});
