import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeSegment } from "./lifeboat/storage-copy.mjs";
import { clean } from "./rebuild-list.mjs";
import { checkArchive, connection, counted, run, StepError } from "./rebuild.mjs";

/**
 * Files back into a new Supabase project's buckets (R4), from the files copy, on the customer's own computer. Each
 * file goes up through the new project's Storage API with the project's secret key, which the customer sets in
 * LASTGOOD_SUPABASE_SECRET_KEY and which never leaves this computer. The buckets themselves, with their settings, come
 * back with the database step. A file already there is never written over: one at the same size is kept, so a run
 * that stopped part way can carry on, and one at a different size stops the step before anything is uploaded.
 *
 * The files copy holds only the bytes. Each file's type and cache setting, and who owns it, come from the database
 * copy's storage.objects rows. An upload with the secret key leaves the owner empty, so the owners are set back over
 * the database connection afterwards, or a policy that lets users reach their own files would match none of them.
 */

const AT_ONCE = 4;
const ATTEMPTS = 3;
const MAX_WAIT_MS = 60_000;
const PAGE = 1000;
/** Supabase recommends a resumable upload above 6 MB, and takes its parts in exactly this size. */
export const CHUNK = 6 * 1024 * 1024;
/** The storage.objects columns that say who owns a file, set back after the upload. */
const OWNER_COLUMNS = ["owner", "owner_id", "user_metadata"];

/** The project ref in a Supabase connection string: the pooler's `postgres.<ref>` user, or the direct `db.<ref>` host. */
export function projectRef(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    const pooled = /^postgres\.([a-z]{20})$/.exec(decodeURIComponent(parsed.username));
    if (pooled) return pooled[1];
    return /^db\.([a-z]{20})\.supabase\.co$/.exec(parsed.hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The new project's API address: --files-to, or worked out from the database connection string. When both name a
 * project, they must name the same one, or the owners would be set in a different project from the files.
 */
export function storageBase(filesTo, databaseUrl) {
  const ref = projectRef(databaseUrl);
  if (!filesTo) {
    if (!ref) throw new StepError("Give --files-to, the new project's URL (https://<ref>.supabase.co). It could not be read from the database connection string.");
    return `https://${ref}.supabase.co`;
  }
  let parsed;
  try {
    parsed = new URL(filesTo);
  } catch {
    throw new StepError("--files-to is not a URL. Give the new project's URL, https://<ref>.supabase.co.");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new StepError("--files-to must start with https://, so the secret key is never sent in the clear.");
  }
  const named = /^([a-z]{20})\.supabase\.co$/.exec(parsed.hostname)?.[1];
  if (named && ref && named !== ref) {
    throw new StepError(`--files-to is project ${named}, but the database connection string is project ${ref}. Give the same project for both.`);
  }
  return parsed.origin;
}

/** The secret key from LASTGOOD_SUPABASE_SECRET_KEY: a secret key, or the legacy service_role key. */
export function checkSecretKey(value) {
  const key = String(value ?? "").trim();
  if (!key) {
    throw new StepError(
      "Set LASTGOOD_SUPABASE_SECRET_KEY to the new project's secret key, from Project Settings, then API Keys, so the files can be uploaded. It stays on this computer.",
    );
  }
  if (key.startsWith("sb_publishable_")) {
    throw new StepError("LASTGOOD_SUPABASE_SECRET_KEY holds the publishable key, which cannot add files to private buckets. Use a secret key (sb_secret_...).");
  }
  if (key.startsWith("sb_secret_")) return key;
  if (jwtRole(key) === "service_role") return key;
  throw new StepError("LASTGOOD_SUPABASE_SECRET_KEY is not a secret key. Use one that starts sb_secret_, or the legacy service_role key.");
}

function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))?.role ?? null;
  } catch {
    return null;
  }
}

/** One field of a COPY text row, with its backslash escapes undone. */
export function decodeCopyField(field) {
  if (field === "\\N") return null;
  const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return field.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g, (_, octal, hex, char) => {
    if (octal) return String.fromCharCode(parseInt(octal, 8));
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return escapes[char] ?? char;
  });
}

/** A table's COPY block in `pg_restore --data-only` output: its column names and its rows as they were dumped. */
export function copyBlock(sql, table) {
  const lines = String(sql).split("\n");
  const start = lines.findIndex((line) => line.startsWith(`COPY ${table} (`) && line.endsWith(") FROM stdin;"));
  if (start < 0) return null;
  const header = lines[start];
  const columns = header
    .slice(header.indexOf("(") + 1, header.lastIndexOf(")"))
    .split(", ")
    .map((name) => name.replace(/^"(.*)"$/, "$1"));
  const end = lines.indexOf("\\.", start + 1);
  return { columns, lines: lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.length > 0) };
}

/** A COPY row as `{ column: value }`. */
export function copyRow(columns, line) {
  const fields = line.split("\t");
  return Object.fromEntries(columns.map((name, index) => [name, fields[index] === undefined ? null : decodeCopyField(fields[index])]));
}

/** A file's type and cache setting from its storage.objects row, safe to send as headers. */
export function fileMeta(row) {
  let metadata = null;
  try {
    metadata = row?.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    metadata = null;
  }
  const header = (value) => (typeof value === "string" && /^[\x20-\x7e]{1,200}$/.test(value) ? value : null);
  const mimetype = header(metadata?.mimetype);
  const cache = header(metadata?.cacheControl);
  return {
    type: mimetype?.includes("/") ? mimetype : "application/octet-stream",
    cache,
    // A resumable upload takes the cache setting as a number of seconds.
    maxAge: /^max-age=(\d+)$/.exec(cache ?? "")?.[1] ?? null,
  };
}

/** The files in an opened copy, by bucket: `<bucket>/<path>`, as the backup's storage copy saves them. */
async function filesIn(root) {
  const buckets = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeSegment(entry.name)) {
      throw new StepError("The files copy holds something other than one folder per bucket, which a LastGood backup never writes. It was not used.");
    }
    const files = [];
    await walk(path.join(root, entry.name), "", files);
    files.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    buckets.set(entry.name, files);
  }
  return buckets;
}

async function walk(dir, prefix, files) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, `${prefix}${entry.name}/`, files);
    else if (entry.isFile()) files.push({ name: `${prefix}${entry.name}`, file: full, size: (await stat(full)).size });
    else throw new StepError("The files copy holds something other than plain files and folders, which a LastGood backup never writes. It was not used.");
  }
}

/** A refusal's status and reason. Storage answers some refusals with HTTP 400 and the real status in the body. */
async function refusalOf(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const inner = Number(body?.statusCode);
  const status = response.status === 400 && Number.isInteger(inner) && inner >= 400 ? inner : response.status;
  return { status, message: clean(typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : `HTTP ${response.status}`) };
}

function waitFor(response, attempt) {
  const raw = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw * 1000, MAX_WAIT_MS);
  return 1000 * 2 ** (attempt - 1);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function objectPath(bucket, name) {
  return `${encodeURIComponent(bucket)}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

/** Storage API calls with the secret key: retried on a network error, 429 or 5xx; a refused key stops the step. */
function storageClient({ base, key, fetchImpl, sleep }) {
  const host = new URL(base).host;
  const hide = (refusal) => ({ ...refusal, message: refusal.message.split(key).join("…") });

  async function call(url, init, what) {
    let last = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(url, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, "User-Agent": "lastgood-cli", ...(init.headers ?? {}) } });
      } catch {
        last = { status: 0, message: `${host} could not be reached` };
        if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      if (response.ok) return { response };
      const refusal = hide(await refusalOf(response));
      if (refusal.status === 401 || refusal.status === 403) {
        throw new StepError(`${host} refused the key in LASTGOOD_SUPABASE_SECRET_KEY when ${what}. Use the new project's secret key.`);
      }
      if (refusal.status < 500 && refusal.status !== 429) return { refusal };
      last = refusal;
      if (attempt < ATTEMPTS) await sleep(waitFor(response, attempt));
    }
    return { refusal: last };
  }

  async function json(url, init, what) {
    const { response, refusal } = await call(url, init, what);
    if (refusal) throw new StepError(`${host} did not answer when ${what}: ${refusal.message}.`);
    try {
      return await response.json();
    } catch {
      throw new StepError(`${host} sent something other than JSON when ${what}.`);
    }
  }

  return {
    host,
    call,
    async buckets() {
      const listed = await json(`${base}/storage/v1/bucket`, { headers: { Accept: "application/json" } }, "listing the buckets");
      if (!Array.isArray(listed)) throw new StepError(`${host} sent something other than a list for the buckets.`);
      return new Set(listed.map((bucket) => bucket?.id).filter((id) => typeof id === "string"));
    },
    /** Every file in a bucket with its size, folders walked one level at a time. */
    async files(bucket) {
      const found = new Map();
      const folders = [""];
      while (folders.length > 0) {
        const prefix = folders.shift();
        for (let offset = 0; ; offset += PAGE) {
          const page = await json(
            `${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`,
            {
              method: "POST",
              headers: { Accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } }),
            },
            `listing the files in ${bucket}`,
          );
          if (!Array.isArray(page)) throw new StepError(`${host} sent something other than a list for the files in ${bucket}.`);
          for (const entry of page) {
            if (typeof entry?.name !== "string" || !entry.name) continue;
            // A folder has no id; a file always has one.
            if (entry.id === null || entry.id === undefined) folders.push(`${prefix}${entry.name}/`);
            else found.set(`${prefix}${entry.name}`, Number(entry.metadata?.size ?? -1));
          }
          if (page.length < PAGE) break;
        }
      }
      return found;
    },
    async read(bucket, name) {
      const { response, refusal } = await call(`${base}/storage/v1/object/authenticated/${objectPath(bucket, name)}`, { headers: { Accept: "*/*" } }, `reading a file back from ${bucket}`);
      if (refusal) throw new StepError(`${host} would not give back a file from ${bucket}: ${refusal.message}.`);
      return Buffer.from(await response.arrayBuffer());
    },
    /** One file up, never over an existing one. Null when it went in, else the refusal. */
    async upload(bucket, entry, meta) {
      if (entry.size <= CHUNK) {
        const headers = { "Content-Type": meta.type, "x-upsert": "false" };
        if (meta.cache) headers["cache-control"] = meta.cache;
        const { refusal } = await call(`${base}/storage/v1/object/${objectPath(bucket, entry.name)}`, { method: "POST", headers, body: await readFile(entry.file) }, `uploading a file to ${bucket}`);
        return refusal ?? null;
      }
      return resumable(bucket, entry, meta);
    },
  };

  /** A large file in 6 MB parts, by Supabase's resumable (TUS) uploads. A part that was cut off is sent again from where Supabase says it got to. */
  async function resumable(bucket, entry, meta) {
    const fields = [["bucketName", bucket], ["objectName", entry.name], ["contentType", meta.type]];
    if (meta.maxAge) fields.push(["cacheControl", meta.maxAge]);
    const created = await call(
      `${base}/storage/v1/upload/resumable`,
      {
        method: "POST",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(entry.size),
          "Upload-Metadata": fields.map(([name, value]) => `${name} ${Buffer.from(value).toString("base64")}`).join(","),
          "x-upsert": "false",
        },
      },
      `starting an upload to ${bucket}`,
    );
    if (created.refusal) return created.refusal;
    const location = created.response.headers.get("location");
    if (!location) return { status: 0, message: "Supabase did not say where to send the file" };
    const url = new URL(location, base).toString();
    const handle = await open(entry.file);
    try {
      let offset = 0;
      while (offset < entry.size) {
        const length = Math.min(CHUNK, entry.size - offset);
        const part = Buffer.alloc(length);
        await handle.read(part, 0, length, offset);
        const sent = await call(
          url,
          { method: "PATCH", headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" }, body: part },
          `uploading part of a file to ${bucket}`,
        );
        if (sent.refusal) {
          // 409 here means Supabase already has more of the file than this part assumed: ask how much, and go on from there.
          if (sent.refusal.status !== 409) return sent.refusal;
          const head = await call(url, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } }, `checking an upload to ${bucket}`);
          const at = Number(head.response?.headers.get("upload-offset"));
          if (!Number.isInteger(at) || at <= offset) return sent.refusal;
          offset = at;
          continue;
        }
        const at = Number(sent.response.headers.get("upload-offset"));
        offset = Number.isInteger(at) && at > offset ? at : offset + length;
      }
    } finally {
      await handle.close();
    }
    return null;
  }
}

/**
 * Sets each file's owner, owner_id and user_metadata back to what the dump has, in one transaction. The dump's own
 * COPY rows go into a temporary table, so Postgres reads them itself and no SQL is built from a file name. Only rows
 * for files in the copy are loaded, and only a row whose owner is still empty is changed, matched on bucket_id and
 * name: a file an earlier run set is counted as already set, and one with a different owner is named. Returns how many
 * there were to set, how many were set now, how many already matched, and the files whose owner differs.
 */
export async function restoreOwners({ target, block, uploaded, work, psql = "psql" }) {
  const quiet = ["--no-psqlrc", "--tuples-only", "--no-align", "--quiet", "--set", "ON_ERROR_STOP=1"];
  const shape = await run(
    psql,
    [
      target.url,
      ...quiet,
      "--command",
      "SELECT coalesce(json_object_agg(attname, format_type(atttypid, atttypmod)), '{}') FROM pg_attribute WHERE attrelid = 'storage.objects'::regclass AND attnum > 0 AND NOT attisdropped",
    ],
    { env: target.env },
  );
  if (shape.code !== 0) throw new StepError(`The new database would not describe storage.objects: ${clean(shape.stderr)}`);
  const types = JSON.parse(shape.stdout.trim() || "{}");
  const nothing = { expected: 0, updated: 0, matched: 0, differ: [] };
  const columns = OWNER_COLUMNS.filter((name) => block.columns.includes(name) && types[name]);
  // The columns that say who owns a file; user_metadata rides along with them.
  const owners = columns.filter((name) => name !== "user_metadata");
  if (owners.length === 0 || !block.columns.includes("bucket_id") || !block.columns.includes("name")) return nothing;
  if (!block.columns.every((name) => /^[a-z_][a-z0-9_]*$/.test(name))) throw new StepError("The database copy's storage.objects has a column name this version does not expect.");

  const lines = [];
  for (const line of block.lines) {
    const row = copyRow(block.columns, line);
    if (!uploaded.has(`${row.bucket_id}/${row.name}`)) continue;
    if (columns.every((name) => row[name] === null)) continue;
    lines.push(line);
  }
  if (lines.length === 0) return nothing;

  const join = "o.bucket_id = t.bucket_id AND o.name = t.name";
  const value = (name) => `t."${name}"::${types[name]}`;
  const same = columns.map((name) => `o."${name}"::text IS NOT DISTINCT FROM (${value(name)})::text`).join(" AND ");
  const script = [
    `CREATE TEMP TABLE lastgood_objects (${block.columns.map((name) => `"${name}" text`).join(", ")});`,
    `COPY lastgood_objects (${block.columns.map((name) => `"${name}"`).join(", ")}) FROM stdin;`,
    ...lines,
    "\\.",
    `WITH updated AS (
      UPDATE storage.objects o SET ${columns.map((name) => `"${name}" = ${value(name)}`).join(", ")}
      FROM lastgood_objects t WHERE ${join} AND ${owners.map((name) => `o."${name}" IS NULL`).join(" AND ")} RETURNING 1)
    SELECT count(*) FROM updated;`,
    `SELECT json_build_object('matched', count(*) FILTER (WHERE same), 'differ', coalesce(json_agg(path ORDER BY path) FILTER (WHERE NOT same), '[]'))
    FROM (SELECT t.bucket_id || '/' || t.name AS path, ${same} AS same FROM lastgood_objects t JOIN storage.objects o ON ${join}) x;`,
    "",
  ].join("\n");
  const file = path.join(work, "owners.sql");
  await writeFile(file, script, { mode: 0o600 });
  const result = await run(psql, [target.url, ...quiet, "--single-transaction", "--file", file], { env: target.env });
  await rm(file, { force: true });
  if (result.code !== 0) {
    throw new StepError(
      `The new database would not set who owns each file: ${clean(result.stderr)}`,
      "The files are uploaded, but a policy that lets users reach their own files will not match them until each file's owner is set.",
    );
  }
  const [count, summary] = result.stdout.trim().split("\n").filter(Boolean);
  const after = JSON.parse(summary ?? "{}");
  return { expected: lines.length, updated: Number(count) || 0, matched: Number(after.matched) || 0, differ: Array.isArray(after.differ) ? after.differ : [] };
}

/**
 * Uploads every file in an opened files copy into a new Supabase project's buckets, checks every one is there at the
 * size it was saved and reads one back, then sets each file's owner as it was.
 */
export async function rebuildFiles({ archive, dumpPath, databaseTo, filesTo, key, work, say, todo = say, fetchImpl = fetch, sleep = defaultSleep, pgRestore = "pg_restore", psql = "psql" }) {
  const secret = checkSecretKey(key);
  const target = connection(databaseTo);
  const base = storageBase(filesTo, databaseTo);
  const storage = storageClient({ base, key: secret, fetchImpl, sleep });
  const host = storage.host;

  const dir = path.join(work, "files");
  await rm(dir, { recursive: true, force: true });
  await checkArchive(archive, "files");
  await mkdir(dir, { recursive: true });
  const extract = await run("tar", ["-xf", archive, "-C", dir, "--no-same-owner"]);
  if (extract.code !== 0) throw new StepError("The files copy did not open.");
  const copy = await filesIn(dir);
  const all = [...copy].flatMap(([bucket, files]) => files.map((entry) => ({ bucket, entry })));
  const bytes = all.reduce((total, { entry }) => total + entry.size, 0);
  const holds = `${counted(all.length, "file")} (${counted(bytes, "byte")}) in ${counted(copy.size, "bucket")}`;
  say(`The copy holds ${holds}.`);
  if (all.length === 0) return "no files in the copy";

  const dumped = await run(pgRestore, ["--data-only", "--schema", "storage", "--table", "objects", "--file", "-", dumpPath]);
  const block = dumped.code === 0 ? copyBlock(dumped.stdout, "storage.objects") : null;
  const records = new Map();
  for (const line of block?.lines ?? []) {
    const row = copyRow(block.columns, line);
    records.set(`${row.bucket_id}/${row.name}`, row);
  }
  if (!block) todo("The database copy has no records of the files, so each goes up as application/octet-stream, with no owner. Set their types and owners by hand if the app relies on them.");

  const buckets = await storage.buckets();
  const missing = [...copy.keys()].filter((bucket) => !buckets.has(bucket));
  if (missing.length > 0) {
    throw new StepError(
      `${host} has no bucket called ${missing.join(", ")}, so nothing was uploaded.`,
      "The database step puts the buckets back with their settings. Run it first, or make the bucket in Supabase as it was.",
    );
  }

  const plan = [];
  const differ = [];
  let kept = 0;
  for (const [bucket, files] of copy) {
    const there = await storage.files(bucket);
    for (const entry of files) {
      const size = there.get(entry.name);
      if (size === undefined) plan.push({ bucket, entry });
      else if (size === entry.size) kept += 1;
      else differ.push(`${bucket}/${entry.name}`);
    }
  }
  if (differ.length > 0) {
    throw new StepError(
      `${host} already has ${counted(differ.length, "file")} at the same path as the copy but a different size (${listed(differ)}). Nothing was uploaded: rebuild never writes over a file.`,
    );
  }
  if (kept > 0) say(`${counted(kept, "file")} ${kept === 1 ? "was" : "were"} already in ${host} at the same size, from an earlier run, and ${kept === 1 ? "is" : "are"} kept.`);
  const unrecorded = block ? plan.filter(({ bucket, entry }) => !records.has(`${bucket}/${entry.name}`)).length : 0;
  if (unrecorded > 0) {
    todo(`${counted(unrecorded, "file")} in the files copy ${unrecorded === 1 ? "has" : "have"} no record in the database copy, most likely added between the two, so ${unrecorded === 1 ? "it goes" : "they go"} up as application/octet-stream, with no owner.`);
  }

  const tooLarge = [];
  const wrongType = [];
  const failed = [];
  let sent = 0;
  let sentBytes = 0;
  let next = 0;
  async function worker() {
    while (next < plan.length) {
      const { bucket, entry } = plan[next];
      next += 1;
      const refusal = await storage.upload(bucket, entry, fileMeta(records.get(`${bucket}/${entry.name}`)));
      // 409: another upload put it there first. The check below holds it to the copy's size.
      if (!refusal || refusal.status === 409) {
        sent += 1;
        sentBytes += entry.size;
      } else if (refusal.status === 413) tooLarge.push(`${bucket}/${entry.name} (${counted(entry.size, "byte")})`);
      else if (refusal.status === 415) wrongType.push(`${bucket}/${entry.name}`);
      else failed.push(`${bucket}/${entry.name}: ${refusal.message}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, plan.length) }, worker));
  if (plan.length > 0) say(`Uploaded ${counted(sent, "file")} (${counted(sentBytes, "byte")}).`);
  if (tooLarge.length + wrongType.length + failed.length > 0) {
    const parts = [];
    if (tooLarge.length > 0) parts.push(`${counted(tooLarge.length, "file")} larger than the new project takes (${listed(tooLarge)})`);
    if (wrongType.length > 0) parts.push(`${counted(wrongType.length, "file")} of a type its bucket does not take (${listed(wrongType)})`);
    if (failed.length > 0) parts.push(`${counted(failed.length, "file")} Supabase did not take (${listed(failed)})`);
    throw new StepError(
      `Not every file went in: ${parts.join("; ")}.`,
      "Raise the new project's upload size limit (Storage settings) or the bucket's limits where needed, then run this again with --skip database. Files already uploaded are kept and not sent again.",
    );
  }

  // Every file in the copy is there at the size it was saved.
  for (const [bucket, files] of copy) {
    const there = await storage.files(bucket);
    const wrong = files.filter((entry) => there.get(entry.name) !== entry.size).map((entry) => `${bucket}/${entry.name}`);
    if (wrong.length > 0) throw new StepError(`${host} does not hold ${counted(wrong.length, "file")} at the size it was saved (${listed(wrong)}).`);
  }
  say(`${host} holds every file in the copy at the size it was saved: ${holds}.`);
  const sample = all.filter(({ entry }) => entry.size > 0).sort((left, right) => left.entry.size - right.entry.size)[0];
  if (sample) {
    const back = await storage.read(sample.bucket, sample.entry.name);
    const local = await readFile(sample.entry.file);
    if (sha256(back) !== sha256(local)) throw new StepError(`A file read back from ${sample.bucket} does not match the copy.`);
    say(`A sample file of ${counted(sample.entry.size, "byte")} read back the same as the copy.`);
  }

  if (block) {
    const owners = await restoreOwners({ target, block, uploaded: new Set(all.map(({ bucket, entry }) => `${bucket}/${entry.name}`)), work, psql });
    if (owners.expected > 0) {
      const already = owners.matched - owners.updated;
      say(
        `Owners: set ${owners.updated} of the ${owners.expected} the database copy names${already > 0 ? `, and ${already} already had theirs from an earlier run` : ""}, so policies that let users reach their own files still match.`,
      );
    }
    if (owners.differ.length > 0) {
      throw new StepError(
        `${counted(owners.differ.length, "file")} in ${host} already ${owners.differ.length === 1 ? "has" : "have"} an owner other than the database copy's (${listed(owners.differ)}), so ${owners.differ.length === 1 ? "it was" : "they were"} left as ${owners.differ.length === 1 ? "it is" : "they are"}.`,
        "Check those files' owners in the new project before you use it: a policy that lets users reach their own files will not match them as before.",
      );
    }
    if (owners.matched !== owners.expected) {
      throw new StepError(
        `Owners match for ${owners.matched} of the ${owners.expected} files the database copy names.`,
        "Check that --database-to is the same project as the files. A policy that lets users reach their own files will not match a file without its owner.",
      );
    }
  }
  return `${counted(all.length, "file")} in ${counted(copy.size, "bucket")}`;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Up to three items, then how many more. */
function listed(items) {
  return `${items.slice(0, 3).join(", ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""}`;
}
