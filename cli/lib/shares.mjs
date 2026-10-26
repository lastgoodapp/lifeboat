import { base32crockford, bech32 } from "@scure/base";
import { identityToRecipient } from "age-encryption";
import { combine } from "shamir-secret-sharing";

/**
 * Rebuilding a LastGood key from two of its three shares (K3, K7), on the customer's own computer, with nothing sent
 * anywhere. The format is LastGood's (lib/keys/shares.ts in the LastGood repository), written out so this tool
 * works without LastGood:
 *
 *   LG1-<KIT|EMAIL|VAULT>-<64 characters of Crockford base32, in groups of four>
 *
 * The 40 bytes are a 33-byte share of the age key's 32-byte X25519 secret (two of three, GF(256)), then the first
 * 7 bytes of SHA-256 over "lastgood-share-v1\n<role>\n<age public key>\n" and the share. The rebuilt key's own public
 * key must pass every share's check, so a typo or shares from two apps are refused rather than giving a wrong key.
 */

const SHARE_BYTES = 33;
const CHECK_BYTES = 7;
const ROLES = { KIT: "kit", EMAIL: "email", VAULT: "vault" };

export class ShareError extends Error {}

/** Every written share in a block of text, such as a Recovery Kit or a saved email. Spaces and line breaks are ignored. */
export function sharesInText(text) {
  return text.replace(/\s+/g, "").toUpperCase().match(/LG1-(?:KIT|EMAIL|VAULT)(?:-?[0-9A-Z]){64}/g) ?? [];
}

function readShare(text) {
  const match = /^LG1-(KIT|EMAIL|VAULT)-([0-9A-Z-]+)$/.exec(text.replace(/\s+/g, "").toUpperCase());
  if (!match) return null;
  let body;
  try {
    body = base32crockford.decode(match[2].replace(/-/g, ""));
  } catch {
    return null;
  }
  return body.length === SHARE_BYTES + CHECK_BYTES ? { role: ROLES[match[1]], body } : null;
}

async function check(role, publicKey, share) {
  const label = new TextEncoder().encode(`lastgood-share-v1\n${role}\n${publicKey}\n`);
  const input = new Uint8Array(label.length + share.length);
  input.set(label);
  input.set(share, label.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, CHECK_BYTES);
}

/** The age private key two or more different shares rebuild, with its public key. Throws ShareError otherwise. */
export async function rebuildFromShares(texts) {
  const read = [];
  for (const text of texts) {
    const share = readShare(text);
    if (!share) throw new ShareError("That is not a LastGood key share. It starts LG1- and is about 90 characters long.");
    if (!read.some((seen) => seen.role === share.role)) read.push(share);
  }
  if (read.length < 2) throw new ShareError("Two different shares are needed: two of the Recovery Kit, the email share and LastGood's share.");
  let privateKey;
  try {
    const secret = await combine(read.map((entry) => entry.body.slice(0, SHARE_BYTES)));
    privateKey = bech32.encode("age-secret-key-", bech32.toWords(secret)).toUpperCase();
  } catch {
    throw new ShareError("These shares do not rebuild one key. Check each for a typo, and that both are for the same app.");
  }
  const publicKey = await identityToRecipient(privateKey);
  for (const entry of read) {
    const expected = await check(entry.role, publicKey, entry.body.slice(0, SHARE_BYTES));
    if (!expected.every((byte, index) => byte === entry.body[SHARE_BYTES + index])) {
      throw new ShareError("These shares do not rebuild one key. Check each for a typo, and that both are for the same app.");
    }
  }
  return { privateKey, publicKey };
}
