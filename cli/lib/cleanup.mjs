import { rmSync } from "node:fs";

/**
 * Opened copies are the customer's data in readable form. A command stopped with Ctrl-C, by a closed terminal or by
 * `kill` never reaches its own clean-up, so what is listed here is removed on the way out, and the command then stops
 * as the signal asked.
 */

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const listed = new Set();

function stopped(signal) {
  for (const target of listed) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Nothing more can be done on the way out.
    }
  }
  listed.clear();
  for (const name of SIGNALS) process.removeListener(name, stopped);
  process.kill(process.pid, signal);
}

/** Removes `target`, a file or a folder, if the command is stopped before the function this returns is called. */
export function removeIfStopped(target) {
  if (listed.size === 0) for (const name of SIGNALS) process.on(name, stopped);
  listed.add(target);
  return function done() {
    listed.delete(target);
    if (listed.size === 0) for (const name of SIGNALS) process.removeListener(name, stopped);
  };
}
