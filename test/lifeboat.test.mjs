import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { keysToDelete, objectsFromList } from "../src/retention.mjs";
import {
  classifyRestoreErrors,
  countCopyRows,
  dropSchemaSql,
  filterRestoreList,
  isPostgisTypeError,
  pinnedImage,
  planPostgis,
  postgisExtensionsInToc,
  postgisImage,
  postgisNeeds,
  postgisTargetUrl,
  postgisTypesInSql,
  resolvePostgisImage,
  throwawayDropSql,
  sanitiseRestoreLine,
  schemasToDrop,
  selectSampleTables,
  verifySampleCounts,
} from "../scripts/restore-list.mjs";
import { signCheckin, verifyCheckin } from "../src/sign-checkin.mjs";

const NOW = Date.parse("2026-10-14T00:00:00.000Z");

test("retention deletes only objects older than the window", () => {
  const keys = keysToDelete(
    [
      { key: "lifeboat/db/old.backup", lastModified: "2026-08-01T00:00:00.000Z" },
      { key: "lifeboat/db/new.backup", lastModified: "2026-10-13T00:00:00.000Z" },
      { key: "lifeboat/db/", lastModified: "2026-01-01T00:00:00.000Z" },
      { key: "lifeboat/db/unknown.backup", lastModified: "not-a-date" },
    ],
    30,
    NOW,
  );
  assert.deepEqual(keys, ["lifeboat/db/old.backup"]);
});

test("retention reads the AWS list-objects shape", () => {
  const objects = objectsFromList({
    Contents: [{ Key: "lifeboat/db/a.backup", LastModified: "2026-01-01T00:00:00.000Z" }],
  });
  assert.equal(keysToDelete(objects, 30, NOW).length, 1);
});

const TOC = `
;
; Selected TOC Entries:
;
2; 3079 16384 EXTENSION - plpgsql postgres
3; 3079 16385 EXTENSION - pg_cron postgres
4; 3079 16386 EXTENSION - pg_net postgres
5; 3079 16387 EXTENSION - pgsodium postgres
6; 3079 16388 EXTENSION - supabase_vault postgres
7; 3079 16389 EXTENSION - vector postgres
10; 2615 2200 SCHEMA - public postgres
11; 2615 2201 SCHEMA - cron postgres
12; 2615 2202 SCHEMA - vault postgres
20; 1259 3000 TABLE public widgets postgres
21; 1259 3001 TABLE cron job postgres
22; 1259 3002 TABLE DATA public widgets postgres
23; 1259 3003 TABLE DATA cron job postgres
24; 1259 3004 TABLE DATA vault secrets postgres
25; 1259 3005 TABLE DATA public huge postgres
30; 0 0 COMMENT - EXTENSION pg_cron postgres
31; 0 0 COMMENT public TABLE widgets postgres
40; 1259 3006 ACL public TABLE widgets postgres
`;

test("restore list comments extensions the target does not offer, and objects in their schemas", () => {
  const result = filterRestoreList(TOC, ["plpgsql", "vector"]);
  assert.deepEqual(result.skippedExtensions, ["pg_cron", "pg_net", "pgsodium", "supabase_vault"]);
  assert.deepEqual(result.skippedSchemas, ["cron", "net", "pgsodium", "vault"]);
  assert.match(result.text, /^2; 3079 16384 EXTENSION - plpgsql postgres$/m);
  assert.match(result.text, /^7; 3079 16389 EXTENSION - vector postgres$/m);
  assert.match(result.text, /^;3; 3079 16385 EXTENSION - pg_cron postgres$/m);
  assert.match(result.text, /^;11; 2615 2201 SCHEMA - cron postgres$/m);
  assert.match(result.text, /^;21; 1259 3001 TABLE cron job postgres$/m);
  assert.match(result.text, /^;23; 1259 3003 TABLE DATA cron job postgres$/m);
  assert.match(result.text, /^;24; 1259 3004 TABLE DATA vault secrets postgres$/m);
  assert.match(result.text, /^;30; 0 0 COMMENT - EXTENSION pg_cron postgres$/m);
  assert.match(result.text, /^20; 1259 3000 TABLE public widgets postgres$/m);
  assert.match(result.text, /^22; 1259 3002 TABLE DATA public widgets postgres$/m);
  assert.match(result.text, /^31; 0 0 COMMENT public TABLE widgets postgres$/m);
  assert.match(result.text, /^40; 1259 3006 ACL public TABLE widgets postgres$/m);
});

test("restore list reads an entry with no owner, as pg_restore lists an extension's comment, by its whole name", () => {
  // pg_restore --list ends such a line with a space where the owner would be.
  const toc = ["6; 3079 16388 EXTENSION - supabase_vault ", "3729; 0 0 COMMENT - EXTENSION supabase_vault ", "3730; 0 0 COMMENT - EXTENSION plpgsql "].join("\n");
  const result = filterRestoreList(toc, ["plpgsql"]);
  assert.deepEqual(result.skippedExtensions, ["supabase_vault"]);
  assert.match(result.text, /^;3729; 0 0 COMMENT - EXTENSION supabase_vault $/m);
  assert.match(result.text, /^3730; 0 0 COMMENT - EXTENSION plpgsql $/m);
});

const SUPABASE_TOC = `${TOC}
13; 2615 2203 SCHEMA - auth postgres
14; 2615 2204 SCHEMA - storage postgres
15; 2615 2205 SCHEMA - realtime postgres
16; 6104 2206 PUBLICATION - supabase_realtime postgres
17; 3466 2207 EVENT TRIGGER - pgrst_ddl_watch postgres
18; 6106 2208 PUBLICATION TABLE supabase_realtime widgets postgres
19; 1255 2209 FUNCTION public noop_ddl() postgres
26; 1259 3007 TABLE auth users postgres
27; 1259 3008 TABLE DATA auth users postgres
28; 0 0 COMMENT - SCHEMA public postgres
29; 0 0 COMMENT - PUBLICATION supabase_realtime postgres
`;

test("a Supabase image keeps public and drops schemas the dump will recreate", () => {
  const existing = ["public", "auth", "storage", "realtime", "extensions", "graphql", "vault", "cron", "supabase_migrations", "pg_catalog", "pg_toast"];
  assert.deepEqual(schemasToDrop(SUPABASE_TOC, existing), ["auth", "realtime", "storage", "supabase_migrations"]);
  assert.equal(dropSchemaSql(["auth", "storage", "public", "pg_catalog", "graphql", "extensions"]), "DROP SCHEMA IF EXISTS auth CASCADE;\nDROP SCHEMA IF EXISTS storage CASCADE;");
  const drop = throwawayDropSql(SUPABASE_TOC, {
    schemas: existing,
    publications: ["supabase_realtime"],
    eventTriggers: ["pgrst_ddl_watch"],
  });
  assert.deepEqual(drop.eventTriggers, ["pgrst_ddl_watch"]);
  assert.deepEqual(drop.publications, ["supabase_realtime"]);
  assert.deepEqual(drop.schemas, ["auth", "realtime", "storage", "supabase_migrations"]);
  assert.match(drop.sql, /CREATE ROLE %I NOLOGIN NOINHERIT/);
  assert.match(drop.sql, /DROP PUBLICATION IF EXISTS supabase_realtime;\nDROP TABLE IF EXISTS public\.widgets CASCADE;\nDROP FUNCTION IF EXISTS public\.noop_ddl\(\) CASCADE;\nDROP SCHEMA IF EXISTS auth CASCADE;/);
  assert.match(drop.sql, /DROP SCHEMA IF EXISTS supabase_migrations CASCADE/);
  assert.match(drop.sql, /nspname = 'public'/);
  assert.equal(drop.sql.includes("DROP TABLE IF EXISTS auth.users"), false);
  assert.equal(drop.sql.includes("DROP SCHEMA IF EXISTS public"), false);
  assert.equal(drop.sql.includes("DROP SCHEMA IF EXISTS extensions"), false);
  assert.equal(drop.sql.includes("DROP SCHEMA IF EXISTS graphql"), false);
  assert.equal(drop.sql.includes("DROP SCHEMA IF EXISTS vault"), false);
  assert.equal(drop.sql.includes("DROP SCHEMA IF EXISTS cron"), false);
  const result = filterRestoreList(SUPABASE_TOC, ["plpgsql", "vector", "pg_cron"], {
    existingSchemas: ["public", "pg_catalog", "pg_toast"],
    installedExtensions: ["plpgsql"],
    existingPublications: ["supabase_realtime"],
    existingEventTriggers: ["pgrst_ddl_watch"],
  });
  assert.deepEqual(result.preexistingSchemas, ["public"]);
  assert.deepEqual(result.preexistingPublications, ["supabase_realtime"]);
  assert.deepEqual(result.preexistingEventTriggers, ["pgrst_ddl_watch"]);
  assert.deepEqual(result.installedExtensions, ["plpgsql"]);
  assert.match(result.text, /^;2; 3079 16384 EXTENSION - plpgsql postgres$/m);
  assert.match(result.text, /^;10; 2615 2200 SCHEMA - public postgres$/m);
  assert.match(result.text, /^;16; 6104 2206 PUBLICATION - supabase_realtime postgres$/m);
  assert.match(result.text, /^;17; 3466 2207 EVENT TRIGGER - pgrst_ddl_watch postgres$/m);
  assert.match(result.text, /^;29; 0 0 COMMENT - PUBLICATION supabase_realtime postgres$/m);
  assert.match(result.text, /^18; 6106 2208 PUBLICATION TABLE supabase_realtime widgets postgres$/m);
  assert.match(result.text, /^20; 1259 3000 TABLE public widgets postgres$/m);
  assert.match(result.text, /^13; 2615 2203 SCHEMA - auth postgres$/m);
  assert.match(result.text, /^26; 1259 3007 TABLE auth users postgres$/m);
  assert.match(result.text, /^3; 3079 16385 EXTENSION - pg_cron postgres$/m);
  const kept = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: schema "public" already exists\n',
    { preexisting: ["public"], installed: ["plpgsql"] },
  );
  assert.deepEqual(kept.fatal, []);
  assert.equal(kept.warnings.length, 1);
  const auth = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: schema "auth" already exists\n',
    {},
  );
  assert.deepEqual(auth.fatal, []);
  assert.equal(auth.warnings.length, 1);
  const publication = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: publication "supabase_realtime" already exists\n',
    {},
  );
  assert.deepEqual(publication.fatal, []);
  const member = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: relation "widgets" is already member of publication "supabase_realtime"\n',
    {},
  );
  assert.deepEqual(member.fatal, []);
  const owned = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: must be owner of publication supabase_realtime\n',
    {},
  );
  assert.equal(owned.fatal.length, 1);
  const keys = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: multiple primary keys for table "widgets" are not allowed\n',
    {},
  );
  assert.equal(keys.fatal.length, 1);
  const role = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: role "anon" already exists\n',
    {},
  );
  assert.deepEqual(role.fatal, []);
  const extension = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR: extension "plpgsql" already exists\n',
    { preexisting: ["public"], installed: ["plpgsql"] },
  );
  assert.deepEqual(extension.fatal, []);
});

test("extension errors are warnings and copy errors fail", () => {
  const skipped = { extensions: ["pg_cron", "supabase_vault"], schemas: ["cron", "vault"] };
  const warned = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR:  extension "pg_cron" is not available\n',
    skipped,
  );
  assert.deepEqual(warned.fatal, []);
  assert.equal(warned.warnings.length, 1);
  const copied = classifyRestoreErrors(
    "pg_restore: error: COPY failed for table \"widgets\": ERROR: invalid input syntax for type integer\n",
    skipped,
  );
  assert.equal(copied.fatal.length, 1);
  assert.deepEqual(copied.warnings, []);
  const url = sanitiseRestoreLine(
    "pg_restore: error: connection to server failed: postgresql://postgres:throwaway@localhost:5432/restore",
  );
  assert.equal(url.includes("throwaway"), false);
  assert.match(url, /postgresql:\/\/redacted/);
});

const SAMPLE_TOC = `${TOC}
41; 1259 3009 TABLE public huge postgres
`;

test("row-count sample prefers a small public table and compares copy lines", async () => {
  const tables = selectSampleTables(SAMPLE_TOC, { schemas: ["cron", "vault"] }, 3);
  assert.deepEqual(
    tables.map((table) => `${table.schema}.${table.table}`),
    ["public.widgets", "public.huge"],
  );
  assert.equal(countCopyRows("COPY public.widgets (id) FROM stdin;\n1\n2\n\\.\n"), 2);
  assert.equal(countCopyRows("no copy here\n"), null);
  const calls = [];
  await verifySampleCounts({
    toc: SAMPLE_TOC,
    skipped: { schemas: ["cron", "vault"] },
    dumpPath: "/tmp/restore.backup",
    psql: "psql",
    pgRestore: "pg_restore",
    databaseUrl: "postgresql://postgres:throwaway@localhost/restore",
    spawnImpl(command, args) {
      calls.push([command, args]);
      const sql = String(args.at(-1) ?? "");
      let body = "100\n";
      if (sql.includes("huge")) body = `${33 * 1024 * 1024}\n`;
      if (sql.startsWith("SELECT count")) body = "2\n";
      if (command === "pg_restore") body = "COPY public.widgets (id) FROM stdin;\n1\n2\n\\.\n";
      return {
        stdout: { on(event, fn) { if (event === "data") fn(body); } },
        stderr: { on() {} },
        on(event, fn) { if (event === "close") fn(0); },
      };
    },
  });
  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], "psql");
  assert.match(calls[0][1].at(-1), /widgets/);
  assert.deepEqual(calls[2][1].slice(0, 6), ["-a", "-n", "public", "-t", "widgets", "-f"]);
  assert.match(String(calls[3][1].at(-1)), /huge/);
});

/** `pg_restore --list` of a Supabase-style dump: PostGIS in the extensions schema, dumped with --no-owner. */
const POSTGIS_TOC = `
;
; Selected TOC Entries:
;
7; 2615 16384 SCHEMA - extensions postgres
2; 3079 16385 EXTENSION - postgis
3; 3079 16386 EXTENSION - pg_graphql
4277; 0 0 COMMENT - EXTENSION postgis
224; 1259 17467 TABLE public places postgres
992; 1255 17482 FUNCTION public near(extensions.geography, double precision) postgres
225; 1259 17475 TABLE public notes postgres
4108; 0 16707 TABLE DATA extensions spatial_ref_sys postgres
4269; 0 17475 TABLE DATA public notes postgres
4268; 0 17467 TABLE DATA public places postgres
`;

/** `pg_restore --schema-only` of the same dump, trimmed. */
const POSTGIS_SQL = `--
-- PostgreSQL database dump
--
SELECT pg_catalog.set_config('search_path', '', false);
CREATE SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';
--
-- Name: places; Type: TABLE; Schema: public; Owner: -
--
CREATE TABLE public.places (
    id bigint NOT NULL,
    name text NOT NULL,
    geom extensions.geometry(Point,4326),
    area extensions.geography
);
CREATE FUNCTION public.near(p extensions.geography, metres double precision) RETURNS SETOF public.places
    LANGUAGE sql STABLE
    AS $$ SELECT * FROM public.places WHERE extensions.ST_DWithin(area, p, metres) $$;
`;

test("PostGIS is found in the table of contents and in column types", () => {
  assert.deepEqual(postgisExtensionsInToc(POSTGIS_TOC), ["postgis"]);
  // pg_dump --no-owner leaves the owner column empty, with a trailing space.
  assert.deepEqual(postgisExtensionsInToc("2; 3079 16385 EXTENSION - postgis \n"), ["postgis"]);
  assert.deepEqual(
    postgisExtensionsInToc("5; 3079 1 EXTENSION - postgis_topology postgres\n6; 3079 2 EXTENSION - postgis_raster postgres\n7; 3079 3 EXTENSION - pg_cron postgres\n8; 3079 4 EXTENSION - postgis_sfcgal\n;9; 3079 5 EXTENSION - postgis postgres\n"),
    ["postgis_raster", "postgis_sfcgal", "postgis_topology"],
  );
  assert.deepEqual(postgisTypesInSql(POSTGIS_SQL), ["extensions.geography", "extensions.geometry"]);
  assert.deepEqual(postgisNeeds(POSTGIS_TOC, POSTGIS_SQL), {
    needed: true,
    extensions: ["postgis"],
    types: ["extensions.geography", "extensions.geometry"],
    required: ["postgis"],
  });
  assert.deepEqual(postgisNeeds("", POSTGIS_SQL).required, ["postgis"]);
  assert.deepEqual(postgisNeeds(POSTGIS_TOC, "").types, []);
  const raster = postgisNeeds("", "CREATE TABLE public.tiles (\n    rast extensions.raster\n);\n");
  assert.deepEqual(raster.required, ["postgis", "postgis_raster"]);
  assert.deepEqual(postgisNeeds(TOC, "CREATE TABLE public.widgets (\n    id integer\n);\n"), {
    needed: false,
    extensions: [],
    types: [],
    required: [],
  });
});

test("PostGIS types are found where a type goes, and nowhere else", () => {
  const used = [
    "CREATE TABLE public.a (\n    id integer,\n    geom public.geometry(MultiPolygon,4326) NOT NULL\n);",
    "CREATE TABLE public.b (\n    \"Geom\" \"extensions\".\"geography\"\n);",
    "CREATE TYPE public.stop AS (\n\tname text,\n\tloc gis.geometry\n);",
    "CREATE DOMAIN public.point4326 AS extensions.geometry(Point,4326);",
    "CREATE FUNCTION public.f(OUT g extensions.geometry) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
    "CREATE FUNCTION public.g(extensions.raster, integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;",
    "CREATE FUNCTION public.h() RETURNS extensions.geography LANGUAGE sql AS $$ SELECT NULL $$;",
    "CREATE TABLE public.c (\n    geom text DEFAULT ''::extensions.geometry\n);",
    "CREATE AGGREGATE public.agg(integer) (\n    SFUNC = public.step,\n    STYPE = extensions.geometry\n);",
  ];
  assert.deepEqual(postgisTypesInSql(used.join("\n")), [
    "extensions.geography",
    "extensions.geometry",
    "extensions.raster",
    "gis.geometry",
    "public.geometry",
  ]);
  const unrelated = [
    "--",
    "-- Name: geometry; Type: TABLE; Schema: public; Owner: -",
    "--",
    "CREATE TABLE public.geometry (\n    id integer NOT NULL\n);",
    "ALTER TABLE ONLY public.geometry\n    ADD CONSTRAINT geometry_pkey PRIMARY KEY (id);",
    "CREATE INDEX geometry_idx ON public.geometry USING btree (id);",
    "ALTER SEQUENCE public.geometry_id_seq OWNED BY public.geometry.id;",
    "CREATE TABLE public.shapes (\n    id integer REFERENCES public.geometry(id),\n    kind text DEFAULT 'extensions.geometry'::text,\n    geometry_name text\n);",
    "CREATE VIEW public.v AS\n SELECT s.id\n   FROM (public.shapes s\n     JOIN public.geometry g ON ((g.id = s.id)));",
    "CREATE FUNCTION public.body() RETURNS integer LANGUAGE plpgsql AS $fn$\nDECLARE\n    g extensions.geometry;\nBEGIN RETURN 1; END $fn$;",
    "COMMENT ON TABLE public.geometry IS 'stores a column of type extensions.geography';",
    "CREATE TABLE public.photos (\n    raster_url text,\n    geography_label text\n);",
  ];
  assert.deepEqual(postgisTypesInSql(unrelated.join("\n")), []);
});

test("the PostGIS image is pinned to the Postgres major and never latest", () => {
  assert.equal(postgisImage(17), "postgis/postgis:17-3.5");
  assert.equal(postgisImage("15"), "postgis/postgis:15-3.5");
  assert.equal(postgisImage(12), "postgis/postgis:12-3.5");
  assert.equal(postgisImage(11), null);
  assert.equal(postgisImage(""), null);
  assert.equal(pinnedImage("postgis/postgis:16-3.5"), "postgis/postgis:16-3.5");
  assert.equal(pinnedImage("registry.example.com:5000/gis/postgis:17-3.5"), "registry.example.com:5000/gis/postgis:17-3.5");
  assert.equal(pinnedImage(`postgis/postgis@sha256:${"a".repeat(64)}`), `postgis/postgis@sha256:${"a".repeat(64)}`);
  assert.equal(pinnedImage("postgis/postgis:latest"), null);
  assert.equal(pinnedImage("postgis/postgis"), null);
  assert.equal(pinnedImage("postgis/postgis:17-3.5; rm -rf /"), null);
  assert.equal(resolvePostgisImage("", "16"), "postgis/postgis:16-3.5");
  assert.equal(resolvePostgisImage(undefined, 17), "postgis/postgis:17-3.5");
  assert.equal(resolvePostgisImage("postgis/postgis:17-3.4", 17), "postgis/postgis:17-3.4");
  assert.equal(resolvePostgisImage("postgis/postgis:latest", 17), null);
});

test("the PostGIS target keeps the runner host and port", () => {
  assert.deepEqual(postgisTargetUrl("postgresql://postgres:throwaway@localhost:5432/restore"), {
    url: "postgresql://postgres:throwaway@localhost:5432/restore",
    port: 5432,
  });
  assert.deepEqual(postgisTargetUrl("postgresql://supabase_admin:throwaway@127.0.0.1:55432/postgres"), {
    url: "postgresql://postgres:throwaway@127.0.0.1:55432/restore",
    port: 55432,
  });
  assert.equal(postgisTargetUrl("postgres://postgres@localhost/restore")?.port, 5432);
  assert.equal(postgisTargetUrl("postgresql://postgres:x@db.example.com:5432/restore"), null);
  assert.equal(postgisTargetUrl("not a url"), null);
  assert.equal(postgisTargetUrl(""), null);
});

test("a dump that needs PostGIS switches the container, or fails and names PostGIS", () => {
  const stock = {
    toc: POSTGIS_TOC,
    schemaSql: POSTGIS_SQL,
    available: ["plpgsql", "pgcrypto"],
    container: "lifeboat-restore",
    image: "postgis/postgis:17-3.5",
    restoreUrl: "postgresql://postgres:throwaway@localhost:5432/restore",
  };
  const switched = planPostgis(stock);
  assert.equal(switched.decision, "switch");
  assert.equal(switched.container, "lifeboat-restore");
  assert.equal(switched.image, "postgis/postgis:17-3.5");
  assert.equal(switched.url, "postgresql://postgres:throwaway@localhost:5432/restore");
  assert.equal(switched.port, 5432);
  assert.deepEqual(switched.missing, ["postgis"]);
  assert.equal(
    switched.message,
    "The dump uses PostGIS (extension postgis; types extensions.geography, extensions.geometry) and the restore database does not offer postgis. Replacing container lifeboat-restore with postgis/postgis:17-3.5.",
  );
  assert.equal(switched.message.includes("\n"), false);

  const offered = planPostgis({ ...stock, available: ["plpgsql", "postgis", "pg_graphql"] });
  assert.equal(offered.decision, "ok");
  assert.match(offered.message, /offers postgis/);

  const noContainer = planPostgis({ ...stock, container: "" });
  assert.equal(noContainer.decision, "fail");
  assert.match(noContainer.message, /uses PostGIS/);
  assert.match(noContainer.message, /does not offer postgis/);
  assert.match(noContainer.message, /not a Supabase-only extension/);
  assert.match(noContainer.message, /LIFEBOAT_RESTORE_CONTAINER/);
  assert.match(noContainer.message, /postgis\/postgis:17-3\.5/);
  assert.match(noContainer.message, /stopped before restoring/);
  assert.equal(noContainer.message.includes("throwaway@"), false);

  assert.equal(planPostgis({ ...stock, container: "bad name; rm" }).decision, "fail");
  const noImage = planPostgis({ ...stock, image: null });
  assert.equal(noImage.decision, "fail");
  assert.match(noImage.message, /not latest/);
  const remote = planPostgis({ ...stock, restoreUrl: "postgresql://postgres:x@db.example.com:5432/restore" });
  assert.equal(remote.decision, "fail");
  assert.match(remote.message, /not on localhost/);
  assert.equal(remote.message.includes("db.example.com"), false);

  const after = planPostgis({ ...stock, available: ["plpgsql", "postgis"], switched: true });
  assert.equal(after.decision, "ok");
  const stillMissing = planPostgis({
    ...stock,
    toc: `${POSTGIS_TOC}\n9; 3079 16390 EXTENSION - postgis_sfcgal postgres\n`,
    available: ["plpgsql", "postgis"],
    switched: true,
  });
  assert.equal(stillMissing.decision, "fail");
  assert.match(stillMissing.message, /postgis\/postgis:17-3\.5 started but does not offer postgis_sfcgal/);

  const supabaseOnly = planPostgis({ ...stock, toc: TOC, schemaSql: "CREATE TABLE public.widgets (\n    id integer\n);" });
  assert.equal(supabaseOnly.decision, "none");
});

test("Supabase-only extensions stay warnings and PostGIS restore errors name PostGIS", () => {
  const result = filterRestoreList(POSTGIS_TOC, ["plpgsql", "postgis"]);
  assert.deepEqual(result.skippedExtensions, ["pg_graphql"]);
  assert.match(result.text, /^2; 3079 16385 EXTENSION - postgis\s*$/m);
  const warned = classifyRestoreErrors(
    'pg_restore: error: could not execute query: ERROR:  extension "pg_graphql" is not available\n',
    { extensions: result.skippedExtensions, schemas: result.skippedSchemas },
  );
  assert.deepEqual(warned.fatal, []);
  assert.equal(isPostgisTypeError('pg_restore: error: could not execute query: ERROR:  type "extensions.geometry" does not exist'), true);
  assert.equal(isPostgisTypeError('ERROR: type "geography" does not exist'), true);
  assert.equal(isPostgisTypeError('ERROR: type "public.mood" does not exist'), false);
});

test("an extension config table such as spatial_ref_sys is not sampled", () => {
  const tables = selectSampleTables(POSTGIS_TOC, { schemas: [] }, 3);
  assert.deepEqual(
    tables.map((table) => `${table.schema}.${table.table}`),
    ["public.notes", "public.places"],
  );
});

test("check-in signatures expire and do not match another secret", () => {
  const body = JSON.stringify({ ok: true, kind: "backup" });
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = signCheckin("secret", timestamp, body);
  assert.equal(verifyCheckin("secret", timestamp, body, signature, NOW), true);
  assert.equal(verifyCheckin("other", timestamp, body, signature, NOW), false);
  assert.equal(verifyCheckin("secret", timestamp, body, signature, NOW + 6 * 60 * 1000), false);
  assert.equal(verifyCheckin("secret", timestamp, `${body} `, signature, NOW), false);
});

test("checkin.mjs signs with exactly the secret it is given, so a per-repository secret needs no change", async () => {
  const given = "9f2c4d1e0b7a65f8c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0";
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const script = fileURLToPath(new URL("../scripts/checkin.mjs", import.meta.url));
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [script],
        {
          env: {
            PATH: process.env.PATH,
            CHECKIN_SECRET: given,
            CHECKIN_URL: `http://127.0.0.1:${port}/api/checkin`,
            LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
            LIFEBOAT_OK: "true",
          },
        },
        (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}${stderr}`)),
      );
    });
    assert.match(output, /Check-in accepted/);
    assert.doesNotMatch(output, new RegExp(given));
  } finally {
    server.close();
  }
  assert.equal(received.length, 1);
  const [{ headers, body }] = received;
  assert.equal(JSON.parse(body).project, "abcdefghijklmnopqrst");
  const timestamp = headers["x-lastgood-timestamp"];
  const signature = headers["x-lastgood-signature"];
  assert.equal(verifyCheckin(given, timestamp, body, signature, Number(timestamp) * 1000), true);
  assert.equal(verifyCheckin("checkin-secret", timestamp, body, signature, Number(timestamp) * 1000), false);
  assert.doesNotMatch(body, new RegExp(given));
});

/** Runs checkin.mjs against a server answering each request with the next status in `statuses` (the last repeats). */
async function checkinAgainst(statuses, { port: fixedPort, env = {} } = {}) {
  const received = [];
  let server = null;
  let port = fixedPort;
  if (!fixedPort) {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({ headers: request.headers, body });
        const status = statuses[Math.min(received.length - 1, statuses.length - 1)];
        response.writeHead(status, { "content-type": "application/json" });
        response.end(status === 200 ? '{"ok":true}' : '{"error":"Check-in is not configured."}');
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  }
  const script = fileURLToPath(new URL("../scripts/checkin.mjs", import.meta.url));
  try {
    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [script],
        {
          env: {
            PATH: process.env.PATH,
            CHECKIN_SECRET: "unit-test-checkin-secret",
            CHECKIN_URL: `http://127.0.0.1:${port}/api/checkin`,
            LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
            LIFEBOAT_OK: "true",
            LIFEBOAT_CHECKIN_WAIT_MS: "10",
            ...env,
          },
        },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: `${stdout}${stderr}` }),
      );
    });
    return { ...result, received };
  } finally {
    server?.close();
  }
}

test("checkin.mjs tries again when LastGood answers 5xx, signing each try afresh", async () => {
  const { code, output, received } = await checkinAgainst([503, 502, 200]);
  assert.equal(code, 0);
  assert.equal(received.length, 3);
  assert.match(output, /Check-in failed \(503\)\. .*Trying again in 0 s\./);
  assert.match(output, /Check-in accepted \(200\)/);
  for (const { headers, body } of received) {
    const timestamp = headers["x-lastgood-timestamp"];
    assert.equal(verifyCheckin("unit-test-checkin-secret", timestamp, body, headers["x-lastgood-signature"], Number(timestamp) * 1000), true);
  }
  assert.equal(new Set(received.map(({ body }) => body)).size, 1);
});

test("checkin.mjs stops after three tries, and at once on a refusal", async () => {
  const down = await checkinAgainst([503]);
  assert.equal(down.code, 1);
  assert.equal(down.received.length, 3);
  assert.match(down.output, /Check-in failed \(503\)\. \{"error":"Check-in is not configured\."\}\n/);

  const refused = await checkinAgainst([401]);
  assert.equal(refused.code, 1);
  assert.equal(refused.received.length, 1);
  assert.doesNotMatch(refused.output, /Trying again/);
});

test("checkin.mjs says a good run's copies were made when only its check-in failed, and nothing more for a failed run", async () => {
  const backup = await checkinAgainst([503]);
  assert.match(backup.output, /The backup itself finished and tonight's copies were uploaded\. LastGood has no checksum record of them, so your login's Open here won't open tonight's copies \(the lastgood CLI can, with --unchecked\)\. Earlier nights aren't affected, and the next run checks in as usual\.\s*$/);
  const restoreTest = await checkinAgainst([503], { env: { LIFEBOAT_KIND: "restore-test" } });
  assert.match(restoreTest.output, /The test restore itself passed\. LastGood has no record of it, so your login won't show tonight's result\.\s*$/);
  const failedRun = await checkinAgainst([503], { env: { LIFEBOAT_OK: "false" } });
  assert.equal(failedRun.code, 1);
  assert.doesNotMatch(failedRun.output, /itself (finished|passed)/);
});

test("checkin.mjs tries again when LastGood can't be reached, and says so without the secret", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { code, output } = await checkinAgainst([], { port });
  assert.equal(code, 1);
  assert.equal(output.match(/Check-in failed \(LastGood could not be reached\)\./g)?.length, 3);
  assert.doesNotMatch(output, /unit-test-checkin-secret/);
});

test("checkin.mjs sends what a test restore left out, by extension and count, and nothing of it for a backup", async () => {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const script = fileURLToPath(new URL("../scripts/checkin.mjs", import.meta.url));
  const send = (kind) =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [script],
        {
          env: {
            PATH: process.env.PATH,
            CHECKIN_SECRET: "unit-test-checkin-secret",
            CHECKIN_URL: `http://127.0.0.1:${port}/api/checkin`,
            LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
            LIFEBOAT_OK: "true",
            LIFEBOAT_KIND: kind,
            LIFEBOAT_RESTORE_NOT_CHECKED: "supabase_vault 1 3;pg_cron 2 0;Bad.Name 1 1;pgsodium x 2;;",
          },
        },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  try {
    await send("restore-test");
    await send("backup");
  } finally {
    server.close();
  }
  assert.deepEqual(received[0].notChecked, [
    { extension: "supabase_vault", tables: 1, rows: 3 },
    { extension: "pg_cron", tables: 2, rows: 0 },
  ]);
  assert.deepEqual(received[1].notChecked, []);
});
