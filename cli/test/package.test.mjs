import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LIFEBOAT_FILES } from "../scripts/sync-lifeboat.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(CLI, "..");
// A copy of cli/ on its own has no action beside it to compare the copied scripts with.
const ACTION = existsSync(path.join(ROOT, "lifeboat", "scripts"));

/** The relative imports of one module, resolved to files. */
function relativeImports(file) {
  const text = readFileSync(file, "utf8");
  const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(
    (match) => match[1] ?? match[2],
  );
  return specifiers.filter((specifier) => specifier.startsWith(".")).map((specifier) => path.resolve(path.dirname(file), specifier));
}

/** Every file the CLI loads from its entry point, following relative imports. */
function importGraph() {
  const seen = new Set();
  const queue = [path.join(CLI, "bin", "lastgood.mjs")];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (existsSync(file)) queue.push(...relativeImports(file));
  }
  return [...seen];
}

/** The files `npm pack` would publish, relative to cli/. */
function packedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: CLI, encoding: "utf8" });
  return JSON.parse(out)[0].files.map((file) => file.path);
}

describe("the lastgood package (R3, K7)", () => {
  it("keeps each copy of an action script identical to the action's own", { skip: !ACTION && "needs the full repository" }, () => {
    assert.ok(LIFEBOAT_FILES.length >= 5);
    for (const name of LIFEBOAT_FILES) {
      assert.equal(
        readFileSync(path.join(CLI, "lib", "lifeboat", name), "utf8"),
        readFileSync(path.join(ROOT, "lifeboat", "scripts", name), "utf8"),
        `cli/lib/lifeboat/${name} differs from lifeboat/scripts/${name}: run node cli/scripts/sync-lifeboat.mjs`,
      );
    }
    assert.deepEqual(readdirSync(path.join(CLI, "lib", "lifeboat")).sort(), [...LIFEBOAT_FILES].sort());
  });

  it("loads nothing from outside the package, and packs everything it loads", () => {
    const graph = importGraph();
    assert.ok(graph.length > 8, "the entry point imports the CLI's modules");
    const packed = new Set(packedFiles());
    for (const file of graph) {
      const relative = path.relative(CLI, file);
      assert.ok(!relative.startsWith(".."), `${path.relative(ROOT, file)} is outside cli/, so npm would not ship it`);
      assert.ok(packed.has(relative.split(path.sep).join("/")), `${relative} is not in the package`);
    }
  });

  it("starts from the packed tarball with nothing else beside it", () => {
    // Unpacked inside cli/, so the dependencies resolve from cli/node_modules or the repository's, but with no lifeboat/ next to it.
    const dir = mkdtempSync(path.join(CLI, ".pack-test-"));
    try {
      const tarball = execFileSync("npm", ["pack", "--pack-destination", dir, "--ignore-scripts", "--silent"], { cwd: CLI, encoding: "utf8" }).trim().split("\n").pop();
      execFileSync("tar", ["-xzf", path.join(dir, tarball), "-C", dir]);
      const run = spawnSync(process.execPath, [path.join(dir, "package", "bin", "lastgood.mjs"), "--help"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /^Usage: lastgood restore /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
