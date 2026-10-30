import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { checkVercelToken, defaultSleep, holdsSupabaseKey, plan, rebuildVercel, refsIn, vercelTarget } from "../lib/rebuild-vercel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "lastgood.mjs");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function folder(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const NEW_REF = "newprojectrefbbbbbbb";
const OLD_REF = "oldprojectrefaaaaaaa";
const TOKEN = "vercel-rebuild-test-token";
const PROJECT_ID = "prj_newnotes";
const TEAM_ID = "team_acme";

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJlLXZhbHVl`;
}

const SERVICE_KEY = jwt({ iss: "supabase", ref: OLD_REF, role: "service_role" });
const DB_URL = `postgresql://postgres.${OLD_REF}:s3cretpassword@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`;

/** The variables as the backup writes them (lifeboat/scripts/vercel-env.mjs), one of each kind the step handles. */
const VARIABLES = [
  { key: "NEXT_PUBLIC_SUPABASE_URL", type: "plain", target: ["production", "preview", "development"], gitBranch: null, customEnvironmentIds: [], comment: null, value: `https://${OLD_REF}.supabase.co`, note: null },
  { key: "DATABASE_URL", type: "encrypted", target: ["production"], gitBranch: null, customEnvironmentIds: [], comment: "pooler", value: DB_URL, note: null },
  { key: "SUPABASE_SERVICE_ROLE_KEY", type: "encrypted", target: ["production", "preview"], gitBranch: null, customEnvironmentIds: [], comment: null, value: SERVICE_KEY, note: null },
  { key: "FEATURE_FLAG", type: "plain", target: ["preview"], gitBranch: "staging", customEnvironmentIds: [], comment: null, value: "flag-on-value", note: null },
  { key: "ANALYTICS_ID", type: "plain", target: ["production"], gitBranch: null, customEnvironmentIds: [], comment: null, value: "analytics-from-copy", note: null },
  { key: "STRIPE_SECRET_KEY", type: "sensitive", target: ["production"], gitBranch: null, customEnvironmentIds: [], comment: null, value: null, note: "Vercel never returns this value." },
  { key: "VERCEL_URL", type: "system", target: ["production", "preview"], gitBranch: null, customEnvironmentIds: [], comment: null, value: null, note: "Set by Vercel itself." },
  { key: "CUSTOM_ONLY", type: "encrypted", target: [], gitBranch: null, customEnvironmentIds: ["env_oldcustom"], comment: null, value: "custom-only-value", note: null },
];
const VALUES = [SERVICE_KEY, "s3cretpassword", "flag-on-value", "analytics-from-copy", "custom-only-value", "resend-secret-value", "mailer-secret-value"];

/** A Vercel copy as the backup makes it: env.json in a tar.gz. */
function vercelCopy(variables = VARIABLES) {
  const dir = folder("lastgood-vercel-copy-");
  const pack = path.join(dir, "pack");
  mkdirSync(pack);
  writeFileSync(path.join(pack, "env.json"), JSON.stringify({ project: "prj_oldnotes", teamId: TEAM_ID, variables }));
  const archive = path.join(dir, "vercel.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", pack, "."]);
  return archive;
}

/**
 * A stand-in for Vercel's API, holding one new project with the variables an integration or the customer already set.
 * Keys in `refuse` are refused with a 400 and keys in `failInBody` come back as a 201 whose `failed` list holds the
 * error, each echoing the value and the token to prove neither reaches a message. Keys in `forget` are taken and never
 * listed. Keys in `dropOnce` are stored the first time, then the connection drops before Vercel answers; those in
 * `failOnce` are stored and answered with a 500, those in `cutOnce` stored and sent half an answer, and those in
 * `loseOnce` drop the connection before anything is stored. A route in `stallOnce` is never answered the first time. A variable
 * already set for the same environment and branch is refused, as Vercel does. Every request body and route is kept.
 * The route in `limitOnce` is answered with a 429 the first time, with x-ratelimit-reset five seconds from now, or with
 * `limitHeaders` instead when given. The project is sent without a name when `name` is null, and with `bare` the
 * variables are listed as a plain list rather than inside `envs`.
 */
async function fakeVercel({ refuse = [], failInBody = [], forget = [], dropOnce = [], failOnce = [], cutOnce = [], loseOnce = [], stallOnce = [], link = { type: "github", org: "acme", repo: "notes-rebuilt" }, team = TEAM_ID, limitOnce = null, limitHeaders = null, name = "notes-rebuilt", bare = false } = {}) {
  const project = {
    envs: [{ id: "env_have", key: "ANALYTICS_ID", type: "plain", value: "analytics-already-there", target: ["production"] }],
    bodies: [],
    routes: [],
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    project.bodies.push(body);
    const send = (status, json) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "forbidden", message: "Not authorized" } });
    const url = new URL(request.url, "http://api");
    if (team && url.searchParams.get("teamId") !== team) return send(403, { error: { code: "forbidden", message: "Not authorized" } });
    const route = `${request.method} ${url.pathname}`;
    project.routes.push(route);
    const once = (list, item) => list.includes(item) && list.splice(list.indexOf(item), 1).length === 1;
    if (once(stallOnce, route)) return;
    if (route === limitOnce && project.routes.filter((item) => item === route).length === 1) {
      response.writeHead(429, { "Content-Type": "application/json", ...(limitHeaders ?? { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 5) }) });
      return response.end(JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }));
    }
    switch (route) {
      case `GET /v9/projects/${PROJECT_ID}`:
        return send(200, { id: PROJECT_ID, ...(name ? { name } : {}), ...(link ? { link } : {}) });
      case `GET /v10/projects/${PROJECT_ID}/env`: {
        const envs = project.envs.map(({ value, ...rest }) => ({ ...rest, value: rest.type === "plain" ? value : "" }));
        return send(200, bare ? envs : { envs });
      }
      case `POST /v10/projects/${PROJECT_ID}/env`: {
        const env = JSON.parse(body);
        if (once(loseOnce, env.key)) return request.socket.destroy();
        if (refuse.includes(env.key)) return send(400, { error: { code: "bad_value", message: `${env.value} is not allowed here (${request.headers.authorization})` } });
        if (failInBody.includes(env.key)) return send(201, { failed: [{ error: { code: "ENV_CONFLICT", message: `${env.key}=${env.value} conflicts`, value: env.value } }] });
        const clash = project.envs.some((have) => have.key === env.key && (have.gitBranch ?? null) === (env.gitBranch ?? null) && have.target.some((name) => env.target.includes(name)));
        if (clash) return send(400, { error: { code: "ENV_ALREADY_EXISTS", message: `A variable with the name ${env.key} already exists for this target` } });
        if (!forget.includes(env.key)) project.envs.push({ id: `env_${project.envs.length}`, ...env });
        if (dropOnce.includes(env.key)) {
          dropOnce.splice(dropOnce.indexOf(env.key), 1);
          return request.socket.destroy();
        }
        if (once(failOnce, env.key)) return send(500, { error: { code: "internal_server_error", message: "An unexpected error occurred" } });
        if (once(cutOnce, env.key)) {
          const text = JSON.stringify({ created: { key: env.key }, failed: [] });
          response.writeHead(201, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(text)) });
          return response.write(text.slice(0, Math.floor(text.length / 2)), () => request.socket.destroy());
        }
        return send(201, { created: { key: env.key }, failed: [] });
      }
      default:
        return send(404, { error: { code: "not_found", message: `No route for ${route}` } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { api: `http://127.0.0.1:${server.address().port}`, project, close };
}

describe("lastgood rebuild: Vercel environment variables, the decisions", () => {
  it("puts back what has a value, keeps what is there for the same environment, and sorts out the rest", () => {
    const existing = [
      { key: "ANALYTICS_ID", target: ["production"] },
      { key: "FEATURE_FLAG", target: ["preview"], gitBranch: "main" },
      { key: "NEXT_PUBLIC_SUPABASE_URL", target: ["development"] },
    ];
    const result = plan(VARIABLES, existing);
    assert.deepEqual(
      result.put.map((entry) => [entry.key, entry.target]),
      [
        ["DATABASE_URL", ["production"]],
        ["SUPABASE_SERVICE_ROLE_KEY", ["production", "preview"]],
        ["FEATURE_FLAG", ["preview"]],
      ],
      "a variable for another branch is no clash",
    );
    assert.deepEqual(result.kept, ["NEXT_PUBLIC_SUPABASE_URL (production, preview, development)", "ANALYTICS_ID (production)"]);
    assert.deepEqual(result.byHand, ["STRIPE_SECRET_KEY (production)"]);
    assert.deepEqual(result.custom, ["CUSTOM_ONLY"]);
    assert.deepEqual(result.system, ["VERCEL_URL"]);
    assert.deepEqual(plan([{ key: "NOWHERE", type: "plain", target: [], value: "x" }], []).none, ["NOWHERE"]);
  });

  it("finds the Supabase project a value names, and a Supabase key from another project", () => {
    assert.deepEqual(refsIn(`https://${OLD_REF}.supabase.co`), [OLD_REF]);
    assert.deepEqual(refsIn(DB_URL), [OLD_REF]);
    assert.deepEqual(refsIn(`postgresql://postgres:pw@db.${NEW_REF}.supabase.co:5432/postgres`), [NEW_REF]);
    assert.deepEqual(refsIn("https://example.com"), []);
    assert.equal(holdsSupabaseKey(SERVICE_KEY, NEW_REF), true);
    assert.equal(holdsSupabaseKey(jwt({ iss: "supabase", ref: NEW_REF, role: "anon" }), NEW_REF), false);
    assert.equal(holdsSupabaseKey("sb_publishable_abc", NEW_REF), true);
    assert.equal(holdsSupabaseKey(jwt({ iss: "someone-else" })), false);
    assert.equal(holdsSupabaseKey("plain words"), false);
  });

  it("takes a Vercel token and project, and refuses another kind of key or a bad ID", () => {
    assert.equal(checkVercelToken(` ${TOKEN} `), TOKEN);
    assert.throws(() => checkVercelToken(""), /Set LASTGOOD_VERCEL_TOKEN to a Vercel token/);
    assert.throws(() => checkVercelToken("sbp_abc"), /does not hold a Vercel token/);
    assert.throws(() => checkVercelToken("two words"), /does not hold a Vercel token/);
    assert.deepEqual(vercelTarget(PROJECT_ID, TEAM_ID), { project: PROJECT_ID, team: TEAM_ID });
    assert.throws(() => vercelTarget(undefined, null), /Give --vercel-project/);
    assert.throws(() => vercelTarget("has spaces", null), /--vercel-project must be/);
    assert.throws(() => vercelTarget(PROJECT_ID, "acme"), /--vercel-team must be the team's ID/);
  });

  it("asks for the token when LASTGOOD_VERCEL_TOKEN is not set at all", () => {
    assert.throws(() => checkVercelToken(undefined), /Set LASTGOOD_VERCEL_TOKEN to a Vercel token/);
  });

  it("reads a variable with no list of environments as set for none", () => {
    const result = plan(
      [
        { key: "CUSTOM_ONLY", type: "encrypted", customEnvironmentIds: ["env_oldcustom"], value: "custom-only-value" },
        { key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" },
      ],
      [{ key: "SITE_NAME", customEnvironmentIds: ["env_newcustom"] }],
    );
    assert.deepEqual(result.custom, ["CUSTOM_ONLY"]);
    assert.deepEqual(result.none, []);
    assert.deepEqual(
      result.put.map((entry) => entry.key),
      ["SITE_NAME"],
      "one the new project has only for a custom environment is no clash",
    );
  });

  it("waits as long as it is asked to before a retry", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let done = false;
    const wait = defaultSleep(1000).then(() => (done = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "still waiting");
    t.mock.timers.tick(1000);
    await wait;
    assert.equal(done, true);
  });

  it("asks for the token and the project before anything runs", async () => {
    const noToken = await cli(["rebuild", "--key", "k.txt", "--vercel", "v.tar.gz.age", "--vercel-project", PROJECT_ID], { LASTGOOD_VERCEL_TOKEN: "" });
    assert.equal(noToken.status, 2);
    assert.match(noToken.stderr, /Set LASTGOOD_VERCEL_TOKEN/);
    const noProject = await cli(["rebuild", "--key", "k.txt", "--vercel", "v.tar.gz.age"], { LASTGOOD_VERCEL_TOKEN: TOKEN });
    assert.equal(noProject.status, 2);
    assert.match(noProject.stderr, /Give --vercel-project/);
    const badRef = await cli(["rebuild", "--key", "k.txt", "--vercel", "v.tar.gz.age", "--vercel-project", PROJECT_ID, "--project-ref", "short"], { LASTGOOD_VERCEL_TOKEN: TOKEN });
    assert.equal(badRef.status, 2);
    assert.match(badRef.stderr, /--project-ref must be the new project's 20-letter ref/);
    const pooled = `postgresql://postgres.${NEW_REF}:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`;
    const otherRef = await cli(["rebuild", "--key", "k.txt", "--vercel", "v.tar.gz.age", "--vercel-project", PROJECT_ID, "--project-ref", OLD_REF], { LASTGOOD_VERCEL_TOKEN: TOKEN, LASTGOOD_DATABASE_TO: pooled });
    assert.equal(otherRef.status, 2);
    assert.match(otherRef.stderr, /--project-ref is oldprojectrefaaaaaaa, but the database connection string is project newprojectrefbbbbbbb/);
  });

  it("opens the Vercel copy with the others and runs its step after them", async () => {
    const dir = folder("lastgood-vercel-cli-");
    const key = await generateX25519Identity();
    const recipient = await identityToRecipient(key);
    const keyFile = path.join(dir, "lastgood-key-acme-notes.txt");
    writeFileSync(keyFile, `# LastGood key for acme/notes\n# public key: ${recipient}\n${key}\n`);
    const encrypter = new Encrypter();
    encrypter.addRecipient(recipient);
    const sealed = path.join(dir, "acme-notes-vercel-20261017T000000Z.tar.gz.age");
    writeFileSync(sealed, Buffer.from(await encrypter.encrypt(readFileSync(vercelCopy()))));
    const wrong = createHash("sha256").update("not this copy").digest("hex");
    const result = await cli(["rebuild", "--key", keyFile, "--vercel", sealed, "--vercel-sha256", wrong, "--vercel-project", PROJECT_ID], { LASTGOOD_VERCEL_TOKEN: TOKEN });
    assert.equal(result.status, 1);
    const text = result.stdout + result.stderr;
    assert.match(text, /not the [0-9a-f]{64} your backup recorded, so it was not opened/);
    assert.match(text, /Vercel environment variables\s+not run\s+not run, because Open the copies failed/);
    // A run with a Vercel copy is not told to go and find one.
    assert.match(result.stdout, /\n  Every rebuild\n   1\. Point your domain at the new Vercel project/);
    assert.doesNotMatch(text, /Rebuild the Vercel project: import the new repository/);
    assert.doesNotMatch(text, new RegExp(TOKEN));
  });
});

describe("lastgood rebuild: Vercel environment variables", () => {
  const quiet = async () => {};

  it("puts every variable with a value back, keeps what is there, never prints a value, lists what is left, and keeps everything on a rerun", async () => {
    const archive = vercelCopy();
    const api = await fakeVercel();
    try {
      const said = [];
      const todo = [];
      const note = await rebuildVercel({
        archive,
        project: PROJECT_ID,
        team: TEAM_ID,
        token: TOKEN,
        ref: NEW_REF,
        work: folder("lastgood-vercel-work-"),
        say: (line) => said.push(line),
        todo: (line) => (todo.push(line), said.push(line)),
        api: api.api,
        sleep: quiet,
      });
      const text = said.join("\n");
      assert.equal(note, "5 variables, 5 to add or change by hand");
      assert.deepEqual(
        todo.map((line) => line.split(/[:.,]/)[0]),
        [
          "Vercel never returned these values to the backup",
          "Also set for a custom environment the new project does not have yet",
          "These values still name another Supabase project",
          "These hold a Supabase API key from the copy",
          "Deploy the project again in Vercel (Deployments",
        ],
        "only what the customer does by hand goes to the end-of-run list",
      );
      for (const value of [...VALUES, TOKEN]) assert.doesNotMatch(text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no value or token is ever printed");

      assert.match(text, /^Vercel project notes-rebuilt, built from acme\/notes-rebuilt\.$/m);
      assert.match(text, /Put back 4 environment variables: NEXT_PUBLIC_SUPABASE_URL \(production, preview, development\), DATABASE_URL \(production\), SUPABASE_SERVICE_ROLE_KEY \(production, preview\), FEATURE_FLAG \(preview, branch staging\)\./);
      assert.match(text, /Already in the new project for the same environment, kept as they are: ANALYTICS_ID \(production\)\./);
      assert.match(text, /The new project lists every variable put back, for the environments it had\./);
      assert.match(text, /Vercel never returned these values to the backup, so add them by hand under Settings, then Environment Variables: STRIPE_SECRET_KEY \(production\)\./);
      assert.match(text, /Also set for a custom environment the new project does not have yet\. Add them there once you make it: CUSTOM_ONLY\./);
      assert.match(text, /Left for Vercel to fill in: 1 system variable\./);
      assert.match(text, /These values still name another Supabase project, so the app would call it: NEXT_PUBLIC_SUPABASE_URL \(oldprojectrefaaaaaaa\), DATABASE_URL \(oldprojectrefaaaaaaa\)\./);
      assert.match(text, /These hold a Supabase API key from the copy, which works only with the project it came from\..*: SUPABASE_SERVICE_ROLE_KEY\./);
      assert.match(text, /Deploy the project again in Vercel/);

      // What Vercel holds now: each value as the copy had it, the one already there untouched.
      const byKey = Object.fromEntries(api.project.envs.map((env) => [`${env.key}${env.gitBranch ? `@${env.gitBranch}` : ""}`, env]));
      assert.equal(byKey.NEXT_PUBLIC_SUPABASE_URL.type, "plain");
      assert.equal(byKey.DATABASE_URL.type, "encrypted");
      assert.equal(byKey.DATABASE_URL.value, DB_URL);
      assert.equal(byKey.DATABASE_URL.comment, "pooler");
      assert.deepEqual(byKey.SUPABASE_SERVICE_ROLE_KEY.target, ["production", "preview"]);
      assert.deepEqual(byKey["FEATURE_FLAG@staging"].target, ["preview"]);
      assert.equal(byKey.ANALYTICS_ID.value, "analytics-already-there", "a variable already there is never written over");
      const sent = api.project.bodies.join("\n");
      assert.doesNotMatch(sent, /STRIPE_SECRET_KEY|VERCEL_URL|CUSTOM_ONLY|custom-only-value|analytics-from-copy|upsert/);

      // A rerun keeps every variable and sends nothing.
      const posts = api.project.envs.length;
      const again = [];
      await rebuildVercel({ archive, project: PROJECT_ID, team: TEAM_ID, token: TOKEN, ref: NEW_REF, work: folder("lastgood-vercel-work-"), say: (line) => again.push(line), api: api.api, sleep: quiet });
      assert.equal(api.project.envs.length, posts);
      assert.match(again.join("\n"), /kept as they are: NEXT_PUBLIC_SUPABASE_URL \(production, preview, development\), DATABASE_URL \(production\), SUPABASE_SERVICE_ROLE_KEY \(production, preview\), FEATURE_FLAG \(preview, branch staging\), ANALYTICS_ID \(production\)\./);
      assert.doesNotMatch(again.join("\n"), /Put back|Deploy the project again/);
    } finally {
      await api.close();
    }
  });

  it("names a variable Vercel refuses without its value, keeps the rest, and stops on a refused token or a missing project", async () => {
    const archive = vercelCopy([
      { key: "RESEND_API_KEY", type: "encrypted", target: ["production"], customEnvironmentIds: [], value: "resend-secret-value" },
      { key: "MAILER_KEY", type: "encrypted", target: ["production"], customEnvironmentIds: [], value: "mailer-secret-value" },
      { key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" },
    ]);
    const api = await fakeVercel({ refuse: ["RESEND_API_KEY"], failInBody: ["MAILER_KEY"], link: null, team: null });
    try {
      const said = [];
      const work = folder("lastgood-vercel-work-");
      await assert.rejects(rebuildVercel({ archive, project: PROJECT_ID, token: TOKEN, work, say: (line) => said.push(line), api: api.api, sleep: quiet }), (error) => {
        assert.match(error.message, /^Vercel did not take 2 environment variables: RESEND_API_KEY \(… is not allowed here \(Bearer …\)\); MAILER_KEY \(MAILER_KEY=… conflicts\)\.$/);
        assert.match(error.hint, /Run this again once the cause is fixed: the variables already put back are kept\./);
        return true;
      });
      const text = said.join("\n");
      assert.match(text, /not connected to a Git repository yet\. Connect it to the new repository under Settings, then Git/);
      assert.match(text, /Put back 1 environment variable: SITE_NAME \(production\)\./);
      assert.doesNotMatch(text, /resend-secret-value|mailer-secret-value/);
      assert.deepEqual(api.project.envs.map((env) => env.key), ["ANALYTICS_ID", "SITE_NAME"]);

      await assert.rejects(rebuildVercel({ archive, project: PROJECT_ID, token: "wrong-token", work, say: () => {}, api: api.api, sleep: quiet }), /Vercel refused the token in LASTGOOD_VERCEL_TOKEN when reading the new project\./);
      await assert.rejects(rebuildVercel({ archive, project: "prj_other", token: TOKEN, work, say: () => {}, api: api.api, sleep: quiet }), /Vercel found no project prj_other for this token when reading the new project\./);
    } finally {
      await api.close();
    }
  });

  it("reads back a variable whose answer a dropped connection lost, and counts it put back without sending it again", async () => {
    const archive = vercelCopy([
      { key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" },
      { key: "API_KEY", type: "encrypted", target: ["production"], customEnvironmentIds: [], value: "api-key-long-value" },
    ]);
    const api = await fakeVercel({ dropOnce: ["API_KEY"], team: null });
    try {
      const said = [];
      const note = await rebuildVercel({ archive, project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: (line) => said.push(line), api: api.api, sleep: quiet });
      const text = said.join("\n");
      assert.equal(note, "2 variables");
      assert.match(text, /Put back 2 environment variables: SITE_NAME \(production\), API_KEY \(production\)\./);
      assert.doesNotMatch(text, /kept as they are/);
      assert.equal(api.project.envs.filter((env) => env.key === "API_KEY").length, 1, "it was not sent a second time");
      assert.doesNotMatch(text, /api-key-long-value/);
    } finally {
      await api.close();
    }
  });

  it("leaves a short value in Vercel's message, since hiding it would mangle the words", async () => {
    const archive = vercelCopy([{ key: "FLAG", type: "plain", target: ["production"], customEnvironmentIds: [], value: "on" }]);
    const api = await fakeVercel({ refuse: ["FLAG"], team: null });
    try {
      await assert.rejects(
        rebuildVercel({ archive, project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: () => {}, api: api.api, sleep: quiet }),
        /Vercel did not take 1 environment variable: FLAG \(on is not allowed here \(Bearer …\)\)\./,
      );
    } finally {
      await api.close();
    }
  });

  it("stops when the new project does not list a variable it took", async () => {
    const archive = vercelCopy([{ key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" }]);
    const api = await fakeVercel({ forget: ["SITE_NAME"], team: null });
    try {
      await assert.rejects(
        rebuildVercel({ archive, project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: () => {}, api: api.api, sleep: quiet }),
        /The new project does not list SITE_NAME for the environments the copy has\./,
      );
    } finally {
      await api.close();
    }
  });

  it("asks for the team when the project belongs to one", async () => {
    const api = await fakeVercel();
    try {
      await assert.rejects(
        rebuildVercel({ archive: vercelCopy(), project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: () => {}, api: api.api, sleep: quiet }),
        /cannot reach the new project when reading the new project\. Make it in the team that owns the project, and give --vercel-team for a team project\./,
      );
      assert.equal(api.project.envs.length, 1, "nothing is written");
    } finally {
      await api.close();
    }
  });

  it("says only what a copy needs when everything is already there, after waiting out a rate limit until its reset", async () => {
    const api = await fakeVercel({ team: null, limitOnce: `GET /v9/projects/${PROJECT_ID}` });
    try {
      const said = [];
      const todo = [];
      const waits = [];
      const note = await rebuildVercel({
        archive: vercelCopy([{ key: "ANALYTICS_ID", type: "plain", target: ["production"], customEnvironmentIds: [], value: "analytics-from-copy" }]),
        project: PROJECT_ID,
        token: TOKEN,
        work: folder("lastgood-vercel-work-"),
        say: (line) => said.push(line),
        todo: (line) => (todo.push(line), said.push(line)),
        api: api.api,
        sleep: async (ms) => waits.push(ms),
      });
      assert.deepEqual(said, [
        "Vercel project notes-rebuilt, built from acme/notes-rebuilt.",
        "Already in the new project for the same environment, kept as they are: ANALYTICS_ID (production).",
      ]);
      assert.deepEqual(todo, []);
      assert.equal(note, "1 variable");
      assert.equal(waits.length, 1);
      assert.ok(waits[0] > 2000 && waits[0] <= 5000, `waited until the reset, not the reset's own number or a plain backoff (${waits[0]} ms)`);
      assert.deepEqual(api.project.routes, [`GET /v9/projects/${PROJECT_ID}`, `GET /v9/projects/${PROJECT_ID}`, `GET /v10/projects/${PROJECT_ID}/env`], "nothing written, and no second look at the variables");
    } finally {
      await api.close();
    }

    const fresh = await fakeVercel({ team: null, link: { type: "gitlab", org: "acme", projectNameWithNamespace: "acme/notes" } });
    try {
      const said = [];
      await rebuildVercel({
        archive: vercelCopy([{ key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" }]),
        project: PROJECT_ID,
        token: TOKEN,
        work: folder("lastgood-vercel-work-"),
        say: (line) => said.push(line),
        api: fresh.api,
        sleep: async () => {},
      });
      assert.deepEqual(said, [
        "Vercel project notes-rebuilt, built from acme/notes.",
        "Put back 1 environment variable: SITE_NAME (production).",
        "The new project lists every variable put back, for the environments it had.",
        "Deploy the project again in Vercel (Deployments, then Redeploy): a deployment reads its variables when it builds.",
      ]);
    } finally {
      await fresh.close();
    }
  });

  it("waits as Retry-After says, then as a small x-ratelimit-reset says in seconds, up to a minute, and a second with neither", async () => {
    const cases = [
      [{ "retry-after": "5" }, 5000],
      [{ "retry-after": "3600" }, 60_000],
      [{ "x-ratelimit-reset": "7" }, 7000],
      [{ "retry-after": "5", "x-ratelimit-reset": "9" }, 5000],
      [{ "retry-after": "0", "x-ratelimit-reset": "3" }, 3000],
      [{ "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) }, 60_000],
      [{}, 1000],
    ];
    for (const [limitHeaders, wait] of cases) {
      const api = await fakeVercel({ team: null, limitOnce: `GET /v9/projects/${PROJECT_ID}`, limitHeaders });
      try {
        const waits = [];
        await rebuildVercel({
          archive: vercelCopy([{ key: "ANALYTICS_ID", type: "plain", target: ["production"], customEnvironmentIds: [], value: "analytics-from-copy" }]),
          project: PROJECT_ID,
          token: TOKEN,
          work: folder("lastgood-vercel-work-"),
          say: () => {},
          api: api.api,
          sleep: async (ms) => waits.push(ms),
        });
        assert.deepEqual(waits, [wait], JSON.stringify(limitHeaders));
      } finally {
        await api.close();
      }
    }
  });

  it("refuses a copy that is not a list of variables", async () => {
    const dir = folder("lastgood-vercel-bad-");
    mkdirSync(path.join(dir, "pack"));
    writeFileSync(path.join(dir, "pack", "env.json"), JSON.stringify({ variables: [{ value: "no name" }] }));
    execFileSync("tar", ["-czf", path.join(dir, "bad.tar.gz"), "-C", path.join(dir, "pack"), "."]);
    await assert.rejects(
      rebuildVercel({ archive: path.join(dir, "bad.tar.gz"), project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: () => {}, api: "http://127.0.0.1:9", sleep: quiet }),
      /The Vercel copy's env\.json is not a list of variables, so it was not used\./,
    );
  });

  it("names the repository a Bitbucket link gives, and the project by its ID when Vercel sends no name", async () => {
    const notConnected = "not connected to a Git repository yet. Connect it to the new repository under Settings, then Git, so it builds from the code.";
    for (const [options, line] of [
      [{ link: { type: "bitbucket", owner: "acme", slug: "notes" } }, "Vercel project notes-rebuilt, built from acme/notes."],
      [{ name: null }, "Vercel project prj_newnotes, built from acme/notes-rebuilt."],
      [{ link: null }, `Vercel project notes-rebuilt, ${notConnected}`],
      [{ link: null, name: null }, `Vercel project prj_newnotes, ${notConnected}`],
    ]) {
      const api = await fakeVercel({ team: null, ...options });
      try {
        const said = [];
        await rebuildVercel({
          archive: vercelCopy([{ key: "ANALYTICS_ID", type: "plain", target: ["production"], customEnvironmentIds: [], value: "analytics-from-copy" }]),
          project: PROJECT_ID,
          token: TOKEN,
          work: folder("lastgood-vercel-work-"),
          say: (text) => said.push(text),
          api: api.api,
          sleep: quiet,
        });
        assert.equal(said[0], line, JSON.stringify(options));
      } finally {
        await api.close();
      }
    }
  });

  it("names the Supabase project a value calls, without calling it another, when the new one is not known", async () => {
    const api = await fakeVercel({ team: null });
    try {
      const todo = [];
      await rebuildVercel({
        archive: vercelCopy([{ key: "NEXT_PUBLIC_SUPABASE_URL", type: "plain", target: ["production"], customEnvironmentIds: [], value: `https://${OLD_REF}.supabase.co` }]),
        project: PROJECT_ID,
        token: TOKEN,
        work: folder("lastgood-vercel-work-"),
        say: () => {},
        todo: (line) => todo.push(line),
        api: api.api,
        sleep: quiet,
      });
      assert.ok(
        todo.includes("These values name a Supabase project: NEXT_PUBLIC_SUPABASE_URL (oldprojectrefaaaaaaa). If the app now uses a new project, change each to its address."),
        todo.join("\n"),
      );
    } finally {
      await api.close();
    }
  });

  it("puts each variable back as JSON, and reads the variables when Vercel lists them as a plain list", async () => {
    const api = await fakeVercel({ team: null, bare: true });
    try {
      const types = [];
      const fetchImpl = (url, init) => {
        if (init.method === "POST") types.push(init.headers["Content-Type"]);
        return fetch(url, init);
      };
      const note = await rebuildVercel({
        archive: vercelCopy([{ key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" }]),
        project: PROJECT_ID,
        token: TOKEN,
        work: folder("lastgood-vercel-work-"),
        say: () => {},
        api: api.api,
        fetchImpl,
        sleep: quiet,
      });
      assert.equal(note, "1 variable");
      assert.deepEqual(types, ["application/json"]);
      assert.deepEqual(api.project.envs.map((env) => env.key), ["ANALYTICS_ID", "SITE_NAME"]);
    } finally {
      await api.close();
    }
  });

  it("names Vercel's refusal by its status when its message is not text", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ statusCode: 400, message: ["project must be shorter"], error: "Bad Request" }), { status: 400 });
    await assert.rejects(
      rebuildVercel({ archive: vercelCopy(), project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: () => {}, api: "http://127.0.0.1:9", fetchImpl, sleep: quiet }),
      /Vercel would not answer when reading the new project: HTTP 400\./,
    );
  });
});

describe("lastgood rebuild: Vercel environment variables, slow and lost answers", () => {
  const quiet = async () => {};
  const TWO = [
    { key: "SITE_NAME", type: "plain", target: ["production"], customEnvironmentIds: [], value: "Acme Notes" },
    { key: "API_KEY", type: "encrypted", target: ["production"], customEnvironmentIds: [], value: "api-key-long-value" },
  ];
  const sent = (api, key) => api.project.bodies.filter((body) => body.includes(`"key":"${key}"`)).length;
  const stored = (api, key) => api.project.envs.filter((env) => env.key === key).length;

  it("sends a variable again when its answer was lost before Vercel took it", async () => {
    const api = await fakeVercel({ loseOnce: ["API_KEY"], team: null });
    try {
      const said = [];
      const note = await rebuildVercel({ archive: vercelCopy(TWO), project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: (line) => said.push(line), api: api.api, sleep: quiet });
      assert.equal(note, "2 variables");
      assert.match(said.join("\n"), /Put back 2 environment variables: SITE_NAME \(production\), API_KEY \(production\)\./);
      assert.equal(sent(api, "API_KEY"), 2);
      assert.equal(stored(api, "API_KEY"), 1);
    } finally {
      await api.close();
    }
  });

  it("puts a variable back once when Vercel answers 500 after taking it, or its answer is cut off", async () => {
    const api = await fakeVercel({ failOnce: ["API_KEY"], cutOnce: ["SITE_NAME"], team: null });
    try {
      const said = [];
      const note = await rebuildVercel({ archive: vercelCopy(TWO), project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: (line) => said.push(line), api: api.api, sleep: quiet });
      assert.equal(note, "2 variables");
      assert.match(said.join("\n"), /Put back 2 environment variables: SITE_NAME \(production\), API_KEY \(production\)\./);
      for (const key of ["SITE_NAME", "API_KEY"]) {
        assert.equal(sent(api, key), 1, `${key} is sent once`);
        assert.equal(stored(api, key), 1, key);
      }
    } finally {
      await api.close();
    }
  });

  // A stalled call never ends without its time limit, so the stand-in is closed even when the test times out.
  it("asks again for a read that stalls past its time limit, giving every call the same limit", { timeout: 20_000 }, async (t) => {
    const api = await fakeVercel({ stallOnce: [`GET /v10/projects/${PROJECT_ID}/env`], team: null });
    t.after(api.close);
    const asked = [];
    const note = await rebuildVercel({ archive: vercelCopy(TWO), project: PROJECT_ID, token: TOKEN, work: folder("lastgood-vercel-work-"), say: () => {}, api: api.api, sleep: quiet, limit: (bytes) => (asked.push(bytes), 300) });
    assert.equal(note, "2 variables");
    assert.equal(api.project.routes.filter((route) => route === `GET /v10/projects/${PROJECT_ID}/env`).length, 3, "the stalled list, its retry, and the check after");
    assert.ok(asked.length >= 5 && asked.every((bytes) => bytes === undefined), "no Vercel call carries enough to need longer");
  });
});
