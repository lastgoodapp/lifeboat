import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, open, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Opening a LastGood copy on the customer's own computer (R3). Nothing here talks to LastGood: the copy, the key
 * and the opened file stay on this machine. Before a copy is opened, its SHA-256 is checked against the one its
 * backup recorded (owner decision D18), which the customer has from the download email or the login.
 */

const AGE_PRIVATE_KEY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;
const AGE_HEADER = "age-encryption.org/v1\n";

export class RestoreError extends Error {}

/**
 * The private key from the key file LastGood's setup saved, or the key on its own: the one line that is not a
 * comment. Null when there is no such line, or more than one.
 */
export function keyFromText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length !== 1) return null;
  return AGE_PRIVATE_KEY.test(lines[0]) ? lines[0] : null;
}

/** A SHA-256 as 64 hex characters, lower case; null when the value is not one. */
export function normalSha256(value) {
  const hex = String(value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export async function sha256OfFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function isAgeFile(path) {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(AGE_HEADER.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).toString("latin1") === AGE_HEADER;
  } finally {
    await handle.close();
  }
}

/** The name an opened copy gets next to the original: the copy's name without `.age`. */
export function openedPath(copy) {
  return /\.age$/i.test(copy) && !/(^|[\\/])\.age$/i.test(copy) ? copy.slice(0, -4) : `${copy}.opened`;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts a finished file at `out` without ever replacing a file already there, even one created after the first check:
 * a hard link fails when the name is taken, and where the disk has no hard links (some USB drives and network shares)
 * an exclusive copy does the same. The `.partial` file is removed either way.
 */
export async function moveIntoPlace(partial, out) {
  try {
    try {
      await link(partial, out);
    } catch (error) {
      if (error?.code === "EEXIST") throw error;
      await copyFile(partial, out, constants.COPYFILE_EXCL);
    }
  } catch (error) {
    if (error?.code === "EEXIST") throw new RestoreError(`${out} already exists. Move it, or choose another name with --out.`);
    throw error;
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * Checks the copy, then opens it to `out`. With `sha256`, the copy must match it first; without, `unchecked` must say
 * so. The opened copy is written beside `out` and moved into place only when age has authenticated every chunk, so a
 * failure leaves nothing behind. Never writes over an existing file.
 */
export async function restoreCopy({ copy, key, sha256 = null, unchecked = false, out = openedPath(copy) }) {
  if (!(await exists(copy))) throw new RestoreError(`No file at ${copy}.`);
  const expected = sha256 === null ? null : normalSha256(sha256);
  if (sha256 !== null && !expected) throw new RestoreError("--sha256 must be the 64-character SHA-256 from your download email or your login.");
  if (!expected && !unchecked) {
    throw new RestoreError(
      "Give the SHA-256 your backup recorded for this copy with --sha256. It is in the download email and on your login's Open here page. Only if you have no record, add --unchecked to open it anyway.",
    );
  }
  if (await exists(out)) throw new RestoreError(`${out} already exists. Move it, or choose another name with --out.`);

  const actual = await sha256OfFile(copy);
  if (expected && actual !== expected) {
    throw new RestoreError(
      `This copy's SHA-256 is ${actual}, not the ${expected} your backup recorded, so it was not opened. It may be a different copy, or it may have been changed after your backup made it. Do not restore from it.`,
    );
  }
  if (!(await isAgeFile(copy))) {
    throw new RestoreError(
      "This is not an age file. A copy made with the older passphrase (.enc) opens with: openssl enc -d -aes-256-cbc -pbkdf2 -in <copy> -out <file>",
    );
  }

  const { Decrypter } = await import("age-encryption");
  const decrypter = new Decrypter();
  decrypter.addIdentity(key);
  let opened;
  try {
    opened = await decrypter.decrypt(Readable.toWeb(createReadStream(copy)));
  } catch {
    throw new RestoreError("This key does not open this copy. Check that the key file is the one for this app.");
  }
  const partial = `${out}.partial`;
  try {
    await pipeline(Readable.fromWeb(opened), createWriteStream(partial, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(partial, { force: true });
    throw new RestoreError(`The copy could not be opened, and nothing was saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  await moveIntoPlace(partial, out);
  return { out, sha256: actual, checked: Boolean(expected) };
}
