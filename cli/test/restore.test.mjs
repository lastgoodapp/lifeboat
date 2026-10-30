import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** The key with one character of its data changed to another the key could hold, as a typo leaves it. */
function mistyped(key) {
  const at = 20;
  return key.slice(0, at) + (key[at] === "Q" ? "P" : "Q") + key.slice(at + 1);
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

  it("refuses a key with one character mistyped, since its checksum no longer holds", async () => {
    const key = await generateX25519Identity();
    assert.equal(keyFromText(mistyped(key)), null);
    assert.equal(keyFromText(`# LastGood key for acme/notes\n${mistyped(key)}\n`), null);
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

  it("stops in its own sentence when it is handed a key age cannot read, which never shows the key", async () => {
    const { dir, copy, key, recorded } = await setup();
    const typo = mistyped(key);
    await assert.rejects(
      restoreCopy({ copy, key: typo, sha256: recorded }),
      (error) =>
        error instanceof RestoreError &&
        error.message === "That is not a LastGood key. Check the line in the key file that starts AGE-SECRET-KEY-1." &&
        !error.message.includes(typo.slice(16)),
    );
    assert.deepEqual(leftovers(dir), []);
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

  it("says nothing was saved when the folder for the opened copy does not exist, and gives the system's reason as it is", async () => {
    const { dir, copy, key, recorded } = await setup();
    const out = path.join(dir, "missing", "opened.backup");
    await assert.rejects(restoreCopy({ copy, key, sha256: recorded, out }), (error) => error instanceof RestoreError && /could not be opened, and nothing was saved: ENOENT: /.test(error.message));
    assert.equal(existsSync(path.join(dir, "missing")), false);
    assert.deepEqual(leftovers(dir), []);
  });

  it("says a folder is not a copy", async () => {
    const { dir, key, recorded } = await setup();
    await assert.rejects(
      restoreCopy({ copy: dir, key, sha256: recorded }),
      (error) => error instanceof RestoreError && error.message === `${dir} is not a file. Give the copy itself, not the folder it is in.`,
    );
  });

  it("never removes a .partial file it did not make, and says it is in the way", async () => {
    const { dir, seal, key } = await setup();
    // Large enough that age has not read all of it when the opened copy has nowhere to go.
    const sealed = await seal(plain(4_000_000, 3));
    const copy = path.join(dir, "acme-notes-database-20261018T000000Z.backup.age");
    writeFileSync(copy, sealed);
    const recorded = sha(sealed);
    const out = path.join(dir, "opened.backup");
    writeFileSync(`${out}.partial`, "theirs");
    const open = () => (existsSync("/proc/self/fd") ? readdirSync("/proc/self/fd").length : 0);
    const before = open();
    await assert.rejects(
      restoreCopy({ copy, key, sha256: recorded, out }),
      (error) => error instanceof RestoreError && error.message === `${out}.partial already exists. Move it, or choose another name with --out.`,
    );
    assert.equal(readFileSync(`${out}.partial`, "utf8"), "theirs");
    assert.equal(existsSync(out), false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(open(), before, "the copy is closed again (counted where the system lists open files)");
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

  /** Runs the command with `disk` loaded first: a module that makes node:fs fail the way a real disk can. */
  function runOn(disk, args) {
    const folder = mkdtempSync(path.join(tmpdir(), "lastgood-disk-"));
    dirs.push(folder);
    const file = path.join(folder, "disk.mjs");
    writeFileSync(file, `${disk}\nawait import("node:module").then(({ syncBuiltinESMExports }) => syncBuiltinESMExports());\n`);
    return spawnSync(process.execPath, ["--import", pathToFileURL(file).href, BIN, ...args], { encoding: "utf8" });
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

  it("says a key file with one character mistyped is not a LastGood key, with no stack trace and none of the key", async () => {
    const { dir, copy, key, recorded } = await setup();
    const typo = mistyped(key);
    const keyFile = path.join(dir, "mistyped-key.txt");
    writeFileSync(keyFile, `# LastGood key for acme/notes\n${typo}\n`);
    const result = run(["restore", copy, "--key", keyFile, "--sha256", recorded]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^That is not a LastGood key\./);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    const body = typo.slice("AGE-SECRET-KEY-1".length);
    for (let i = 0; i + 8 <= body.length; i += 8) assert.equal(result.stderr.includes(body.slice(i, i + 8)), false, "no part of the key is shown");
    assert.equal(existsSync(copy.slice(0, -4)), false);
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
    const unknown = run(["restore", copy, "--key", keyFile, "--nope"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /^Unknown option '--nope'/, "the option's own message, without the error's type");
    assert.equal(existsSync(copy.slice(0, -4)), false);
    const unchecked = run(["restore", copy, "--key", keyFile, "--unchecked", "--out", path.join(dir, "unchecked.backup")]);
    assert.equal(unchecked.status, 0, unchecked.stderr);
    assert.match(unchecked.stderr, /^Warning: this copy was not checked against any record/);
    assert.match(unchecked.stderr, new RegExp(`Its SHA-256 is ${sha(readFileSync(copy))}\\.`));
    const help = run(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: lastgood restore/);
  });

  it("removes the opened copy when the command is stopped with Ctrl-C before it is in place", async () => {
    const { dir, copy, keyFile, recorded } = await setup();
    const folder = mkdtempSync(path.join(tmpdir(), "lastgood-disk-"));
    dirs.push(folder);
    // The move into place never finishes, as on a slow drive, so the whole opened copy is waiting beside its name.
    const disk = path.join(folder, "disk.mjs");
    writeFileSync(
      disk,
      [
        'import fsp from "node:fs/promises";',
        'import { syncBuiltinESMExports } from "node:module";',
        'fsp.link = () => { process.stderr.write("moving\\n"); return new Promise(() => setInterval(() => {}, 1000)); };',
        "syncBuiltinESMExports();",
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--import", pathToFileURL(disk).href, BIN, "restore", copy, "--key", keyFile, "--sha256", recorded], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    await new Promise((resolve) =>
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes("moving")) resolve();
      }),
    );
    assert.ok(existsSync(`${copy.slice(0, -4)}.partial`), "the opened copy is there, waiting to be moved");
    const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGINT");
    assert.deepEqual(await ended, { code: null, signal: "SIGINT" });
    assert.deepEqual(leftovers(dir), []);
  });

  it("says so in a sentence when the copy can't be read, without a stack trace", async () => {
    const { dir, copy, keyFile, recorded } = await setup();
    const result = runOn(
      `import fs from "node:fs";
      import { Readable } from "node:stream";
      const real = fs.createReadStream;
      fs.createReadStream = (file, ...rest) =>
        String(file).endsWith(".age")
          ? new Readable({ read() { this.destroy(Object.assign(new Error(\`EACCES: permission denied, open '\${file}'\`), { code: "EACCES" })); } })
          : real(file, ...rest);`,
      ["restore", copy, "--key", keyFile, "--sha256", recorded],
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `${copy} could not be read: EACCES: permission denied, open '${copy}'\n`);
    assert.deepEqual(leftovers(dir), []);
  });

  it("says nothing was saved when the drive fills while the opened copy is put in place, and leaves no part of it", async () => {
    const { dir, copy, keyFile, recorded } = await setup();
    // A drive with no hard links (FAT32, some network shares) that has room for one opened copy but not a second.
    const result = runOn(
      `import fsp from "node:fs/promises";
      import { Writable } from "node:stream";
      fsp.link = async () => { throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }); };
      const open = fsp.open;
      fsp.open = async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (flags === "wx" && !String(file).endsWith(".partial")) {
          handle.createWriteStream = () => new Writable({
            write(chunk, encoding, callback) {
              handle.write("the first part").then(() => callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })), callback);
            },
            destroy(error, callback) {
              handle.close().then(() => callback(error), callback);
            },
          });
        }
        return handle;
      };`,
      ["restore", copy, "--key", keyFile, "--sha256", recorded],
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, `The copy opened, but ${copy.slice(0, -4)} could not be written, and nothing was saved: ENOSPC: no space left on device, write\n`);
    assert.deepEqual(leftovers(dir), []);
  });

  it("removes the part copied into place on a drive with no hard links when the command is stopped with Ctrl-C", async () => {
    const { dir, copy, keyFile, recorded } = await setup();
    const out = copy.slice(0, -4);
    const folder = mkdtempSync(path.join(tmpdir(), "lastgood-disk-"));
    dirs.push(folder);
    // No hard links, and a copy into place that stops after its first part, as on a slow USB drive.
    const disk = path.join(folder, "disk.mjs");
    writeFileSync(
      disk,
      [
        'import fs from "node:fs";',
        'import fsp from "node:fs/promises";',
        'import { syncBuiltinESMExports } from "node:module";',
        'import { Readable } from "node:stream";',
        'fsp.link = async () => { throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" }); };',
        "const read = fs.createReadStream;",
        "fs.createReadStream = (file, ...rest) => {",
        '  if (!String(file).endsWith(".partial")) return read(file, ...rest);',
        "  setInterval(() => {}, 1000);",
        "  let sent = false;",
        "  return new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.alloc(4096, 1)); } } });",
        "};",
        "syncBuiltinESMExports();",
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["--import", pathToFileURL(disk).href, BIN, "restore", copy, "--key", keyFile, "--sha256", recorded], { stdio: ["ignore", "pipe", "pipe"] });
    let over = false;
    const ended = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal }))).finally(() => (over = true));
    // The first part is in place under the opened copy's own name.
    while (!over && !(existsSync(out) && statSync(out).size > 0)) await new Promise((resolve) => setTimeout(resolve, 20));
    child.kill("SIGINT");
    assert.deepEqual(await ended, { code: null, signal: "SIGINT" });
    assert.deepEqual(leftovers(dir), []);
  });
});
