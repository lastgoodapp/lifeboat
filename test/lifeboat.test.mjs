import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("the throwaway drop leaves out a public function whose arguments hold a semicolon or a backtick", () => {
  const toc = [
    "50; 1255 5000 FUNCTION public tidy(text) postgres",
    "51; 1255 5001 FUNCTION public evil(text; DROP SCHEMA auth CASCADE; --) postgres",
    "52; 1255 5002 PROCEDURE public tick(`x`) postgres",
  ].join("\n");
  assert.deepEqual(throwawayDropSql(toc, {}).publicObjects, ["DROP FUNCTION IF EXISTS public.tidy(text) CASCADE;"]);
});

test("the throwaway drop clears each kind of object in public that the dump recreates, and nothing outside public", () => {
  const toc = [
    "50; 1259 5000 VIEW public recent postgres",
    "51; 1259 5001 MATERIALIZED VIEW public totals postgres",
    "52; 1259 5002 SEQUENCE public widgets_id_seq postgres",
    "53; 1247 5003 TYPE public mood postgres",
    "54; 1247 5004 DOMAIN public email postgres",
    "55; 1259 5005 VIEW auth recent postgres",
  ].join("\n");
  assert.deepEqual(throwawayDropSql(toc, {}).publicObjects, [
    "DROP VIEW IF EXISTS public.recent CASCADE;",
    "DROP MATERIALIZED VIEW IF EXISTS public.totals CASCADE;",
    "DROP SEQUENCE IF EXISTS public.widgets_id_seq CASCADE;",
    "DROP TYPE IF EXISTS public.mood CASCADE;",
    "DROP DOMAIN IF EXISTS public.email CASCADE;",
  ]);
});

test("extension errors are warnings only when they name a skipped extension or its schema", () => {
  const skipped = { extensions: ["pg_cron"], schemas: ["cron"] };
  const other = classifyRestoreErrors('pg_restore: error: could not execute query: ERROR:  function public.tidy() does not exist\n', skipped);
  assert.equal(other.fatal.length, 1);
  assert.deepEqual(other.warnings, []);
});

test("an error naming only a skipped extension's schema is a warning, and a data error stays fatal when it names a skipped extension", () => {
  const skipped = { extensions: ["pg_cron", "vector"], schemas: ["cron"] };
  const schema = classifyRestoreErrors('pg_restore: error: could not execute query: ERROR:  schema "cron" does not exist\n', skipped);
  assert.deepEqual(schema.fatal, []);
  assert.equal(schema.warnings.length, 1);
  const data = classifyRestoreErrors('pg_restore: error: COPY failed for table "vector_items": ERROR:  invalid input syntax for type integer: "x"\n', skipped);
  assert.equal(data.fatal.length, 1);
  assert.deepEqual(data.warnings, []);
});

test("the row-count sample takes only tables named plainly, checks three, and checks one of exactly 32 MiB", async () => {
  const odd = [
    "60; 1259 6000 TABLE public odd-name postgres",
    "61; 0 6000 TABLE DATA public odd-name postgres",
    "62; 1259 6001 TABLE odd-schema widgets postgres",
    "63; 0 6001 TABLE DATA odd-schema widgets postgres",
    "64; 1259 6002 TABLE public plain postgres",
    "65; 0 6002 TABLE DATA public plain postgres",
  ].join("\n");
  assert.deepEqual(selectSampleTables(odd, { schemas: [] }, 3).map((table) => `${table.schema}.${table.table}`), ["public.plain"]);

  const names = ["exact", "b", "c", "d", "e"];
  const toc = names.flatMap((name, index) => [`${70 + index}; 1259 ${7000 + index} TABLE public ${name} postgres`, `${80 + index}; 0 ${7000 + index} TABLE DATA public ${name} postgres`]).join("\n");
  const restored = [];
  await verifySampleCounts({
    toc,
    skipped: { schemas: [] },
    dumpPath: "/tmp/restore.backup",
    psql: "psql",
    pgRestore: "pg_restore",
    databaseUrl: "postgresql://postgres:throwaway@localhost/restore",
    spawnImpl(command, args) {
      const sql = String(args.at(-1) ?? "");
      let body = sql.includes("'exact'") ? `${32 * 1024 * 1024}\n` : "100\n";
      if (sql.startsWith("SELECT count")) body = "1\n";
      if (command === "pg_restore") {
        restored.push(args[args.indexOf("-t") + 1]);
        body = `COPY public.${args[args.indexOf("-t") + 1]} (id) FROM stdin;\n1\n\\.\n`;
      }
      return {
        stdout: { on(event, fn) { if (event === "data") fn(body); } },
        stderr: { on() {} },
        on(event, fn) { if (event === "close") fn(0); },
      };
    },
  });
  assert.deepEqual(restored, ["exact", "b", "c"]);
});

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

test("the row-count sample counts a table named with capitals, as Prisma names them, by its own name", async () => {
  const toc = "224; 1259 17467 TABLE public User postgres\n4268; 0 17467 TABLE DATA public User postgres\n";
  const written = [];
  const stdout = process.stdout.write;
  process.stdout.write = (text) => written.push(String(text));
  try {
    await verifySampleCounts({
      toc,
      skipped: { schemas: [] },
      dumpPath: "/tmp/restore.backup",
      psql: "psql",
      pgRestore: "pg_restore",
      databaseUrl: "postgresql://postgres:throwaway@localhost/restore",
      spawnImpl(command, args) {
        const sql = String(args.at(-1) ?? "");
        let body = "8192\n";
        let code = 0;
        let error = "";
        // Postgres folds an unquoted name to lower case, and this database has only "User".
        if (sql.startsWith("SELECT count")) {
          if (sql.endsWith('FROM "public"."User"')) body = "2\n";
          else [body, code, error] = ["", 1, 'ERROR:  relation "public.user" does not exist\n'];
        }
        if (command === "pg_restore") body = 'COPY public."User" (id, email) FROM stdin;\n1\tada@example.invalid\n2\tgrace@example.invalid\n\\.\n';
        return {
          stdout: { on(event, fn) { if (event === "data" && body) fn(body); } },
          stderr: { on(event, fn) { if (event === "data" && error) fn(error); } },
          on(event, fn) { if (event === "close") fn(code); },
        };
      },
    });
  } finally {
    process.stdout.write = stdout;
  }
  assert.deepEqual(written, ["Row count matched for public.User: 2.\n"]);
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
  assert.equal(postgisTargetUrl("postgresql://postgres@localhost:65535/restore")?.port, 65535, "the highest port is a port");
  assert.equal(postgisTargetUrl("postgresql://postgres:x@db.example.com:5432/restore"), null);
  assert.equal(postgisTargetUrl("not a url"), null);
  assert.equal(postgisTargetUrl(""), null);
});

test("the PostGIS target puts an IPv6 runner address in brackets", () => {
  assert.deepEqual(postgisTargetUrl("postgresql://postgres:throwaway@[::1]:55432/postgres"), {
    url: "postgresql://postgres:throwaway@[::1]:55432/restore",
    port: 55432,
  });
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

test("the PostGIS plan names one extension or type in the singular and more than one in the plural", () => {
  const plan = planPostgis({
    toc: "2; 3079 16385 EXTENSION - postgis postgres\n3; 3079 16386 EXTENSION - postgis_raster postgres\n",
    schemaSql: "CREATE TABLE public.places (\n    geom extensions.geometry\n);\n",
    available: ["plpgsql"],
    container: "lifeboat-restore",
    image: "postgis/postgis:17-3.5",
    restoreUrl: "postgresql://postgres:throwaway@localhost:5432/restore",
  });
  assert.equal(
    plan.message,
    "The dump uses PostGIS (extensions postgis, postgis_raster; type extensions.geometry) and the restore database does not offer postgis, postgis_raster. Replacing container lifeboat-restore with postgis/postgis:17-3.5.",
  );
});

test("with no container to replace, the PostGIS plan names the image to start from, or an example when there is none", () => {
  const stock = {
    toc: POSTGIS_TOC,
    schemaSql: POSTGIS_SQL,
    available: ["plpgsql"],
    container: "",
    restoreUrl: "postgresql://postgres:throwaway@localhost:5432/restore",
  };
  const configured = planPostgis({ ...stock, image: "postgis/postgis:16-3.5" });
  assert.equal(configured.decision, "fail");
  assert.match(configured.message, /Start the restore database from postgis\/postgis:16-3\.5\. The restore test stopped before restoring\.$/);
  const none = planPostgis({ ...stock, image: null });
  assert.equal(none.decision, "fail");
  assert.match(none.message, /Start the restore database from a PostGIS image such as postgis\/postgis:17-3\.5\. The restore test/);
  assert.equal(none.image, "");
});

test("postgis-plan takes the container, the image and the restore database from the job's environment", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-postgis-plan-"));
  const script = fileURLToPath(new URL("../scripts/restore-list.mjs", import.meta.url));
  const file = (name, text) => {
    writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  const args = [script, "postgis-plan", file("restore.toc", POSTGIS_TOC), file("restore.schema.sql", POSTGIS_SQL), file("extensions.txt", "plpgsql\npgcrypto\n"), path.join(dir, "postgis.plan")];
  const plan = (env) => {
    const run = spawnSync(process.execPath, args, { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(path.join(dir, "postgis.plan"), "utf8").split("\n");
  };
  const restoreUrl = "postgresql://postgres:throwaway@localhost:55432/restore";
  try {
    assert.deepEqual(plan({ LIFEBOAT_RESTORE_CONTAINER: "lifeboat-restore", LIFEBOAT_RESTORE_POSTGIS_IMAGE: "postgis/postgis:16-3.5", RESTORE_DATABASE_URL: restoreUrl }), [
      "switch",
      "The dump uses PostGIS (extension postgis; types extensions.geography, extensions.geometry) and the restore database does not offer postgis. Replacing container lifeboat-restore with postgis/postgis:16-3.5.",
      "lifeboat-restore",
      "postgis/postgis:16-3.5",
      "55432",
      restoreUrl,
      "",
    ]);
    // Postgres 11 has no PostGIS image: the image line is left empty for run.sh.
    const old = plan({ POSTGRES_MAJOR: "11", LIFEBOAT_RESTORE_CONTAINER: "lifeboat-restore", RESTORE_DATABASE_URL: restoreUrl });
    assert.equal(old[0], "fail");
    assert.match(old[1], /no pinned PostGIS image for this Postgres major/);
    assert.equal(old[3], "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("classify fails a restore with a real error, names PostGIS when any error is a missing PostGIS type, and passes warnings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-classify-"));
  const script = fileURLToPath(new URL("../scripts/restore-list.mjs", import.meta.url));
  const skip = path.join(dir, "restore.skip.json");
  writeFileSync(skip, "{}");
  const classify = (stderr, status) => {
    const err = path.join(dir, "restore.err");
    writeFileSync(err, stderr);
    const run = spawnSync(process.execPath, [script, "classify", err, skip, String(status)], { encoding: "utf8" });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  const owner = "pg_restore: error: could not execute query: ERROR: must be owner of publication supabase_realtime";
  const geometry = 'pg_restore: error: could not execute query: ERROR:  type "extensions.geometry" does not exist';
  const exists = 'pg_restore: error: could not execute query: ERROR: schema "auth" already exists';
  try {
    assert.deepEqual(classify(`${owner}\n${geometry}\n${exists}\n`, 1), {
      code: 1,
      stdout: 'Restore warning: pg_restore: error: could not execute query: ERROR: schema "auth" already exists\n',
      stderr: `Restore failed: the restore database does not have PostGIS. ${owner}\n`,
    });
    assert.deepEqual(classify(`${owner}\n`, 1), { code: 1, stdout: "", stderr: `Restore failed: ${owner}\n` });
    assert.equal(classify(`${exists}\n`, 1).code, 0, "warnings alone pass when pg_restore finished");
    // Killed part way (137 is the out-of-memory killer's SIGKILL), pg_restore prints nothing of its own.
    assert.deepEqual(classify(`${exists}\n`, 137), {
      code: 1,
      stdout: 'Restore warning: pg_restore: error: could not execute query: ERROR: schema "auth" already exists\n',
      stderr: "Restore failed: pg_restore was stopped by signal 9 before it finished.\n",
    });
    assert.equal(classify(`${exists}\n`, 143).stderr, "Restore failed: pg_restore was stopped by signal 15 before it finished.\n");
    assert.deepEqual(classify("pg_restore: connection to server lost\n", 1), { code: 1, stdout: "", stderr: "Restore failed: pg_restore failed.\n" });
    assert.deepEqual(classify("", 0), { code: 0, stdout: "", stderr: "" });
    const leaked = classify("pg_restore: error: connection to server at postgresql://postgres:hunter2@127.0.0.1:5432/postgres failed\n", 1);
    assert.equal(leaked.code, 1);
    assert.doesNotMatch(leaked.stderr, /hunter2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filter writes the list as filtered and the skip file classify reads, as run.sh runs them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-filter-"));
  const script = fileURLToPath(new URL("../scripts/restore-list.mjs", import.meta.url));
  const file = (name, text) => {
    writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  const list = path.join(dir, "restore.list");
  const skip = path.join(dir, "restore.skip.json");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  try {
    const filter = run(
      "filter",
      file("restore.toc", TOC),
      file("extensions.txt", "plpgsql\nvector\n"),
      list,
      skip,
      file("schemas.txt", "public\npg_catalog\n"),
      file("installed.txt", "plpgsql\n"),
      file("publications.txt", ""),
      file("event_triggers.txt", ""),
    );
    assert.equal(filter.status, 0, filter.stderr);
    const expected = filterRestoreList(TOC, ["plpgsql", "vector"], { existingSchemas: ["public", "pg_catalog"], installedExtensions: ["plpgsql"] });
    assert.ok(expected.text.endsWith("postgres\n"));
    assert.equal(readFileSync(list, "utf8"), expected.text);
    assert.deepEqual(JSON.parse(readFileSync(skip, "utf8")), {
      extensions: ["pg_cron", "pg_net", "pgsodium", "supabase_vault"],
      schemas: ["cron", "net", "pgsodium", "vault"],
      preexisting: ["public"],
      installed: ["plpgsql"],
      publications: [],
      eventTriggers: [],
    });
    const missingSchema = 'pg_restore: error: could not execute query: ERROR: schema "cron" does not exist';
    const classify = run("classify", file("restore.err", `${missingSchema}\n`), skip, "1");
    assert.equal(classify.status, 0, classify.stderr);
    assert.equal(classify.stdout, `Restore warning: ${missingSchema}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * Runs checkin.mjs against a server answering each request with the next status in `statuses` (the last repeats), and
 * `answer` as the body of a 200.
 */
async function checkinAgainst(statuses, { port: fixedPort, env = {}, answer = '{"ok":true}' } = {}) {
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
        response.end(status === 200 ? answer : '{"error":"Check-in is not configured."}');
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

test("checkin.mjs sends when the run started, which LastGood uses to tell this run's copies from older ones", async () => {
  const started = await checkinAgainst([200], { env: { LIFEBOAT_STARTED_AT: "2026-10-28T02:00:00Z" } });
  assert.equal(started.code, 0);
  const body = JSON.parse(started.received[0].body);
  assert.equal(body.startedAt, "2026-10-28T02:00:00Z");
  assert.ok(Date.parse(body.finishedAt) >= Date.parse(body.startedAt));

  const unknown = await checkinAgainst([200], { env: { LIFEBOAT_STARTED_AT: "" } });
  assert.equal(JSON.parse(unknown.received[0].body).startedAt, null);
});

test("checkin.mjs names the GitHub run it came from and which attempt, so LastGood can ask GitHub about that one run", async () => {
  const named = await checkinAgainst([200], { env: { GITHUB_RUN_ID: "18234567890", GITHUB_RUN_ATTEMPT: "2" } });
  assert.equal(named.code, 0);
  assert.deepEqual(pick(JSON.parse(named.received[0].body), ["runId", "runAttempt"]), { runId: 18234567890, runAttempt: 2 });
  // Each retry is the same body, signed afresh.
  const retried = await checkinAgainst([503, 200], { env: { GITHUB_RUN_ID: "18234567890", GITHUB_RUN_ATTEMPT: "1" } });
  assert.equal(retried.received.length, 2);
  assert.equal(retried.received[0].body, retried.received[1].body);

  // Outside Actions, or anything that isn't a whole number from 1, is no run at all.
  for (const value of [undefined, "", "  ", "0", "-4", "12.5", "1e9", "abc", "9007199254740992", "99999999999999999"]) {
    const env = value === undefined ? {} : { GITHUB_RUN_ID: value, GITHUB_RUN_ATTEMPT: value };
    const { received } = await checkinAgainst([200], { env });
    assert.deepEqual(pick(JSON.parse(received[0].body), ["runId", "runAttempt"]), { runId: null, runAttempt: null }, String(value));
  }
  const padded = await checkinAgainst([200], { env: { GITHUB_RUN_ID: " 77 ", GITHUB_RUN_ATTEMPT: "3\n" } });
  assert.deepEqual(pick(JSON.parse(padded.received[0].body), ["runId", "runAttempt"]), { runId: 77, runAttempt: 3 });
  const largest = await checkinAgainst([200], { env: { GITHUB_RUN_ID: "9007199254740991", GITHUB_RUN_ATTEMPT: "1" } });
  assert.equal(JSON.parse(largest.received[0].body).runId, 9007199254740991);
});

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
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

test("checkin.mjs stops after three tries, and at once on a refusal, with a different code for each", async () => {
  const down = await checkinAgainst([503]);
  assert.equal(down.code, 2, "it never got through");
  assert.equal(down.received.length, 3);
  assert.match(down.output, /Check-in failed \(503\)\. \{"error":"Check-in is not configured\."\}\n/);

  const refused = await checkinAgainst([401]);
  assert.equal(refused.code, 1, "LastGood refused it");
  assert.equal(refused.received.length, 1);
  assert.doesNotMatch(refused.output, /Trying again/);
});

test("checkin.mjs says a good run's copies were made when only its check-in failed, and nothing more for a failed run", async () => {
  const backup = await checkinAgainst([503]);
  assert.match(backup.output, /The backup itself finished and tonight's copies were uploaded\. LastGood has no checksum record of them, so your login's Open here won't open tonight's copies \(the lastgood CLI can, with --unchecked\)\. Earlier nights aren't affected, and the next run checks in as usual\.\s*$/);
  const restoreTest = await checkinAgainst([503], { env: { LIFEBOAT_KIND: "restore-test" } });
  assert.match(restoreTest.output, /The test restore itself passed\. LastGood has no record of it, so your login won't show tonight's result\.\s*$/);
  const failedRun = await checkinAgainst([503], { env: { LIFEBOAT_OK: "false" } });
  assert.equal(failedRun.code, 2);
  assert.doesNotMatch(failedRun.output, /itself (finished|passed)/);
});

test("checkin.mjs tries again when LastGood can't be reached, and says so without the secret", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { code, output } = await checkinAgainst([], { port });
  assert.equal(code, 2);
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

test("checkin.mjs sends the time of the database copy a test restore opened, never its name, and none for a backup", async () => {
  const sent = async (env) => JSON.parse((await checkinAgainst([200], { env })).received[0].body).restoredCopyAt;
  assert.equal(await sent({ LIFEBOAT_KIND: "restore-test", LIFEBOAT_RESTORE_COPY: "20261029T161700Z.backup.age" }), "2026-10-29T16:17:00Z");
  // A name with no time, or one that is not a real time, sends none rather than a guess.
  for (const name of ["", "customer-named.backup", "20261340T000000Z.backup.age", "20260230T120000Z.backup"]) {
    assert.equal(await sent({ LIFEBOAT_KIND: "restore-test", LIFEBOAT_RESTORE_COPY: name }), null, name);
  }
  assert.equal(await sent({ LIFEBOAT_KIND: "backup", LIFEBOAT_RESTORE_COPY: "20261029T161700Z.backup.age" }), null);
  const body = (await checkinAgainst([200], { env: { LIFEBOAT_KIND: "restore-test", LIFEBOAT_RESTORE_COPY: "20261029T161700Z.backup.age" } })).received[0].body;
  assert.doesNotMatch(body, /backup\.age|20261029T/);
});

test("checkin.mjs sends the copies a test restore opened with their SHA-256, at most four and only well-formed, and none for a backup", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-checkin-opened-"));
  const file = path.join(dir, "opened.tsv");
  const [a, b] = ["a".repeat(64), "b".repeat(64)];
  writeFileSync(
    file,
    [
      `lifeboat/db/20261029T161700Z.backup.age\t${a}`,
      // A line run.sh did not write cleanly is left out rather than sent half-formed.
      "lifeboat/repo/20261029T161700Z.tar.gz.age\tnot-a-sha",
      `\t${b}`,
      `${"x".repeat(301)}\t${b}`,
      `lifeboat/repo/20261029T161700Z.tar.gz.age\t${b}`,
      `lifeboat/setup/20261029T161700Z.tar.gz.age\t${a}`,
      `lifeboat/storage/20261029T161700Z.tar.age\t${b}`,
      `lifeboat/storage/20261028T161700Z.tar.age\t${a}`,
      "",
    ].join("\n"),
  );
  const sent = async (env) => JSON.parse((await checkinAgainst([200], { env })).received[0].body).opened;
  try {
    assert.deepEqual(await sent({ LIFEBOAT_KIND: "restore-test", LIFEBOAT_OPENED_FILE: file }), [
      { key: "lifeboat/db/20261029T161700Z.backup.age", sha256: a },
      { key: "lifeboat/repo/20261029T161700Z.tar.gz.age", sha256: b },
      { key: "lifeboat/setup/20261029T161700Z.tar.gz.age", sha256: a },
      { key: "lifeboat/storage/20261029T161700Z.tar.age", sha256: b },
    ]);
    assert.deepEqual(await sent({ LIFEBOAT_KIND: "backup", LIFEBOAT_OPENED_FILE: file }), []);
    // No file, as when the test restore failed before downloading anything, sends an empty list.
    assert.deepEqual(await sent({ LIFEBOAT_KIND: "restore-test", LIFEBOAT_OPENED_FILE: path.join(dir, "missing.tsv") }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkin.mjs sends run.sh's counts, sources, copies and error as numbers and text LastGood can read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-checkin-"));
  const copiesFile = path.join(dir, "copies.tsv");
  const dumpSha = "a".repeat(64);
  const storageSha = "b".repeat(64);
  writeFileSync(copiesFile, `lifeboat/db/20261028T020000Z.backup.age\t1234\t${dumpSha}\tv-dump\nlifeboat/storage/20261028T020000Z.tar.age\t99\t${storageSha}\t\n`);
  try {
    const { code, received } = await checkinAgainst([200], {
      env: {
        LIFEBOAT_DUMP_BYTES: "1234",
        LIFEBOAT_STORAGE_OBJECTS: "many",
        LIFEBOAT_STORAGE_SOURCE: "s3",
        LIFEBOAT_VERCEL_SOURCE: "token",
        LIFEBOAT_CODE_BRANCHES: "3",
        LIFEBOAT_CODE_TAGS: "",
        LIFEBOAT_CODE_BYTES: "lots",
        LIFEBOAT_COPIES_FILE: copiesFile,
        LIFEBOAT_ERROR: "x".repeat(400),
      },
    });
    assert.equal(code, 0);
    const body = JSON.parse(received[0].body);
    assert.equal(body.dumpBytes, 1234);
    assert.equal(body.storageObjects, 0, "a count that is not a number reads as none");
    assert.equal(body.retentionDays, 0, "a count run.sh left out reads as none");
    assert.equal(body.storageSource, "s3");
    assert.equal(body.vercelSource, "token");
    assert.equal(body.codeBranches, 3);
    assert.equal(body.codeTags, null);
    assert.equal(body.codeBytes, null);
    assert.equal(body.githubIssues, null);
    assert.deepEqual(body.copies, [
      { key: "lifeboat/db/20261028T020000Z.backup.age", bytes: 1234, sha256: dumpSha, versionId: "v-dump" },
      { key: "lifeboat/storage/20261028T020000Z.tar.age", bytes: 99, sha256: storageSha, versionId: null },
    ]);
    assert.equal(body.error, "x".repeat(300));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkin.mjs sends no source it does not know, and no copies when run.sh uploaded none", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lg-checkin-"));
  try {
    // run.sh removes the copies file at the start, so a run that uploaded nothing leaves none behind.
    const unknown = await checkinAgainst([200], {
      env: { LIFEBOAT_STORAGE_SOURCE: "bucket", LIFEBOAT_VERCEL_SOURCE: "maybe", LIFEBOAT_COPIES_FILE: path.join(dir, "missing.tsv") },
    });
    const backup = JSON.parse(unknown.received[0].body);
    assert.equal(backup.storageSource, null);
    assert.equal(backup.vercelSource, null);
    assert.deepEqual(backup.copies, []);
    assert.equal(backup.error, null);

    // run.sh passes empty sources when a run copied neither, and a run without it passes none at all.
    for (const env of [{ LIFEBOAT_STORAGE_SOURCE: "", LIFEBOAT_VERCEL_SOURCE: "" }, {}]) {
      const { received } = await checkinAgainst([200], { env });
      const plain = JSON.parse(received[0].body);
      assert.equal(plain.storageSource, null, JSON.stringify(env));
      assert.equal(plain.vercelSource, null, JSON.stringify(env));
      assert.deepEqual(plain.copies, [], JSON.stringify(env));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkin.mjs warns when LastGood recorded fewer copies than the backup reported, and takes an answer that is not JSON", async () => {
  const short = await checkinAgainst([200], { answer: '{"ok":true,"copies":{"reported":3,"recorded":1}}' });
  assert.equal(short.code, 0);
  assert.match(short.output, /::warning::LastGood recorded 1 of the 3 copies this backup reported\. A restore refuses a copy with no record/);

  const whole = await checkinAgainst([200], { answer: '{"ok":true,"copies":{"reported":3,"recorded":3}}' });
  assert.doesNotMatch(whole.output, /::warning::/);

  const notJson = await checkinAgainst([200], { answer: "accepted" });
  assert.equal(notJson.code, 0);
  assert.match(notJson.output, /Check-in accepted \(200\)\./);
  assert.doesNotMatch(notJson.output, /::warning::|TypeError/);
});

test("checkin.mjs says LastGood gave no answer when a try runs out of time, not that it could not be reached", async () => {
  // A server that takes each request and never answers, as LastGood would mid-outage.
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const script = fileURLToPath(new URL("../scripts/checkin.mjs", import.meta.url));
  // The same AbortSignal.timeout on a 20 ms clock in place of 30 seconds.
  const quickClock = `data:text/javascript,${encodeURIComponent("const real = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => real(20);")}`;
  try {
    const { code, output } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ["--import", quickClock, script],
        {
          env: {
            PATH: process.env.PATH,
            CHECKIN_SECRET: "unit-test-checkin-secret",
            CHECKIN_URL: `http://127.0.0.1:${port}/api/checkin`,
            LIFEBOAT_PROJECT: "abcdefghijklmnopqrst",
            LIFEBOAT_OK: "true",
            LIFEBOAT_CHECKIN_WAIT_MS: "10",
          },
        },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: `${stdout}${stderr}` }),
      );
    });
    assert.equal(code, 2);
    assert.equal(output.match(/Check-in failed \(no answer within 30 seconds\)\./g)?.length, 3);
    assert.doesNotMatch(output, /could not be reached/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
