import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUN = path.join(ROOT, "scripts", "run.sh");

test("the runner encrypts with openssl and does not delete when retention is off", () => {
  const source = readFileSync(RUN, "utf8");
  assert.match(source, /openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:LIFEBOAT_ENCRYPTION_PASSPHRASE/);
  assert.match(source, /\.backup\.enc/);
  assert.match(source, /MANAGE_RETENTION" != "true"/);
  assert.match(source, /::add-mask::/);
  assert.match(source, /mask "\$\{DATABASE_URL:-\}"/);
  assert.match(source, /mask "\$\{LIFEBOAT_ENCRYPTION_PASSPHRASE:-\}"/);
  assert.match(source, /mask "\$\{CHECKIN_SECRET:-\}"/);
  assert.match(source, /"\$PG_DUMP" "\$DATABASE_URL" --format=custom --no-owner --no-acl/);
  assert.match(source, /--no-acl --lock-wait-timeout=10min --file/);
  assert.match(source, /\/usr\/lib\/postgresql\/\$\{POSTGRES_MAJOR:-17\}\/bin/);
  assert.match(source, /cannot read Postgres/);
  assert.doesNotMatch(source, /psql "\$DATABASE_URL"/);
  assert.match(source, /"\$PG_RESTORE" --dbname "\$RESTORE_DATABASE_URL"/);
  assert.match(source, /-L "\$WORKDIR\/restore\.list"/);
  assert.match(source, /rm -f "\$WORKDIR\/restore\.download"/);
  assert.match(source, /restore-list\.mjs/);
  assert.match(source, /Refusing to restore into DATABASE_URL/);
  assert.match(source, /value_or "\$\{S3_ENDPOINT:-}" "https:\/\/s3\.ap-southeast-2\.wasabisys\.com"/);
});

test("openssl aes-256-cbc pbkdf2 round-trips with the env passphrase", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-enc-"));
  const plain = path.join(dir, "dump.backup");
  const enc = path.join(dir, "dump.backup.enc");
  const out = path.join(dir, "out.backup");
  writeFileSync(plain, "rows-stay-here");
  const env = { ...process.env, LIFEBOAT_ENCRYPTION_PASSPHRASE: "correct horse battery" };
  const flags = ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:LIFEBOAT_ENCRYPTION_PASSPHRASE"];
  execFileSync("openssl", [...flags, "-in", plain, "-out", enc], { env });
  execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:LIFEBOAT_ENCRYPTION_PASSPHRASE", "-in", enc, "-out", out], { env });
  assert.equal(readFileSync(out, "utf8"), "rows-stay-here");
});

function fakes(dir) {
  const awsLog = path.join(dir, "aws.log");
  const uploads = path.join(dir, "uploads");
  mkdirSync(uploads);
  const pg = path.join(dir, "pg_dump");
  const aws = path.join(dir, "aws");
  writeFileSync(
    pg,
    `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then
    printf 'dump' > "$2"
    exit 0
  fi
  shift
done
exit 1
`,
  );
  writeFileSync(
    aws,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${awsLog}"
case " $* " in
  *" s3api "*)
    printf '%s\\n' '{"Contents":[{"Key":"lifeboat/db/old.backup","LastModified":"2020-01-01T00:00:00.000Z"}]}'
    ;;
  *" s3 cp "*)
    # Keep what would have been uploaded, named after its object key.
    for last; do :; done
    src=""
    prev=""
    for arg in "$@"; do
      [ "$arg" = "$last" ] && src="$prev"
      prev="$arg"
    done
    cp "$src" "${uploads}/$(basename "$last")"
    ;;
esac
exit 0
`,
  );
  // The users check lists the dump. This one has no Supabase Auth tables.
  const pgRestore = path.join(dir, "pg_restore");
  writeFileSync(pgRestore, "#!/bin/sh\nexit 0\n");
  chmodSync(pgRestore, 0o755);
  chmodSync(pg, 0o755);
  chmodSync(aws, 0o755);
  writeFileSync(awsLog, "");
  return awsLog;
}

function runBackup(extra) {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-run-"));
  const awsLog = fakes(dir);
  const work = path.join(dir, "work");
  mkdirSync(work);
  const result = spawnSync("bash", [RUN], {
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      LIFEBOAT_MODE: "backup",
      DATABASE_URL: "postgres://example.invalid/db",
      S3_BUCKET: "lastgood-backups-ap-southeast-2",
      S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3_SECRET_ACCESS_KEY: "unit-test-secret-not-real",
      S3_ENDPOINT: "",
      S3_REGION: "",
      S3_PREFIX: "",
      CHECKIN_SECRET: "",
      LIFEBOAT_WORKDIR: work,
      ...extra,
    },
    encoding: "utf8",
  });
  const log = readFileSync(awsLog, "utf8");
  const uploads = path.join(dir, "uploads");
  return { result, log, uploads, files: readdirSync(uploads) };
}

test("a direct Supabase host fails before pg_dump and does not print the URL", () => {
  const password = "pooler-password-must-stay-hidden";
  const ref = "abcdefghijklmnopqrst";
  const { result, log } = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    DATABASE_URL: `postgresql://lifeboat_reader:${password}@db.${ref}.supabase.co:5432/postgres`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IPv6-only/);
  assert.match(result.stderr, /Session pooler/);
  assert.match(result.stderr, /6543/);
  assert.equal(log, "");
  assert.doesNotMatch(result.stderr, new RegExp(password));
  assert.doesNotMatch(result.stderr, new RegExp(ref));

  const pooler = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    DATABASE_URL: `postgresql://lifeboat_reader.${ref}:${password}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`,
  });
  assert.equal(pooler.result.status, 0, pooler.result.stderr);
  assert.doesNotMatch(pooler.result.stderr, new RegExp(password));

  const missingRef = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    DATABASE_URL: `postgresql://lastgood_backup:${password}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`,
  });
  assert.notEqual(missingRef.result.status, 0);
  assert.match(missingRef.result.stderr, /project ref/);
  assert.match(missingRef.result.stderr, /lastgood_backup\.<project-ref>/);
  assert.equal(missingRef.log, "");
  assert.doesNotMatch(missingRef.result.stderr, new RegExp(password));
  assert.doesNotMatch(missingRef.result.stderr, /aws-0-ap-southeast-2/);

  const encoded = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    DATABASE_URL: `postgresql://lastgood_backup%2E${ref}:${password}@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  });
  assert.equal(encoded.result.status, 0, encoded.result.stderr);
  assert.doesNotMatch(encoded.result.stderr, new RegExp(password));
});

test("a newer server fails before upload and the versioned client is preferred", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-pg-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const marker = path.join(dir, "used-path-dump");
  writeFileSync(
    path.join(bin, "pg_dump"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' "pg_dump (PostgreSQL) 16.15"
  exit 0
fi
printf '%s\\n' "versioned" > "${marker}"
exit 1
`,
  );
  writeFileSync(
    path.join(bin, "pg_restore"),
    "#!/bin/sh\nexit 0\n",
  );
  writeFileSync(
    path.join(bin, "psql"),
    "#!/bin/sh\nprintf '%s\\n' 170006\nexit 0\n",
  );
  chmodSync(path.join(bin, "pg_dump"), 0o755);
  chmodSync(path.join(bin, "pg_restore"), 0o755);
  chmodSync(path.join(bin, "psql"), 0o755);
  const password = "version-password-must-stay-hidden";
  const { result, log } = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    LIFEBOAT_PG_BIN: bin,
    POSTGRES_MAJOR: "16",
    DATABASE_URL: `postgresql://lastgood_backup.abcdefghijklmnopqrst:${password}@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pg_dump 16 cannot read Postgres 17/);
  assert.match(result.stderr, /\/usr\/lib\/postgresql\/17\/bin\/pg_dump/);
  assert.equal(log, "");
  assert.doesNotMatch(result.stderr, new RegExp(password));
  assert.equal(existsSync(marker), false);

  const action = readFileSync(path.join(ROOT, "action.yml"), "utf8");
  assert.match(action, /\/usr\/lib\/postgresql\/\$\{major\}\/bin/);
  assert.match(action, /GITHUB_PATH/);
  assert.match(action, /POSTGRES_MAJOR: \$\{\{ inputs\.postgres-major \}\}/);
});

test("an empty passphrase fails before upload", () => {
  const { result, log } = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_ENCRYPTION_PASSPHRASE: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIFEBOAT_ENCRYPTION_PASSPHRASE/);
  assert.equal(log, "");
  assert.doesNotMatch(result.stderr, /unit-test-secret-not-real/);
});

test("empty destination vars use Sydney and hosted mode does not delete", () => {
  const byo = runBackup({
    LIFEBOAT_ENCRYPT: "false",
    LIFEBOAT_MANAGE_RETENTION: "",
  });
  assert.equal(byo.result.status, 0, byo.result.stderr);
  assert.match(byo.log, /--endpoint-url https:\/\/s3\.ap-southeast-2\.wasabisys\.com/);
  assert.match(byo.log, /\/lifeboat\/db\/.*\.backup$/m);
  assert.match(byo.log, /s3 rm/);

  const hosted = runBackup({
    LIFEBOAT_ENCRYPT: "true",
    LIFEBOAT_ENCRYPTION_PASSPHRASE: "keep-this-local",
    LIFEBOAT_MANAGE_RETENTION: "false",
    S3_ENDPOINT: "https://s3.eu-central-2.wasabisys.com",
    S3_REGION: "eu-central-2",
    S3_PREFIX: "cus_abc/app",
  });
  assert.equal(hosted.result.status, 0, hosted.result.stderr);
  assert.match(hosted.log, /--endpoint-url https:\/\/s3\.eu-central-2\.wasabisys\.com/);
  assert.match(hosted.log, /\.backup\.enc/);
  assert.doesNotMatch(hosted.log, /dump\.backup"/);
  assert.doesNotMatch(hosted.log, /s3 rm/);
  assert.doesNotMatch(hosted.log, /keep-this-local/);
  assert.match(hosted.result.stdout, /::add-mask::/);
  assert.doesNotMatch(hosted.result.stderr, /keep-this-local/);
  assert.doesNotMatch(hosted.result.stderr, /unit-test-secret-not-real/);
});

function keyPair() {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-key-"));
  const keyFile = path.join(dir, "key.txt");
  execFileSync("age-keygen", ["-o", keyFile], { stdio: "ignore" });
  const privateKey = readFileSync(keyFile, "utf8").split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-1"));
  const publicKey = execFileSync("age-keygen", ["-y", keyFile], { encoding: "utf8" }).trim();
  return { keyFile, privateKey, publicKey };
}

function openCopy(file, keyFile) {
  return execFileSync("age", ["--decrypt", "--identity", keyFile, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function printed(result) {
  return `${result.stdout}${result.stderr}`
    .split("\n")
    .filter((line) => !line.startsWith("::add-mask::"))
    .join("\n");
}

test("the action installs age and passes both halves of the key pair", () => {
  const action = readFileSync(path.join(ROOT, "action.yml"), "utf8");
  assert.match(action, /^  public-key:$/m);
  assert.match(action, /^  private-key:$/m);
  assert.match(action, /LIFEBOAT_PUBLIC_KEY: \$\{\{ inputs\.public-key \}\}/);
  assert.match(action, /LIFEBOAT_PRIVATE_KEY: \$\{\{ inputs\.private-key \}\}/);
  assert.match(action, /- name: Install age/);
  assert.match(action, /sudo apt-get install -y age/);
  const template = readFileSync(path.join(ROOT, "templates", "lifeboat.yml"), "utf8");
  assert.equal(template.match(/public-key: \$\{\{ vars\.LIFEBOAT_PUBLIC_KEY \}\}/g)?.length, 2);
  assert.equal(template.match(/private-key: \$\{\{ secrets\.LIFEBOAT_PRIVATE_KEY \}\}/g)?.length, 2);
  const source = readFileSync(RUN, "utf8");
  assert.match(source, /mask "\$\{LIFEBOAT_PRIVATE_KEY:-\}"/);
});

test("with a public key, the copy is age-encrypted and opens only with its private key", () => {
  const pair = keyPair();
  const { result, files, uploads } = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PUBLIC_KEY: pair.publicKey });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}T\d{6}Z\.backup\.age$/);
  const copy = path.join(uploads, files[0]);
  assert.notEqual(readFileSync(copy, "utf8"), "dump");
  assert.equal(openCopy(copy, pair.keyFile), "dump");
  const other = keyPair();
  assert.throws(() => openCopy(copy, other.keyFile));
  assert.doesNotMatch(result.stdout, /older passphrase/);
});

test("the private key alone is enough: its public half is worked out on the runner", () => {
  const pair = keyPair();
  const { result, files, uploads, log } = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: pair.privateKey });
  assert.equal(result.status, 0, result.stderr);
  assert.match(files[0], /\.backup\.age$/);
  assert.equal(openCopy(path.join(uploads, files[0]), pair.keyFile), "dump");
  assert.match(result.stdout, new RegExp(`::add-mask::${pair.privateKey}`));
  assert.doesNotMatch(printed(result), new RegExp(pair.privateKey));
  assert.doesNotMatch(log, new RegExp(pair.privateKey));
});

test("a key pair beats the older passphrase, so moving over needs no other change", () => {
  const pair = keyPair();
  const { result, files } = runBackup({
    LIFEBOAT_ENCRYPT: "true",
    LIFEBOAT_PUBLIC_KEY: pair.publicKey,
    LIFEBOAT_PRIVATE_KEY: pair.privateKey,
    LIFEBOAT_ENCRYPTION_PASSPHRASE: "older-passphrase-here",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(files[0], /\.backup\.age$/);
});

test("halves of two different key pairs fail before the dump and upload nothing", () => {
  const pair = keyPair();
  const other = keyPair();
  const { result, files, log } = runBackup({
    LIFEBOAT_ENCRYPT: "true",
    LIFEBOAT_PUBLIC_KEY: other.publicKey,
    LIFEBOAT_PRIVATE_KEY: pair.privateKey,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not one key pair/);
  assert.match(result.stderr, /Nothing was uploaded/);
  assert.deepEqual(files, []);
  assert.equal(log, "");
  assert.doesNotMatch(printed(result), new RegExp(pair.privateKey));
});

test("a malformed key fails before upload and is not printed", () => {
  const badPublic = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PUBLIC_KEY: "age1notarealkey" });
  assert.notEqual(badPublic.result.status, 0);
  assert.match(badPublic.result.stderr, /LIFEBOAT_PUBLIC_KEY is not an age public key/);
  assert.deepEqual(badPublic.files, []);

  const secret = "AGE-SECRET-KEY-1-THIS-IS-NOT-A-KEY";
  const badPrivate = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_PRIVATE_KEY: secret });
  assert.notEqual(badPrivate.result.status, 0);
  assert.match(badPrivate.result.stderr, /LIFEBOAT_PRIVATE_KEY is not an age private key/);
  assert.deepEqual(badPrivate.files, []);
  assert.doesNotMatch(printed(badPrivate.result), new RegExp(secret));
});

test("without a key pair the older passphrase still encrypts, and the log says to move over", () => {
  const { result, files } = runBackup({ LIFEBOAT_ENCRYPT: "true", LIFEBOAT_ENCRYPTION_PASSPHRASE: "older-passphrase-here" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(files[0], /\.backup\.enc$/);
  assert.match(result.stdout, /older passphrase encryption, which cannot detect a changed copy/);
});
