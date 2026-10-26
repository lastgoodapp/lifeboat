import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { keyFromText, moveIntoPlace, normalSha256, openedPath, restoreCopy, RestoreError } from "../lib/restore.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "lastgood.mjs");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function plain(length, seed) {
  return Buffer.from(Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251));
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A folder holding a real copy of about 200 KB (more than three of age's 64 KiB chunks), its key file and its record. */
async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "lastgood-cli-"));
  dirs.push(dir);
  const key = await generateX25519Identity();
  const recipient = await identityToRecipient(key);
  const seal = async (body) => {
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    return Buffer.from(await encrypter.encrypt(body));
  };
  const body = plain(200_000, 7);
  const sealed = await seal(body);
  const copy = path.join(dir, "acme-notes-database-20261017T000000Z.backup.age");
  writeFileSync(copy, sealed);
  const keyFile = path.join(dir, "lastgood-key-acme-notes.txt");
  writeFileSync(keyFile, `# LastGood key for acme/notes, made in your browser.\n# public key: ${recipient}\n${key}\n`);
  return { dir, key, recipient, seal, body, sealed, copy, keyFile, recorded: sha(sealed) };
}

function leftovers(dir) {
  return readdirSync(dir).filter((name) => !name.endsWith(".age") && !name.endsWith(".txt") && !name.endsWith(".enc"));
}

describe("reading the key and the record", () => {
  it("takes the key file or the key alone, and refuses anything else", async () => {
    const key = await generateX25519Identity();
    assert.equal(keyFromText(`# comment\n${key}\n`), key);
    assert.equal(keyFromText(`  ${key}\r\n`), key);
    assert.equal(keyFromText(""), null);
    assert.equal(keyFromText(await identityToRecipient(key)), null);
    assert.equal(keyFromText(`${key}\n${await generateX25519Identity()}`), null);
  });

  it("takes a SHA-256 in either case, and nothing shorter or longer", () => {
    assert.equal(normalSha256("AB".repeat(32)), "ab".repeat(32));
    assert.equal(normalSha256(" " + "a".repeat(64) + "\n"), "a".repeat(64));
    for (const value of ["", "a".repeat(63), "a".repeat(65), "g".repeat(64), null]) assert.equal(normalSha256(value), null);
  });

  it("names the opened copy after the copy, without .age", () => {
    assert.equal(openedPath("/x/acme-notes-code-20261017T000000Z.tar.gz.age"), "/x/acme-notes-code-20261017T000000Z.tar.gz");
    assert.equal(openedPath("copy.AGE"), "copy");
    assert.equal(openedPath("/x/.age"), "/x/.age.opened");
    assert.equal(openedPath("copy.backup"), "copy.backup.opened");
  });
});

describe("opening a copy", () => {
  it("opens a copy that matches its record to the original bytes", async () => {
    const { copy, key, recorded, body } = await setup();
    const result = await restoreCopy({ copy, key, sha256: recorded.toUpperCase() });
    assert.deepEqual(result, { out: copy.slice(0, -4), sha256: recorded, checked: true });
    assert.deepEqual(readFileSync(result.out), body);
  });

  it("refuses a different copy made with the same public key, and leaves nothing behind", async () => {
    const { dir, copy, key, recorded, seal } = await setup();
    // Anyone with the public key can make a copy the key opens; only the record tells them apart (D18).
    writeFileSync(copy, await seal(plain(200_000, 8)));
    await assert.rejects(restoreCopy({ copy, key, sha256: recorded }), (error) => error instanceof RestoreError && /not the .* your backup recorded/.test(error.message));
    assert.deepEqual(leftovers(dir), []);
  });

  it("needs the recorded SHA-256, or --unchecked to open without one", async () => {
    const { copy, key, body, recorded } = await setup();
    await assert.rejects(restoreCopy({ copy, key }), /--sha256/);
    await assert.rejects(restoreCopy({ copy, key, sha256: "abc" }), /64-character/);
    const result = await restoreCopy({ copy, key, unchecked: true });
    assert.deepEqual(result, { out: copy.slice(0, -4), sha256: recorded, checked: false });
    assert.deepEqual(readFileSync(result.out), body);
  });

  it("says when the key does not open the copy, and leaves nothing behind", async () => {
    const { dir, copy, recorded } = await setup();
    await assert.rejects(restoreCopy({ copy, key: await generateX25519Identity(), sha256: recorded }), /does not open/);
    assert.deepEqual(leftovers(dir), []);
  });

  it("leaves nothing behind when a copy fails part way through", async () => {
    const { dir, copy, key, sealed } = await setup();
    const cut = sealed.subarray(0, sealed.length - 1000);
    writeFileSync(copy, cut);
    await assert.rejects(restoreCopy({ copy, key, sha256: sha(cut) }), /could not be opened, and nothing was saved/);
    assert.deepEqual(leftovers(dir), []);
  });

  it("points a passphrase copy to OpenSSL", async () => {
    const { dir, key } = await setup();
    const copy = path.join(dir, "acme-notes-database-20261001T000000Z.backup.enc");
    const bytes = Buffer.from("Salted__" + "x".repeat(100));
    writeFileSync(copy, bytes);
    await assert.rejects(restoreCopy({ copy, key, sha256: sha(bytes) }), /openssl enc -d -aes-256-cbc -pbkdf2/);
  });

  it("never replaces a file that appears after the first check, and cleans up the part-written copy", async () => {
    const { dir } = await setup();
    const partial = path.join(dir, "opened.backup.partial");
    const out = path.join(dir, "opened.backup");
    writeFileSync(partial, "opened bytes");
    await moveIntoPlace(partial, out);
    assert.equal(readFileSync(out, "utf8"), "opened bytes");
    assert.equal(existsSync(partial), false);
    // Something else writes the name between the overwrite check and the move.
    writeFileSync(partial, "second copy");
    writeFileSync(out, "theirs");
    await assert.rejects(moveIntoPlace(partial, out), (error) => error instanceof RestoreError && /already exists/.test(error.message));
    assert.equal(readFileSync(out, "utf8"), "theirs");
    assert.equal(existsSync(partial), false);
  });

  it("never writes over an existing file", async () => {
    const { copy, key, recorded } = await setup();
    writeFileSync(copy.slice(0, -4), "keep me");
    await assert.rejects(restoreCopy({ copy, key, sha256: recorded }), /already exists/);
    assert.equal(readFileSync(copy.slice(0, -4), "utf8"), "keep me");
  });
});

describe("the lastgood command", () => {
  function run(args, input) {
    return spawnSync(process.execPath, [BIN, ...args], { input, encoding: "utf8" });
  }

  it("opens a copy with the key file, or with the key on standard input", async () => {
    const { dir, copy, keyFile, key, recorded, body } = await setup();
    const fromFile = run(["restore", copy, "--key", keyFile, "--sha256", recorded]);
    assert.equal(fromFile.status, 0, fromFile.stderr);
    assert.match(fromFile.stdout, /matches the SHA-256 your backup recorded/);
    assert.deepEqual(readFileSync(copy.slice(0, -4)), body);
    const out = path.join(dir, "from-stdin.backup");
    const fromStdin = run(["restore", copy, "--key", "-", "--sha256", recorded, "--out", out], `${key}\n`);
    assert.equal(fromStdin.status, 0, fromStdin.stderr);
    assert.deepEqual(readFileSync(out), body);
  });

  it("exits 1 on a refused copy or a bad key, and 2 on a usage mistake", async () => {
    const { dir, copy, keyFile } = await setup();
    const mismatch = run(["restore", copy, "--key", keyFile, "--sha256", "0".repeat(64)]);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /was not opened/);
    const notKey = path.join(dir, "not-a-key.txt");
    writeFileSync(notKey, "hello\n");
    assert.equal(run(["restore", copy, "--key", notKey, "--unchecked"]).status, 1);
    assert.equal(run(["restore", copy, "--key", path.join(dir, "missing.txt"), "--unchecked"]).status, 1);
    assert.equal(run(["restore", copy]).status, 2);
    assert.equal(run(["open", copy, "--key", keyFile]).status, 2);
    assert.equal(run(["restore", copy, "--key", keyFile, "--nope"]).status, 2);
    assert.equal(existsSync(copy.slice(0, -4)), false);
    const unchecked = run(["restore", copy, "--key", keyFile, "--unchecked", "--out", path.join(dir, "unchecked.backup")]);
    assert.equal(unchecked.status, 0, unchecked.stderr);
    assert.match(unchecked.stderr, /^Warning: this copy was not checked against any record/);
    assert.match(unchecked.stderr, new RegExp(`Its SHA-256 is ${sha(readFileSync(copy))}\\.`));
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: lastgood restore/);
  });
});
