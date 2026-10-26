#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { keyFromText, restoreCopy, RestoreError } from "../lib/restore.mjs";
import { openCopy, rebuildCode, rebuildDatabase, runSteps, StepError, todoMarkdown, withWorkFolder } from "../lib/rebuild.mjs";
import { checkSecretKey, projectRef, rebuildFiles, storageBase } from "../lib/rebuild-files.mjs";
import { checkToken, rebuildSetup, setupRef } from "../lib/rebuild-setup.mjs";
import { checkVercelToken, rebuildVercel, vercelTarget } from "../lib/rebuild-vercel.mjs";
import { rebuildVercelSettings } from "../lib/rebuild-vercel-settings.mjs";
import { rebuildFromShares, ShareError, sharesInText } from "../lib/shares.mjs";

const USAGE = `Usage: lastgood restore <copy> --key <key file or Recovery Kit> [--share <file>] --sha256 <recorded SHA-256> [--out <file>]
       lastgood rebuild --key <key file or Recovery Kit> [--share <file>] [code, database, files, setup and Vercel options below]

restore checks a LastGood copy against the SHA-256 its backup recorded, then opens it with your key, on this computer.
Nothing is sent anywhere.

  --key <file>      the lastgood-key file you saved when you connected the app, or its Recovery Kit; - reads it from
                    standard input
  --share <file>    another share of the key, such as the email share saved as a file; with a Recovery Kit, any two
                    shares rebuild the key here. Give it more than once if you need to
  --sha256 <hex>    the SHA-256 your backup recorded: it is in the download email and on your login's Open here page
  --out <file>      where to save the opened copy (default: the copy's name without .age)
  --unchecked       open a copy you have no SHA-256 for, without checking it

rebuild opens copies the same way, then puts the app back into new, empty accounts you have made, one step at a time,
and shows each step's result and how long it took. It never writes over anything that is already there.

  --code <copy>              the code copy (repo/…tar.gz.age)
  --code-sha256 <hex>        its recorded SHA-256
  --code-to <git URL>        a new, empty repository; git pushes with your own login
  --database <copy>          the database copy (db/…backup.age)
  --database-sha256 <hex>    its recorded SHA-256
  --database-to <URL>        the new, empty Supabase project's connection string (the session pooler or direct one),
                             or set LASTGOOD_DATABASE_TO instead, to keep it out of your shell history
  --files <copy>             the files copy (storage/…tar.age). Needs --database too: each file's type and owner come
                             from the database copy. Set LASTGOOD_SUPABASE_SECRET_KEY to the new project's secret key
  --files-sha256 <hex>       its recorded SHA-256
  --files-to <URL>           the new project's URL (https://<ref>.supabase.co), if it can't be read from --database-to
  --setup <copy>             the Edge Functions and Supabase settings copy (setup/…tar.gz.age). Set
                             LASTGOOD_SUPABASE_TOKEN to an access token with write access to the new project
  --setup-sha256 <hex>       its recorded SHA-256
  --project-ref <ref>        the new project's ref, if it can't be read from --database-to
  --vercel <copy>            the Vercel copy (vercel/…tar.gz.age): environment variables, settings, domains and DNS
                             records. Set LASTGOOD_VERCEL_TOKEN to a Vercel token for the team that owns the new project
  --vercel-sha256 <hex>      its recorded SHA-256
  --vercel-project <id>      the new Vercel project's ID (prj_...) or name: make it first, by importing the new
                             repository in Vercel
  --vercel-team <id>         its team's ID (team_...), for a team project
  --todo <file>              also write the "Still to do by hand" list to this new file, as Markdown (names only)
  --skip database            the database is already back from an earlier run: open its copy for the files only
  --unchecked                open copies you have no SHA-256 for, without checking them
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** The private key from the key file, or rebuilt here from two shares. Null after saying why not. */
async function loadKey(values) {
  const keyText = values.key === "-" ? await readStdin() : await readFile(values.key, "utf8").catch(() => "");
  const key = keyFromText(keyText);
  if (key) return key;
  // A Recovery Kit and another share: rebuild the key here, from any two of the three.
  const shareTexts = [keyText];
  for (const file of values.share ?? []) shareTexts.push(await readFile(file, "utf8").catch(() => ""));
  const shares = sharesInText(shareTexts.join("\n"));
  if (shares.length === 0) {
    process.stderr.write(
      "That is not a LastGood key. Give the key file or Recovery Kit you saved when you connected the app, or the line in the key file that starts AGE-SECRET-KEY-1.\n",
    );
    return null;
  }
  if (shares.length === 1) {
    process.stderr.write("That is one share. Add your email share with --share: any two of your three shares rebuild the key.\n");
    return null;
  }
  try {
    return (await rebuildFromShares(shares)).privateKey;
  } catch (error) {
    if (!(error instanceof ShareError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return null;
  }
}

async function restore(values, positionals) {
  if (positionals.length !== 2) {
    process.stderr.write(USAGE);
    return 2;
  }
  const key = await loadKey(values);
  if (!key) return 1;
  try {
    const result = await restoreCopy({
      copy: positionals[1],
      key,
      sha256: values.sha256 ?? null,
      unchecked: values.unchecked,
      out: values.out,
    });
    if (!result.checked) {
      process.stderr.write(
        `Warning: this copy was not checked against any record, so nothing shows it is the one your backup made. Its SHA-256 is ${result.sha256}.\n`,
      );
    }
    else process.stdout.write("The copy matches the SHA-256 your backup recorded.\n");
    process.stdout.write(`Opened: ${result.out}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof RestoreError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

/** What every rebuild leaves to the customer, whichever copies it had: the last items of the by-hand list. */
const ALWAYS = [
  "Point your domain at the new Vercel project where its DNS is kept (Vercel shows what to set in the project's domain settings), and if the app's address changes, change Supabase's Site URL and redirect URLs to match.",
  "Connect the new repository and project to LastGood, so backups start again: the old project's backups stop with the old accounts.",
];

/** First on the list when this run had no Vercel copy. */
const NO_VERCEL =
  "Rebuild the Vercel project: import the new repository in Vercel, then run lastgood rebuild with --vercel and the night's Vercel copy, which puts back its environment variables, settings and domains. Without a Vercel copy, set them by hand as the old project had them.";

async function rebuild(values, positionals) {
  const databaseTo = values["database-to"] ?? process.env.LASTGOOD_DATABASE_TO;
  const code = values.code ? { copy: values.code, sha256: values["code-sha256"], to: values["code-to"] } : null;
  const database = values.database ? { copy: values.database, sha256: values["database-sha256"], to: databaseTo } : null;
  const files = values.files ? { copy: values.files, sha256: values["files-sha256"], to: values["files-to"] } : null;
  const setup = values.setup ? { copy: values.setup, sha256: values["setup-sha256"] } : null;
  const vercel = values.vercel ? { copy: values.vercel, sha256: values["vercel-sha256"] } : null;
  const skip = new Set(values.skip ?? []);
  if (positionals.length !== 1 || (!code && !database && !files && !setup && !vercel)) {
    process.stderr.write(`Give --code with --code-to, --database with --database-to, --files with --database, --setup, --vercel with --vercel-project, or more than one.\n\n${USAGE}`);
    return 2;
  }
  if ([...skip].some((step) => step !== "database")) {
    process.stderr.write("Only the database step can be skipped, with --skip database, to run the files step again after it.\n");
    return 2;
  }
  if (files && !database) {
    process.stderr.write("Give --database with --files: each file's type and owner come from the database copy. If the database is already back, add --skip database.\n");
    return 2;
  }
  if (code && !code.to) {
    process.stderr.write("Give --code-to: the address of a new, empty repository for the code.\n");
    return 2;
  }
  if (database && !database.to) {
    process.stderr.write("Give --database-to, or set LASTGOOD_DATABASE_TO: the connection string of a new, empty Supabase project.\n");
    return 2;
  }
  if (files || setup || vercel) {
    // Before any copy is opened or any step runs, so a missing key or token never stops a rebuild half way.
    try {
      if (files) {
        checkSecretKey(process.env.LASTGOOD_SUPABASE_SECRET_KEY);
        storageBase(files.to, database.to);
      }
      if (setup) {
        checkToken(process.env.LASTGOOD_SUPABASE_TOKEN);
        setup.ref = setupRef(values["project-ref"], databaseTo ? projectRef(databaseTo) : null);
      }
      if (vercel) {
        checkVercelToken(process.env.LASTGOOD_VERCEL_TOKEN);
        Object.assign(vercel, vercelTarget(values["vercel-project"], values["vercel-team"]));
        // The new Supabase project, when known, so a value that still names the old one is told apart from it.
        const known = databaseTo ? projectRef(databaseTo) : null;
        vercel.ref = setup?.ref ?? (values["project-ref"] || known ? setupRef(values["project-ref"], known) : null);
      }
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
  }
  if (values.todo && existsSync(values.todo)) {
    process.stderr.write(`${values.todo} already exists. Give --todo a new file: rebuild never writes over one.\n`);
    return 2;
  }
  const key = await loadKey(values);
  if (!key) return 1;
  const list = [];
  const ok = await withWorkFolder(async (work) => {
    const opened = {};
    const steps = [
      {
        name: "Open the copies",
        run: async (say) => {
          if (code) opened.code = await openCopy({ ...code, key, unchecked: values.unchecked, work, name: "code.tar.gz", say });
          if (database) opened.database = await openCopy({ ...database, key, unchecked: values.unchecked, work, name: "database.backup", say });
          if (files) opened.files = await openCopy({ ...files, key, unchecked: values.unchecked, work, name: "files.tar", say });
          if (setup) opened.setup = await openCopy({ ...setup, key, unchecked: values.unchecked, work, name: "setup.tar.gz", say });
          if (vercel) opened.vercel = await openCopy({ ...vercel, key, unchecked: values.unchecked, work, name: "vercel.tar.gz", say });
          return [code && "code", database && "database", files && "files", setup && "setup", vercel && "Vercel"].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1");
        },
      },
    ];
    if (code) steps.push({ name: "Code", run: (say, todo) => rebuildCode({ archive: opened.code, to: code.to, work, say, todo }) });
    if (database) {
      steps.push({
        name: "Database",
        skip: skip.has("database") ? "you said an earlier run restored it" : "",
        run: (say, todo) => rebuildDatabase({ dumpPath: opened.database, to: database.to, work, say, todo }),
      });
    }
    if (files) {
      steps.push({
        name: "Files",
        run: (say, todo) =>
          rebuildFiles({
            archive: opened.files,
            dumpPath: opened.database,
            databaseTo: database.to,
            filesTo: files.to,
            key: process.env.LASTGOOD_SUPABASE_SECRET_KEY,
            work,
            say,
            todo,
          }),
      });
    }
    if (setup) {
      steps.push({
        name: "Edge Functions and settings",
        run: (say, todo) => rebuildSetup({ archive: opened.setup, ref: setup.ref, token: process.env.LASTGOOD_SUPABASE_TOKEN, work, say, todo }),
      });
    }
    if (vercel) {
      steps.push({
        name: "Vercel environment variables",
        run: (say, todo) =>
          rebuildVercel({ archive: opened.vercel, project: vercel.project, team: vercel.team, token: process.env.LASTGOOD_VERCEL_TOKEN, ref: vercel.ref, work, say, todo }),
      });
      steps.push({
        name: "Vercel settings and domains",
        run: (say, todo) =>
          rebuildVercelSettings({ archive: opened.vercel, project: vercel.project, team: vercel.team, token: process.env.LASTGOOD_VERCEL_TOKEN, work, say, todo }),
      });
    }
    return runSteps(steps, undefined, undefined, { always: vercel ? ALWAYS : [NO_VERCEL, ...ALWAYS], list });
  });
  if (values.todo) {
    try {
      await writeFile(values.todo, todoMarkdown(list), { mode: 0o600, flag: "wx" });
      process.stdout.write(`\nThe list is in ${values.todo} too.\n`);
    } catch (error) {
      process.stderr.write(`The list could not be written to ${values.todo} (${error?.code ?? "error"}). It is printed above.\n`);
    }
  }
  return ok ? 0 : 1;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        key: { type: "string" },
        share: { type: "string", multiple: true },
        sha256: { type: "string" },
        out: { type: "string" },
        unchecked: { type: "boolean", default: false },
        code: { type: "string" },
        "code-sha256": { type: "string" },
        "code-to": { type: "string" },
        database: { type: "string" },
        "database-sha256": { type: "string" },
        "database-to": { type: "string" },
        files: { type: "string" },
        "files-sha256": { type: "string" },
        "files-to": { type: "string" },
        setup: { type: "string" },
        "setup-sha256": { type: "string" },
        "project-ref": { type: "string" },
        vercel: { type: "string" },
        "vercel-sha256": { type: "string" },
        "vercel-project": { type: "string" },
        "vercel-team": { type: "string" },
        todo: { type: "string" },
        skip: { type: "string", multiple: true },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.key || !["restore", "rebuild"].includes(positionals[0])) {
    process.stderr.write(USAGE);
    return 2;
  }
  return positionals[0] === "restore" ? restore(values, positionals) : rebuild(values, positionals);
}

process.exitCode = await main(process.argv.slice(2));
