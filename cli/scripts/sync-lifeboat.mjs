// The action's scripts the CLI reads copies with, copied into cli/lib/lifeboat/ so the published package carries them.
// npm publishes cli/ alone, so an import that reaches ../../lifeboat/ would be missing from the package.
// Usage: node cli/scripts/sync-lifeboat.mjs. cli/test/package.test.mjs fails while a copy differs from its source.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LIFEBOAT_FILES = ["github-metadata.mjs", "restore-list.mjs", "storage-copy.mjs", "supabase-setup.mjs", "vercel-env.mjs"];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = path.join(cli, "lib", "lifeboat");
  mkdirSync(target, { recursive: true });
  for (const name of LIFEBOAT_FILES) copyFileSync(path.join(cli, "..", "lifeboat", "scripts", name), path.join(target, name));
  process.stdout.write(`Copied ${LIFEBOAT_FILES.length} scripts into cli/lib/lifeboat/.\n`);
}
