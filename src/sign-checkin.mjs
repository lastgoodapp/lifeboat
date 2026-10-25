import { createHmac, timingSafeEqual } from "node:crypto";

export const CHECKIN_MAX_SKEW_MS = 5 * 60 * 1000;

export function signCheckin(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyCheckin(secret, timestamp, body, signature, nowMs = Date.now()) {
  if (!secret || !signature) return false;
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) return false;
  if (Math.abs(nowMs - seconds * 1000) > CHECKIN_MAX_SKEW_MS) return false;
  const expected = signCheckin(secret, String(timestamp), body);
  const left = Buffer.from(String(signature));
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
