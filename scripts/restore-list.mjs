/**
 * Builds a pg_restore -L list that skips extensions the target does not offer,
 * and classifies leftover pg_restore errors.
 * A missing extension is a warning. A data error fails the restore test.
 * PostGIS is not Supabase-only: a dump that needs it gets a target that offers it, or the test stops.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** PostGIS extensions. A target that lacks one the dump needs is an error, not a warning. */
export const POSTGIS_EXTENSIONS = ["postgis", "postgis_raster", "postgis_topology", "postgis_sfcgal"];

/** PostGIS release in the fallback image. An exact major-minor tag, never latest. */
export const POSTGIS_VERSION = "3.5";

const POSTGIS_TYPE_EXTENSION = { geometry: "postgis", geography: "postgis", raster: "postgis_raster" };
const POSTGIS_MAJORS = new Set([12, 13, 14, 15, 16, 17]);

/** Schemas created by extensions that pg_dump also emits as user objects. */
export const EXTENSION_SCHEMAS = {
  pg_cron: ["cron"],
  pg_net: ["net"],
  pgsodium: ["pgsodium"],
  supabase_vault: ["vault"],
  pg_graphql: ["graphql", "graphql_public"],
  pg_tle: ["pgtle"],
  wrappers: ["wrappers"],
  pgmq: ["pgmq"],
  timescaledb: [
    "_timescaledb_catalog",
    "_timescaledb_internal",
    "_timescaledb_cache",
    "_timescaledb_config",
    "timescaledb_experimental",
    "timescaledb_information",
  ],
};

const DESCRIPTIONS = [
  "MATERIALIZED VIEW DATA",
  "TEXT SEARCH CONFIGURATION",
  "TEXT SEARCH DICTIONARY",
  "TEXT SEARCH TEMPLATE",
  "TEXT SEARCH PARSER",
  "FOREIGN DATA WRAPPER",
  "MATERIALIZED VIEW",
  "PUBLICATION TABLE",
  "SEQUENCE OWNED BY",
  "PROCEDURAL LANGUAGE",
  "OPERATOR FAMILY",
  "OPERATOR CLASS",
  "USER MAPPING",
  "FK CONSTRAINT",
  "SEQUENCE SET",
  "DEFAULT ACL",
  "ROW SECURITY",
  "EVENT TRIGGER",
  "ACCESS METHOD",
  "LARGE OBJECT",
  "SHELL TYPE",
  "TABLE DATA",
  "PUBLICATION",
  "SUBSCRIPTION",
  "CONSTRAINT",
  "EXTENSION",
  "COLLATION",
  "CONVERSION",
  "AGGREGATE",
  "PROCEDURE",
  "TRANSFORM",
  "FUNCTION",
  "SEQUENCE",
  "COMMENT",
  "TRIGGER",
  "SCHEMA",
  "DOMAIN",
  "POLICY",
  "SERVER",
  "TABLE",
  "INDEX",
  "RULE",
  "CAST",
  "TYPE",
  "VIEW",
  "BLOB",
  "ACL",
];

const SAMPLE_LIMIT = 3;
const SAMPLE_BYTES = 32 * 1024 * 1024;
const SKIPPED_SYSTEM = new Set(["pg_catalog", "information_schema", "pg_toast"]);

/** Schemas a stock or Supabase image already has, and that the dump must reuse. */
const KEPT_SCHEMAS = new Set(["public", "information_schema"]);

function extensionSchemaNames() {
  const names = new Set(["extensions"]);
  for (const schemas of Object.values(EXTENSION_SCHEMAS)) {
    for (const schema of schemas) names.add(schema);
  }
  return names;
}

const EXTENSION_SCHEMA_NAMES = extensionSchemaNames();

export function schemasToDrop(_toc, existingNames) {
  return identList(existingNames).filter((name) => !keptSchema(name));
}

export function dropSchemaSql(names) {
  return (names ?? [])
    .filter((name) => simpleIdent(name) && !keptSchema(name))
    .map((name) => `DROP SCHEMA IF EXISTS ${name} CASCADE;`)
    .join("\n");
}

const ROLE_SQL = `DO $lifeboat_roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'supabase_admin', 'authenticator']
  LOOP
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', role_name);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat role skipped: %', SQLERRM;
    END;
  END LOOP;
END
$lifeboat_roles$;`;

/**
 * Clears public of objects the image or a previous test left behind.
 * Extension members stay. One object that will not drop does not stop the rest.
 */
const PUBLIC_SWEEP_SQL = `DO $lifeboat_public$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relkind, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      IF r.relkind IN ('r', 'p') THEN
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'v' THEN
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'm' THEN
        EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS public.%I CASCADE', r.relname);
      ELSIF r.relkind = 'S' THEN
        EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.relname);
      ELSE
        EXECUTE format('DROP FOREIGN TABLE IF EXISTS public.%I CASCADE', r.relname);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat drop skipped: %', SQLERRM;
    END;
  END LOOP;
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END AS kind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      EXECUTE format('DROP %s IF EXISTS public.%I(%s) CASCADE', r.kind, r.proname, r.args);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat drop skipped: %', SQLERRM;
    END;
  END LOOP;
  FOR r IN
    SELECT t.typname, CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END AS kind
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c', 'd', 'r') AND t.typrelid = 0
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
      )
  LOOP
    BEGIN
      EXECUTE format('DROP %s IF EXISTS public.%I CASCADE', r.kind, r.typname);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'lifeboat drop skipped: %', SQLERRM;
    END;
  END LOOP;
END
$lifeboat_public$;`;

/**
 * SQL for a disposable restore target. Roles are created when missing.
 * Event triggers go first so they cannot block the drops. Publications go
 * next, then objects already in public, then every non-system schema except
 * public and schemas an extension owns. pg_* schemas stay.
 */
export function throwawayDropSql(toc, catalog = {}) {
  const eventTriggers = identList(catalog.eventTriggers);
  const publications = identList(catalog.publications);
  const schemas = schemasToDrop(toc, catalog.schemas);
  const publicObjects = publicObjectDrops(toc);
  const lines = [ROLE_SQL];
  for (const name of eventTriggers) {
    lines.push(`ALTER EVENT TRIGGER ${name} DISABLE;`);
    lines.push(`DROP EVENT TRIGGER IF EXISTS ${name};`);
  }
  for (const name of publications) lines.push(`DROP PUBLICATION IF EXISTS ${name};`);
  lines.push(...publicObjects);
  for (const name of schemas) lines.push(`DROP SCHEMA IF EXISTS ${name} CASCADE;`);
  lines.push(PUBLIC_SWEEP_SQL);
  return { sql: lines.join("\n"), eventTriggers, publications, schemas, publicObjects };
}

/** Objects in public that the dump recreates. public itself stays. */
function publicObjectDrops(toc) {
  const lines = [];
  const seen = new Set();
  for (const entry of String(toc).split("\n").map(parseTocLine)) {
    if (!entry || entry.namespace !== "public") continue;
    const statement = publicDropStatement(entry);
    if (!statement || seen.has(statement)) continue;
    seen.add(statement);
    lines.push(statement);
  }
  return lines;
}

function publicDropStatement(entry) {
  if (entry.desc === "TABLE" && simpleIdent(entry.tag)) return `DROP TABLE IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "VIEW" && simpleIdent(entry.tag)) return `DROP VIEW IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "MATERIALIZED VIEW" && simpleIdent(entry.tag)) return `DROP MATERIALIZED VIEW IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "SEQUENCE" && simpleIdent(entry.tag)) return `DROP SEQUENCE IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "TYPE" && simpleIdent(entry.tag)) return `DROP TYPE IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "DOMAIN" && simpleIdent(entry.tag)) return `DROP DOMAIN IF EXISTS public.${entry.tag} CASCADE;`;
  if (entry.desc === "FUNCTION" || entry.desc === "PROCEDURE" || entry.desc === "AGGREGATE") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\([^)]*\)$/.test(entry.tag) || /[;`]/.test(entry.tag)) return null;
    return `DROP ${entry.desc} IF EXISTS public.${entry.tag} CASCADE;`;
  }
  return null;
}

export function filterRestoreList(toc, availableNames, options = {}) {
  const available = nameSet(availableNames);
  const existingSchemas = nameSet(options.existingSchemas);
  const installed = nameSet(options.installedExtensions);
  const existingPublications = nameSet(options.existingPublications);
  const existingEventTriggers = nameSet(options.existingEventTriggers);
  const lines = String(toc).split("\n");
  const parsed = lines.map(parseTocLine);
  const skippedExtensions = new Set();
  const installedExtensions = new Set();
  for (const entry of parsed) {
    if (!entry || entry.desc !== "EXTENSION") continue;
    const name = entry.tag;
    if (!name || name === "-" || !simpleIdent(name)) continue;
    if (!available.has(name)) skippedExtensions.add(name);
    else if (installed.has(name)) installedExtensions.add(name);
  }
  const skippedSchemas = new Set();
  for (const name of skippedExtensions) {
    for (const schema of EXTENSION_SCHEMAS[name] ?? []) skippedSchemas.add(schema);
  }
  const preexistingSchemas = new Set();
  const preexistingPublications = new Set();
  const preexistingEventTriggers = new Set();
  for (const entry of parsed) {
    if (!entry) continue;
    if (entry.desc === "SCHEMA" && existingSchemas.has(entry.tag)) preexistingSchemas.add(entry.tag);
    if (entry.desc === "PUBLICATION" && existingPublications.has(entry.tag)) preexistingPublications.add(entry.tag);
    if (entry.desc === "EVENT TRIGGER" && existingEventTriggers.has(entry.tag)) preexistingEventTriggers.add(entry.tag);
  }
  const skipState = {
    unavailable: skippedExtensions,
    installed: installedExtensions,
    extensionSchemas: skippedSchemas,
    existingSchemas: preexistingSchemas,
    existingPublications: preexistingPublications,
    existingEventTriggers: preexistingEventTriggers,
  };
  const text = lines
    .map((line, index) => {
      const entry = parsed[index];
      if (!entry || !shouldSkip(entry, skipState)) return line;
      return line.startsWith(";") ? line : `;${line}`;
    })
    .join("\n");
  return {
    text,
    skippedExtensions: [...skippedExtensions].sort(),
    skippedSchemas: [...skippedSchemas].sort(),
    preexistingSchemas: [...preexistingSchemas].sort(),
    installedExtensions: [...installedExtensions].sort(),
    preexistingPublications: [...preexistingPublications].sort(),
    preexistingEventTriggers: [...preexistingEventTriggers].sort(),
  };
}

/** PostGIS extensions that have an EXTENSION entry in `pg_restore --list`. */
export function postgisExtensionsInToc(toc) {
  const found = new Set();
  for (const entry of String(toc).split("\n").map(parseTocLine)) {
    if (entry?.desc === "EXTENSION" && POSTGIS_EXTENSIONS.includes(entry.tag)) found.add(entry.tag);
  }
  return [...found].sort();
}

const SQL_IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const POSTGIS_TYPE_REF = String.raw`(${SQL_IDENT})\.(?:"(geometry|geography|raster)"|(geometry|geography|raster))(?![A-Za-z0-9_$."])`;
const ARG_MODE = String.raw`(?:(?:IN|OUT|INOUT|VARIADIC)[ \t]+)?`;
/** A column, attribute or named argument: `geom extensions.geometry(Point,4326)`. */
const POSTGIS_COLUMN = new RegExp(String.raw`(?:^|[(,])[ \t]*${ARG_MODE}(${SQL_IDENT})[ \t]+${POSTGIS_TYPE_REF}`, "gm");
/** A cast, a return type, a domain base type, or an aggregate or operator type. */
const POSTGIS_KEYWORD = new RegExp(String.raw`(?:::|\bRETURNS(?:\s+SETOF)?\s+|\bAS\s+|\b(?:STYPE|LEFTARG|RIGHTARG)\s*=\s*)${POSTGIS_TYPE_REF}`, "g");
/** Unnamed arguments in a function signature: `public.near(extensions.geography, double precision)`. */
const ROUTINE_ARGS = new RegExp(String.raw`\b(?:FUNCTION|PROCEDURE|AGGREGATE)\s+${SQL_IDENT}\.${SQL_IDENT}\(([^)]*)\)`, "g");
const POSTGIS_ARG = new RegExp(String.raw`(?:^|,)\s*${ARG_MODE}${POSTGIS_TYPE_REF}`, "g");
/**
 * Words pg_dump leaves unquoted before a relation name, as in `JOIN public.geometry g`.
 * A column with one of these names is always quoted, so it cannot be mistaken for one.
 */
const RELATION_WORDS = new Set([
  "FROM", "JOIN", "ON", "ONLY", "TABLE", "INTO", "UPDATE", "REFERENCES", "USING", "LATERAL", "VIEW",
  "INDEX", "SEQUENCE", "INHERITS", "OF", "TO", "WITH", "SELECT", "WHERE", "AND", "OR", "NOT", "BY",
  "IN", "IS", "EXISTS", "TRIGGER", "POLICY", "TYPE", "DOMAIN", "FUNCTION", "PROCEDURE", "AGGREGATE",
]);

/** Comments, dollar-quoted bodies and string literals cannot hold a column type. */
function sqlWithoutLiterals(sql) {
  return String(sql).replace(
    /--[^\n]*|(?<![A-Za-z0-9_$])\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|'(?:[^']|'')*'/g,
    (match) => (match.startsWith("--") ? "" : "''"),
  );
}

function unquoteIdent(value) {
  return value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value;
}

/**
 * Schema-qualified geometry, geography and raster types used in `pg_restore --schema-only` output.
 * pg_dump qualifies every type outside pg_catalog, so Supabase's PostGIS appears as `extensions.geometry`.
 */
export function postgisTypesInSql(schemaSql) {
  const sql = sqlWithoutLiterals(schemaSql);
  const found = new Set();
  const add = (schema, quoted, bare) => found.add(`${unquoteIdent(schema)}.${quoted ?? bare}`);
  for (const match of sql.matchAll(POSTGIS_COLUMN)) {
    if (RELATION_WORDS.has(match[1])) continue;
    add(match[2], match[3], match[4]);
  }
  for (const match of sql.matchAll(POSTGIS_KEYWORD)) add(match[1], match[2], match[3]);
  for (const routine of sql.matchAll(ROUTINE_ARGS)) {
    for (const match of String(routine[1]).matchAll(POSTGIS_ARG)) add(match[1], match[2], match[3]);
  }
  return [...found].sort();
}

/** Which PostGIS extensions the dump needs. Any PostGIS use needs `postgis` itself. */
export function postgisNeeds(toc, schemaSql) {
  const extensions = postgisExtensionsInToc(toc);
  const types = postgisTypesInSql(schemaSql);
  const required = new Set(extensions);
  for (const type of types) required.add(POSTGIS_TYPE_EXTENSION[type.slice(type.lastIndexOf(".") + 1)]);
  if (required.size > 0) required.add("postgis");
  return { needed: required.size > 0, extensions, types, required: [...required].sort() };
}

/** The PostGIS image for a Postgres major, such as postgis/postgis:17-3.5. */
export function postgisImage(major) {
  const value = Number(major);
  return POSTGIS_MAJORS.has(value) ? `postgis/postgis:${value}-${POSTGIS_VERSION}` : null;
}

/** An image with an exact tag or digest. `latest`, a bare name, or anything else is refused. */
export function pinnedImage(value) {
  const image = String(value ?? "").trim();
  if (/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(image)) return image;
  const tagged = image.match(/^[a-z0-9][a-z0-9._/:-]*:([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/);
  if (!tagged || tagged[1] === "latest") return null;
  return image;
}

/** The configured image when it is pinned, otherwise the image for this major. */
export function resolvePostgisImage(configured, major) {
  return String(configured ?? "").trim() ? pinnedImage(configured) : postgisImage(major);
}

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The URL of the PostGIS container that replaces the restore database.
 * It keeps the host and port, and uses the stock image's user and database.
 * The password is the word throwaway, as in the workflow. Only a database on this runner is replaced.
 */
export function postgisTargetUrl(restoreUrl) {
  let parsed;
  try {
    parsed = new URL(String(restoreUrl ?? ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return null;
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const hostText = host.includes(":") ? `[${host}]` : host;
  return { url: `postgresql://postgres:throwaway@${hostText}:${port}/restore`, port };
}

function describePostgisUse(needs) {
  const parts = [];
  if (needs.extensions.length > 0) {
    parts.push(`${needs.extensions.length === 1 ? "extension" : "extensions"} ${needs.extensions.join(", ")}`);
  }
  if (needs.types.length > 0) parts.push(`${needs.types.length === 1 ? "type" : "types"} ${needs.types.join(", ")}`);
  return parts.join("; ");
}

/**
 * Decides what the restore test does about PostGIS before anything is restored.
 * none: the dump does not use it. ok: the target offers it. switch: replace the throwaway
 * container with a PostGIS image. fail: stop, and name PostGIS, instead of a cascade of
 * `type "extensions.geometry" does not exist` errors.
 */
export function planPostgis(options) {
  const needs = postgisNeeds(options.toc, options.schemaSql);
  const image = options.image ?? null;
  const base = { ...needs, missing: [], container: "", image: image ?? "", url: "", port: 0 };
  if (!needs.needed) return { ...base, decision: "none", message: "The dump does not use PostGIS." };
  const offered = nameSet(options.available);
  const missing = needs.required.filter((name) => !offered.has(name));
  const uses = describePostgisUse(needs);
  if (missing.length === 0) {
    return { ...base, decision: "ok", message: `The dump uses PostGIS (${uses}). The restore database offers ${needs.required.join(", ")}.` };
  }
  const lacking = missing.join(", ");
  const stop = (reason) => ({
    ...base,
    missing,
    decision: "fail",
    message: `The dump uses PostGIS (${uses}), and the restore database does not offer ${lacking}. PostGIS is not a Supabase-only extension, so it is not skipped. ${reason} The restore test stopped before restoring.`,
  });
  if (options.switched) return stop(`The PostGIS image ${image} started but does not offer ${lacking} either.`);
  const container = String(options.container ?? "").trim();
  const suggestion = image ?? "a PostGIS image such as postgis/postgis:17-3.5";
  if (!container) {
    return stop(`Lifeboat was not given a throwaway container to replace (LIFEBOAT_RESTORE_CONTAINER). Start the restore database from ${suggestion}.`);
  }
  if (!CONTAINER_NAME.test(container)) return stop("LIFEBOAT_RESTORE_CONTAINER is not a container name.");
  if (!image) {
    return stop("There is no pinned PostGIS image for this Postgres major. Set LIFEBOAT_RESTORE_POSTGIS_IMAGE to an exact tag such as postgis/postgis:17-3.5, not latest.");
  }
  const target = postgisTargetUrl(options.restoreUrl);
  if (!target) return stop("The restore database is not on localhost, so Lifeboat cannot replace it.");
  return {
    ...base,
    missing,
    decision: "switch",
    container,
    url: target.url,
    port: target.port,
    message: `The dump uses PostGIS (${uses}) and the restore database does not offer ${lacking}. Replacing container ${container} with ${image}.`,
  };
}

/** A restore error that means PostGIS was missing, whatever path led there. */
export function isPostgisTypeError(line) {
  return /type "(?:[^"]*\.)?(?:geometry|geography|raster)" does not exist/i.test(String(line));
}

export function classifyRestoreErrors(stderr, skipped) {
  const extensions = new Set(skipped?.extensions ?? skipped?.skippedExtensions ?? []);
  const schemas = new Set(skipped?.schemas ?? skipped?.skippedSchemas ?? []);
  const preexisting = new Set(skipped?.preexisting ?? skipped?.preexistingSchemas ?? []);
  const installed = new Set(skipped?.installed ?? skipped?.installedExtensions ?? []);
  const fatal = [];
  const warnings = [];
  for (const line of String(stderr).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !/error:/i.test(trimmed)) continue;
    if (isDataError(trimmed)) fatal.push(trimmed);
    else if (isAlreadyExists(trimmed) || isExtensionWarning(trimmed, extensions, schemas) || isPreexistingObject(trimmed, preexisting, installed)) {
      warnings.push(trimmed);
    } else fatal.push(trimmed);
  }
  return { fatal, warnings };
}

/**
 * Small user tables whose restored count is compared with the dump.
 * TABLE DATA with no TABLE entry is an extension's config table, such as PostGIS's
 * extensions.spatial_ref_sys. The extension fills it on create, so its count cannot match the dump.
 */
export function selectSampleTables(toc, skipped, limit = SAMPLE_LIMIT) {
  const schemas = new Set(skipped?.schemas ?? skipped?.skippedSchemas ?? []);
  const entries = String(toc).split("\n").map(parseTocLine);
  const tables = new Set(entries.filter((entry) => entry?.desc === "TABLE").map((entry) => `${entry.namespace}.${entry.tag}`));
  const found = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || entry.desc !== "TABLE DATA") continue;
    if (!simpleIdent(entry.namespace) || !simpleIdent(entry.tag)) continue;
    if (SKIPPED_SYSTEM.has(entry.namespace) || schemas.has(entry.namespace)) continue;
    const key = `${entry.namespace}.${entry.tag}`;
    if (!tables.has(key) || seen.has(key)) continue;
    seen.add(key);
    found.push({ schema: entry.namespace, table: entry.tag, preferred: entry.namespace === "public" });
  }
  found.sort((left, right) => Number(right.preferred) - Number(left.preferred));
  return found.slice(0, Math.max(0, limit));
}

export function countCopyRows(sql) {
  let counting = false;
  let count = 0;
  for (const line of String(sql).split("\n")) {
    if (!counting) {
      if (line.startsWith("COPY ")) counting = true;
      continue;
    }
    if (line === "\\.") return count;
    count += 1;
  }
  return counting ? count : null;
}

export function sanitiseRestoreLine(line) {
  return String(line)
    .replace(/postgresql:\/\/[^\s]+/gi, "postgresql://redacted")
    .replace(/:\/\/[^/\s:@]+:[^@\s]+@/g, "://redacted@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function nameSet(values) {
  return new Set((values ?? []).map((name) => String(name).trim()).filter((name) => name.length > 0));
}

function keptSchema(name) {
  return KEPT_SCHEMAS.has(name) || name.startsWith("pg_") || EXTENSION_SCHEMA_NAMES.has(name);
}

function shouldSkip(entry, state) {
  const extensions = new Set([...state.unavailable, ...state.installed]);
  if (entry.desc === "EXTENSION" && extensions.has(entry.tag)) return true;
  if (entry.desc === "PUBLICATION" && state.existingPublications.has(entry.tag)) return true;
  if (entry.desc === "EVENT TRIGGER" && state.existingEventTriggers.has(entry.tag)) return true;
  if (entry.desc === "COMMENT") {
    const named = entry.tag.match(/^(EXTENSION|SCHEMA|PUBLICATION|EVENT TRIGGER)\s+(\S+)$/);
    if (named?.[1] === "EXTENSION" && extensions.has(named[2])) return true;
    if (named?.[1] === "SCHEMA" && (state.extensionSchemas.has(named[2]) || state.existingSchemas.has(named[2]))) return true;
    if (named?.[1] === "PUBLICATION" && state.existingPublications.has(named[2])) return true;
    if (named?.[1] === "EVENT TRIGGER" && state.existingEventTriggers.has(named[2])) return true;
  }
  if (entry.desc === "SCHEMA" && (state.extensionSchemas.has(entry.tag) || state.existingSchemas.has(entry.tag))) return true;
  if (entry.namespace && state.extensionSchemas.has(entry.namespace)) return true;
  return false;
}

function identList(names) {
  return [...nameSet(names)].filter(simpleIdent).sort();
}

function parseTocLine(line) {
  if (!line || line.startsWith(";") || !/^\d+;/.test(line)) return null;
  const match = line.match(/^\d+;\s+\d+\s+\d+\s+(.*\S)\s*$/);
  if (!match?.[1]) return null;
  const rest = match[1];
  let desc = null;
  for (const candidate of DESCRIPTIONS) {
    if (rest === candidate || rest.startsWith(`${candidate} `)) {
      desc = candidate;
      break;
    }
  }
  if (!desc) return null;
  const parts = rest.slice(desc.length).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const namespace = parts[0];
  // An entry with no owner, such as an extension's comment, ends in a space: then every word after the namespace is the tag.
  const hasOwner = parts.length >= 3 && !/\s$/.test(line.replace(/\r$/, ""));
  const owner = hasOwner ? parts[parts.length - 1] : null;
  const tag = hasOwner ? parts.slice(1, -1).join(" ") : parts.slice(1).join(" ");
  return { desc, namespace, tag, owner };
}

function simpleIdent(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isDataError(line) {
  return /COPY failed|invalid input syntax|duplicate key value|extra data after last expected column|missing data for column|could not extend file|No space left on device|out of memory|connection to server|server closed the connection|password authentication failed|could not connect|too many connections/i.test(
    line,
  );
}

function isAlreadyExists(line) {
  return /already exists|already member of publication/i.test(line);
}

function isPreexistingObject(line, preexisting, installed) {
  const schema = line.match(/schema "([^"]+)" already exists/i);
  if (schema && preexisting.has(schema[1])) return true;
  const extension = line.match(/extension "([^"]+)" already exists/i);
  return Boolean(extension && installed.has(extension[1]));
}

function isExtensionWarning(line, extensions, schemas) {
  const named = line.match(/extension "([^"]+)"/i);
  if (named && extensions.has(named[1])) return true;
  const schema = line.match(/schema "([^"]+)"/i);
  if (schema && schemas.has(schema[1])) return true;
  const qualified = line.match(/"([A-Za-z_][A-Za-z0-9_]*)\.[^"]*"/);
  if (qualified && schemas.has(qualified[1])) return true;
  for (const name of extensions) {
    if (name && line.includes(name)) return true;
  }
  return false;
}

function readSkipped(path) {
  const body = JSON.parse(readFileSync(path, "utf8"));
  return {
    extensions: Array.isArray(body.extensions) ? body.extensions : [],
    schemas: Array.isArray(body.schemas) ? body.schemas : [],
    preexisting: Array.isArray(body.preexisting) ? body.preexisting : [],
    installed: Array.isArray(body.installed) ? body.installed : [],
    publications: Array.isArray(body.publications) ? body.publications : [],
    eventTriggers: Array.isArray(body.eventTriggers) ? body.eventTriggers : [],
  };
}

function readNames(path) {
  return path ? readFileSync(path, "utf8").split(/\s+/) : [];
}

async function runFilter(tocPath, extensionsPath, outPath, skipPath, schemasPath, installedPath, publicationsPath, eventTriggersPath) {
  const result = filterRestoreList(readFileSync(tocPath, "utf8"), readNames(extensionsPath), {
    existingSchemas: readNames(schemasPath),
    installedExtensions: readNames(installedPath),
    existingPublications: readNames(publicationsPath),
    existingEventTriggers: readNames(eventTriggersPath),
  });
  writeFileSync(outPath, result.text.endsWith("\n") ? result.text : `${result.text}\n`);
  writeFileSync(
    skipPath,
    JSON.stringify({
      extensions: result.skippedExtensions,
      schemas: result.skippedSchemas,
      preexisting: result.preexistingSchemas,
      installed: result.installedExtensions,
      publications: result.preexistingPublications,
      eventTriggers: result.preexistingEventTriggers,
    }),
  );
  const names = result.skippedExtensions.join(", ");
  const kept = result.preexistingSchemas.join(", ");
  const publications = result.preexistingPublications.join(", ");
  const triggers = result.preexistingEventTriggers.join(", ");
  process.stdout.write(`Restore list skipped extensions: ${names || "none"}.\n`);
  process.stdout.write(`Restore list kept existing schemas: ${kept || "none"}.\n`);
  process.stdout.write(`Restore list kept existing publications: ${publications || "none"}.\n`);
  process.stdout.write(`Restore list kept existing event triggers: ${triggers || "none"}.\n`);
}

function runDropSql(tocPath, schemasPath, outPath, publicationsPath, eventTriggersPath) {
  const drop = throwawayDropSql(readFileSync(tocPath, "utf8"), {
    schemas: readNames(schemasPath),
    publications: readNames(publicationsPath),
    eventTriggers: readNames(eventTriggersPath),
  });
  writeFileSync(outPath, drop.sql ? `${drop.sql}\n` : "");
  process.stdout.write(`Throwaway event triggers to drop: ${drop.eventTriggers.join(", ") || "none"}.\n`);
  process.stdout.write(`Throwaway publications to drop: ${drop.publications.join(", ") || "none"}.\n`);
  process.stdout.write(`Throwaway schemas to drop: ${drop.schemas.join(", ") || "none"}.\n`);
}

function runClassify(errPath, skipPath, statusText) {
  const status = Number(statusText);
  const result = classifyRestoreErrors(readFileSync(errPath, "utf8"), readSkipped(skipPath));
  for (const warning of result.warnings) {
    process.stdout.write(`Restore warning: ${sanitiseRestoreLine(warning)}\n`);
  }
  if (result.fatal.length > 0 || (status !== 0 && result.warnings.length === 0)) {
    const message = result.fatal[0] ? sanitiseRestoreLine(result.fatal[0]) : "pg_restore failed.";
    const postgis = result.fatal.some(isPostgisTypeError) ? "the restore database does not have PostGIS. " : "";
    process.stderr.write(`Restore failed: ${postgis}${message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Writes the PostGIS plan for run.sh, one value per line:
 * decision, message, container, image, port, url.
 */
function runPostgisPlan(tocPath, schemaPath, extensionsPath, outPath, switchedText) {
  const image = resolvePostgisImage(process.env.LIFEBOAT_RESTORE_POSTGIS_IMAGE, process.env.POSTGRES_MAJOR || "17");
  const plan = planPostgis({
    toc: readFileSync(tocPath, "utf8"),
    schemaSql: readFileSync(schemaPath, "utf8"),
    available: readNames(extensionsPath),
    container: process.env.LIFEBOAT_RESTORE_CONTAINER ?? "",
    image,
    restoreUrl: process.env.RESTORE_DATABASE_URL ?? "",
    switched: switchedText === "switched",
  });
  const lines = [plan.decision, plan.message, plan.container, plan.image, String(plan.port || ""), plan.url];
  writeFileSync(outPath, `${lines.map((line) => String(line).replace(/[\r\n]+/g, " ")).join("\n")}\n`);
}

function commandOutput(command, args, spawnImpl) {
  const run = spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = run(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(sanitiseRestoreLine(stderr || `${command} failed.`)));
      else resolve(stdout);
    });
  });
}

export async function verifySampleCounts(options) {
  const tables = selectSampleTables(options.toc, options.skipped, 12).slice(0, 12);
  let checked = 0;
  for (const table of tables) {
    if (checked >= SAMPLE_LIMIT) break;
    const sizeSql = `SELECT COALESCE(pg_total_relation_size(format('%I.%I', '${table.schema}', '${table.table}')), -1)`;
    const sizeText = await commandOutput(
      options.psql,
      [options.databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--command", sizeSql],
      options.spawnImpl,
    );
    const size = Number(String(sizeText).trim());
    if (!Number.isFinite(size) || size < 0 || size > SAMPLE_BYTES) continue;
    const countSql = `SELECT count(*) FROM ${table.schema}.${table.table}`;
    const restoredText = await commandOutput(
      options.psql,
      [options.databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--command", countSql],
      options.spawnImpl,
    );
    const restored = Number(String(restoredText).trim());
    const archive = await commandOutput(
      options.pgRestore,
      ["-a", "-n", table.schema, "-t", table.table, "-f", "-", options.dumpPath],
      options.spawnImpl,
    );
    const dumped = countCopyRows(archive);
    if (!Number.isFinite(restored) || dumped === null) {
      throw new Error(`Row count for ${table.schema}.${table.table} could not be read.`);
    }
    if (restored !== dumped) {
      throw new Error(`Row count mismatch for ${table.schema}.${table.table}: restored ${restored}, dump ${dumped}.`);
    }
    checked += 1;
    process.stdout.write(`Row count matched for ${table.schema}.${table.table}: ${restored}.\n`);
  }
  if (checked === 0) {
    process.stdout.write("Row-count sample skipped: no small user table in the dump.\n");
  }
}

async function runSample(tocPath, skipPath, dumpPath) {
  const databaseUrl = process.env.RESTORE_DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("Set RESTORE_DATABASE_URL to the throwaway Postgres in this runner.");
  await verifySampleCounts({
    toc: readFileSync(tocPath, "utf8"),
    skipped: readSkipped(skipPath),
    dumpPath,
    psql: process.env.LIFEBOAT_PSQL || "psql",
    pgRestore: process.env.LIFEBOAT_PG_RESTORE || "pg_restore",
    databaseUrl,
  });
}

/** Column names from a COPY header line, such as `COPY auth.users (id, email, encrypted_password) FROM stdin;`. */
export function copyColumns(header) {
  const match = String(header).match(/^COPY\s+\S+\s+\((.*)\)\s+FROM stdin;$/);
  if (!match) return [];
  return match[1].split(",").map((name) => name.trim().replace(/^"(.*)"$/, "$1"));
}

/**
 * The storage login LastGood makes on the customer's project (`STORAGE_LOGIN_EMAIL` in lib/supabase/storage-login.ts).
 * It is LastGood's, not one of the app's users, so the users count and the restore check leave it out (#98, A).
 */
export const STORAGE_LOGIN_EMAIL = "lastgood-backup@lastgood.invalid";

/**
 * Counts the rows of one COPY block, fed a line at a time, and how many have a value in `column`.
 * Never keeps a row, so an email or a password hash is read once and forgotten. A row whose `skip.column` holds one of
 * `skip.values` is left out of the counts; its `skip.capture` value is kept, so a later table can leave out its rows too.
 */
export function copyCounter(column = null, skip = null) {
  let started = false;
  let done = false;
  let index = -1;
  let skipIndex = -1;
  let captureIndex = -1;
  let rows = 0;
  let withValue = 0;
  const skipped = [];
  return {
    line(text) {
      if (done) return;
      if (!started) {
        if (text.startsWith("COPY ")) {
          started = true;
          const columns = copyColumns(text);
          index = column ? columns.indexOf(column) : -1;
          skipIndex = skip ? columns.indexOf(skip.column) : -1;
          captureIndex = skip?.capture ? columns.indexOf(skip.capture) : -1;
        }
        return;
      }
      if (text === "\\.") {
        done = true;
        return;
      }
      const values = text.split("\t");
      if (skipIndex >= 0 && skip.values.has(values[skipIndex])) {
        if (captureIndex >= 0 && values[captureIndex] !== undefined) skipped.push(values[captureIndex]);
        return;
      }
      rows += 1;
      if (index >= 0) {
        const value = values[index];
        if (value !== undefined && value !== "\\N" && value !== "") withValue += 1;
      }
    },
    result() {
      return started ? { rows, withValue, hasColumn: index >= 0, skipped } : null;
    },
  };
}

/** Which Supabase Auth tables the dump holds, and whether their rows came with them. */
export function authTablesInToc(toc) {
  const entries = String(toc).split("\n").map(parseTocLine).filter(Boolean);
  const has = (desc, tag) => entries.some((entry) => entry.desc === desc && entry.namespace === "auth" && entry.tag === tag);
  return {
    usersTable: has("TABLE", "users"),
    usersData: has("TABLE DATA", "users"),
    identitiesData: has("TABLE DATA", "identities"),
  };
}

function streamLines(command, args, onLine, spawnImpl) {
  const run = spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = run(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let rest = "";
    child.stdout?.on("data", (chunk) => {
      const text = rest + String(chunk);
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (rest) onLine(rest);
      if (code !== 0) reject(new Error(sanitiseRestoreLine(stderr || `${command} failed.`)));
      else resolve();
    });
  });
}

async function countDumpRows(pgRestore, dumpPath, table, column, spawnImpl, schema = "auth", skip = null) {
  const counter = copyCounter(column, skip);
  await streamLines(pgRestore, ["-a", "-n", schema, "-t", table, "-f", "-", dumpPath], (line) => counter.line(line), spawnImpl);
  return counter.result();
}

/**
 * Supabase Auth accounts in the dump: users, users with a password hash, and sign-in identities.
 * Null when the database has no Supabase Auth (no auth.users with an encrypted_password column).
 * Throws when auth.users is in the dump without its rows, because then users could not log in after a restore.
 */
export async function authUserCounts(options) {
  const tables = authTablesInToc(options.toc);
  if (!tables.usersTable) return null;
  if (!tables.usersData) {
    throw new Error("The dump has the auth.users table but none of its rows, so users could not log in after a restore. The backup role may not be able to read the auth schema.");
  }
  const users = await countDumpRows(options.pgRestore, options.dumpPath, "users", "encrypted_password", options.spawnImpl, "auth", {
    column: "email",
    values: new Set([STORAGE_LOGIN_EMAIL]),
    capture: "id",
  });
  if (!users) throw new Error("pg_restore did not return the auth.users rows.");
  if (!users.hasColumn) return null;
  let identities = 0;
  if (tables.identitiesData) {
    const skip = { column: "user_id", values: new Set(users.skipped) };
    const counted = await countDumpRows(options.pgRestore, options.dumpPath, "identities", null, options.spawnImpl, "auth", skip);
    if (!counted) throw new Error("pg_restore did not return the auth.identities rows.");
    identities = counted.rows;
  }
  return { users: users.rows, withPassword: users.withValue, identities };
}

/** After a test restore: the same counts must come back out of the throwaway database. */
export async function verifyAuthUsers(options) {
  const dumped = await authUserCounts(options);
  if (!dumped) {
    process.stdout.write("Users check skipped: the dump has no Supabase Auth users.\n");
    return null;
  }
  const query = async (sql) =>
    Number(
      String(
        await commandOutput(
          options.psql,
          [options.databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--command", sql],
          options.spawnImpl,
        ),
      ).trim(),
    );
  // The storage login is left out here as in the dump's count. The address is a constant, never customer text.
  const notLogin = `email IS DISTINCT FROM '${STORAGE_LOGIN_EMAIL}'`;
  const restored = {
    users: await query(`SELECT count(*) FROM auth.users WHERE ${notLogin}`),
    withPassword: await query(
      `SELECT count(*) FROM auth.users WHERE encrypted_password IS NOT NULL AND encrypted_password <> '' AND ${notLogin}`,
    ),
    identities:
      dumped.identities > 0
        ? await query(`SELECT count(*) FROM auth.identities WHERE user_id NOT IN (SELECT id FROM auth.users WHERE email = '${STORAGE_LOGIN_EMAIL}')`)
        : 0,
  };
  for (const [key, label] of [
    ["users", "accounts"],
    ["withPassword", "accounts with a password"],
    ["identities", "sign-in identities"],
  ]) {
    if (!Number.isFinite(restored[key]) || restored[key] !== dumped[key]) {
      throw new Error(`Users did not come back: the dump has ${dumped[key]} ${label}, ${options.label ?? "the test restore"} has ${restored[key]}.`);
    }
  }
  process.stdout.write(
    `Users restored: ${dumped.users} accounts, ${dumped.withPassword} with a password, ${dumped.identities} sign-in identities, matching the dump.\n`,
  );
  return dumped;
}

/**
 * The TABLE DATA entries in a TOC or restore list that are not commented out, with each line as it stands. pg_restore
 * prints names unquoted, so a name with a space or a quote in it cannot be read back from the line: such an entry is
 * marked not plain, and its name is taken from the dump's own COPY line instead (dumpCopies).
 */
function tableDataEntries(text) {
  const found = [];
  const seen = new Set();
  for (const line of String(text).split("\n")) {
    const entry = parseTocLine(line);
    if (!entry || entry.desc !== "TABLE DATA") continue;
    const plain = simpleIdent(entry.namespace) && simpleIdent(entry.tag);
    const key = plain ? `${entry.namespace}.${entry.tag}` : line.split(";")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ schema: entry.namespace, table: entry.tag, line, plain });
  }
  return found;
}

/**
 * Tables the test restore leaves out with an extension the throwaway database does not offer, such as Vault's
 * secrets on stock Postgres: the rows in each skipped extension's own schemas. A pass has not checked them.
 */
export function skippedTables(toc, skipped) {
  const owners = new Map();
  for (const name of skipped?.extensions ?? skipped?.skippedExtensions ?? []) {
    for (const schema of EXTENSION_SCHEMAS[name] ?? []) owners.set(schema, name);
  }
  return tableDataEntries(toc)
    .filter((entry) => owners.has(entry.schema))
    .map((entry) => ({ extension: owners.get(entry.schema), ...entry }));
}

/** Where an identifier starting at `start` ends, quoted ("a ""b""") or plain; -1 when there is none. */
function identEnd(text, start) {
  if (text[start] === '"') {
    let at = start + 1;
    for (;;) {
      const quote = text.indexOf('"', at);
      if (quote < 0) return -1;
      if (text[quote + 1] !== '"') return quote + 1;
      at = quote + 2;
    }
  }
  const plain = /^[^\s".(]+/.exec(text.slice(start));
  return plain ? start + plain[0].length : -1;
}

/**
 * Counts the rows of every COPY block in pg_restore's data output, by the schema-qualified name pg_dump wrote, quoted
 * as SQL. A header split by a line break in a name is joined back up. Rows are counted as they pass and never kept.
 */
export function copyBlocks() {
  const blocks = [];
  let header = null;
  let current = null;
  return {
    line(text) {
      if (current) {
        if (text === "\\.") {
          blocks.push(current);
          current = null;
        } else current.rows += 1;
        return;
      }
      if (header === null && !text.startsWith("COPY ")) return;
      header = header === null ? text : `${header}\n${text}`;
      if (!header.endsWith(" FROM stdin;")) return;
      const schemaEnd = identEnd(header, 5);
      const tableEnd = schemaEnd > 0 && header[schemaEnd] === "." ? identEnd(header, schemaEnd + 1) : -1;
      if (tableEnd > 0) {
        current = { name: header.slice(5, tableEnd), schema: unquoteIdent(header.slice(5, schemaEnd)), rows: 0 };
      }
      header = null;
    },
    result() {
      return blocks;
    },
  };
}

/**
 * The COPY blocks pg_restore gives for these TOC lines: each table's quoted name and its row count in the dump. The
 * lines go in a list file of their own, so pg_restore picks the entries by dump ID and no name is parsed from them.
 */
export async function dumpCopies(lines, options) {
  if (lines.length === 0) return [];
  const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-copies-"));
  try {
    const listPath = path.join(dir, "tables.list");
    writeFileSync(listPath, `${lines.join("\n")}\n`);
    const counter = copyBlocks();
    await streamLines(options.pgRestore, ["-a", "-L", listPath, "-f", "-", options.dumpPath], (line) => counter.line(line), options.spawnImpl);
    return counter.result();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A name for the job log: control characters a quoted name could hold are shown as "?". */
function logName(name) {
  return name.replace(/[\u0000-\u001f\u007f]/g, "?");
}

/**
 * How many rows the dump holds in each table a pass has not checked, totalled per extension: the tables left out with
 * a skipped extension, and, given the restore list, any table the list loaded that is missing afterwards or came back
 * empty while the dump has rows for it. Rows are counted as they stream past and never kept, as with the users. Only
 * the extension names from EXTENSION_SCHEMAS (or "other") and the counts leave this script for the check-in; the
 * table names stay in the job log.
 */
export async function skippedTableCounts(options) {
  const log = options.log ?? ((line) => process.stdout.write(line));
  const totals = new Map();
  const add = (extension, name, rows, why) => {
    log(`Not checked by this test restore: ${logName(name)} (${rows} rows in the dump), because ${why}.\n`);
    const total = totals.get(extension) ?? { extension, tables: 0, rows: 0 };
    total.tables += 1;
    total.rows += rows;
    totals.set(extension, total);
  };
  const plainRows = async ({ schema, table }) =>
    (await countDumpRows(options.pgRestore, options.dumpPath, table, null, options.spawnImpl, schema))?.rows ?? 0;
  const unmatched = (extension, lines, blocks, why) => {
    for (let index = blocks.length; index < lines.length; index += 1) {
      log(`Not checked by this test restore: a table whose name could not be read from the dump, because ${why}.\n`);
    }
    if (lines.length > blocks.length) {
      const total = totals.get(extension) ?? { extension, tables: 0, rows: 0 };
      total.tables += lines.length - blocks.length;
      totals.set(extension, total);
    }
  };

  const skipped = skippedTables(options.toc, options.skipped);
  for (const entry of skipped.filter((candidate) => candidate.plain)) {
    add(entry.extension, `${entry.schema}.${entry.table}`, await plainRows(entry), `this database does not offer ${entry.extension}`);
  }
  const oddSkipped = skipped.filter((candidate) => !candidate.plain);
  const oddSkippedBlocks = await dumpCopies(oddSkipped.map((entry) => entry.line), options);
  for (const block of oddSkippedBlocks) {
    const extension = oddSkipped.find((entry) => entry.schema === block.schema)?.extension ?? OTHER_EXTENSION;
    add(extension, block.name, block.rows, `this database does not offer ${extension}`);
  }
  unmatched(OTHER_EXTENSION, oddSkipped, oddSkippedBlocks, "its extension is not on this database");

  // A table from an extension outside that list is not skipped, but if the extension is missing its load can fail
  // with only a warning, and a table can load without its rows the same way. Any table the list loads that is missing
  // afterwards, or empty while the dump has rows for it, is counted under "other".
  if (options.list !== undefined) {
    const loaded = tableDataEntries(options.list);
    const plain = loaded.filter((entry) => entry.plain);
    const odd = loaded.filter((entry) => !entry.plain);
    const oddBlocks = await dumpCopies(odd.map((entry) => entry.line), options);
    const names = [...plain.map((entry) => `"${entry.schema}"."${entry.table}"`), ...oddBlocks.map((block) => block.name)];
    const states = await restoredTables(names, options);
    for (const [index, entry] of plain.entries()) {
      const state = states[index];
      if (state === "rows") continue;
      const rows = await plainRows(entry);
      if (state === "missing") add(OTHER_EXTENSION, `${entry.schema}.${entry.table}`, rows, NOT_LOADED);
      else if (rows > 0) add(OTHER_EXTENSION, `${entry.schema}.${entry.table}`, rows, ROWS_NOT_LOADED);
    }
    for (const [index, block] of oddBlocks.entries()) {
      const state = states[plain.length + index];
      if (state === "missing") add(OTHER_EXTENSION, block.name, block.rows, NOT_LOADED);
      else if (state === "empty" && block.rows > 0) add(OTHER_EXTENSION, block.name, block.rows, ROWS_NOT_LOADED);
    }
    unmatched(OTHER_EXTENSION, odd, oddBlocks, "it could not be checked");
  }
  return [...totals.values()].sort((left, right) => left.extension.localeCompare(right.extension));
}

/** Tables left out for an extension not on EXTENSION_SCHEMAS are reported under this name. */
export const OTHER_EXTENSION = "other";
const NOT_LOADED = "it did not load, most likely for an extension this database does not offer";
const ROWS_NOT_LOADED = "its rows did not load";
/**
 * Tables checked per query. Each name goes in as hex, up to about 530 characters for two 63-byte quoted names, so
 * one psql argument stays well under the kernel's 128 KiB limit.
 */
const RESTORED_BATCH = 100;

function hex(text) {
  return Buffer.from(text, "utf8").toString("hex");
}

/**
 * For each schema-qualified name, quoted as SQL, whether the throwaway database has that table with rows ("rows"),
 * has it empty ("empty") or does not have it ("missing"). Each name goes into the query as hex and is read with
 * to_regclass, so nothing from the dump is ever run as SQL; format('%s') on the regclass quotes it again.
 */
export async function restoredTables(names, options) {
  const states = [];
  for (let start = 0; start < names.length; start += RESTORED_BATCH) {
    const batch = names.slice(start, start + RESTORED_BATCH);
    const values = batch.map((name, index) => `(${index},'${hex(name)}')`).join(",");
    const sql =
      "SELECT i || ' ' || CASE WHEN r IS NULL THEN 'missing' " +
      "WHEN (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM (SELECT 1 FROM %s LIMIT 1) AS one', r), false, true, '')))[1]::text = '0' THEN 'empty' " +
      "ELSE 'rows' END " +
      `FROM (SELECT i, to_regclass(convert_from(decode(h, 'hex'), 'UTF8')) AS r FROM (VALUES ${values}) AS v(i, h)) AS t`;
    const output = await commandOutput(
      options.psql,
      [options.databaseUrl, "--no-psqlrc", "--tuples-only", "--no-align", "--command", sql],
      options.spawnImpl,
    );
    const answers = new Map();
    for (const line of String(output).split("\n")) {
      const match = /^(\d+) (rows|empty|missing)$/.exec(line.trim());
      if (match) answers.set(Number(match[1]), match[2]);
    }
    // A table the query did not answer for is treated as having rows: the restore itself has already passed, and
    // this check only adds what it can show was not loaded.
    batch.forEach((_name, index) => states.push(answers.get(index) ?? "rows"));
  }
  return states;
}

async function runSkippedCount(tocPath, skipPath, dumpPath, outPath, listPath) {
  const databaseUrl = process.env.RESTORE_DATABASE_URL ?? "";
  if (listPath && !databaseUrl) throw new Error("Set RESTORE_DATABASE_URL to the throwaway Postgres in this runner.");
  const totals = await skippedTableCounts({
    toc: readFileSync(tocPath, "utf8"),
    skipped: readSkipped(skipPath),
    dumpPath,
    pgRestore: process.env.LIFEBOAT_PG_RESTORE || "pg_restore",
    ...(listPath ? { list: readFileSync(listPath, "utf8"), psql: process.env.LIFEBOAT_PSQL || "psql", databaseUrl } : {}),
  });
  writeFileSync(outPath, totals.map((total) => `${total.extension} ${total.tables} ${total.rows}\n`).join(""));
}

async function runAuthCount(tocPath, dumpPath) {
  const counts = await authUserCounts({
    toc: readFileSync(tocPath, "utf8"),
    dumpPath,
    pgRestore: process.env.LIFEBOAT_PG_RESTORE || "pg_restore",
  });
  process.stdout.write(counts ? `${counts.users} ${counts.withPassword} ${counts.identities}\n` : "none\n");
}

async function runAuthVerify(tocPath, dumpPath) {
  const databaseUrl = process.env.RESTORE_DATABASE_URL ?? "";
  if (!databaseUrl) throw new Error("Set RESTORE_DATABASE_URL to the throwaway Postgres in this runner.");
  const counts = await verifyAuthUsers({
    toc: readFileSync(tocPath, "utf8"),
    dumpPath,
    psql: process.env.LIFEBOAT_PSQL || "psql",
    pgRestore: process.env.LIFEBOAT_PG_RESTORE || "pg_restore",
    databaseUrl,
  });
  const out = process.env.LIFEBOAT_AUTH_COUNTS_FILE;
  if (out) writeFileSync(out, counts ? `${counts.users} ${counts.withPassword} ${counts.identities}\n` : "none\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "drop-sql" && (args.length === 3 || args.length === 5)) {
    runDropSql(args[0], args[1], args[2], args[3], args[4]);
    return;
  }
  if (command === "filter" && (args.length === 4 || args.length === 6 || args.length === 8)) {
    await runFilter(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
    return;
  }
  if (command === "classify" && args.length === 3) {
    runClassify(args[0], args[1], args[2]);
    return;
  }
  if (command === "sample" && args.length === 3) {
    await runSample(args[0], args[1], args[2]);
    return;
  }
  if (command === "skipped-count" && (args.length === 4 || args.length === 5)) {
    await runSkippedCount(args[0], args[1], args[2], args[3], args[4]);
    return;
  }
  if (command === "auth-count" && args.length === 2) {
    await runAuthCount(args[0], args[1]);
    return;
  }
  if (command === "auth-verify" && args.length === 2) {
    await runAuthVerify(args[0], args[1]);
    return;
  }
  if (command === "postgis-plan" && (args.length === 4 || args.length === 5)) {
    runPostgisPlan(args[0], args[1], args[2], args[3], args[4]);
    return;
  }
  process.stderr.write("usage: restore-list.mjs drop-sql|filter|classify|sample|skipped-count|auth-count|auth-verify|postgis-plan\n");
  process.exitCode = 1;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("restore-list.mjs")) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Restore list failed.";
    process.stderr.write(`${sanitiseRestoreLine(message)}\n`);
    process.exitCode = 1;
  });
}
