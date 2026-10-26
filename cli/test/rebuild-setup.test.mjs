import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { authChanges, checkToken, envNames, looksMasked, otherRefs, rebuildSetup, rewriteHooks, SECRET_FIELD, setupRef, storageChanges } from "../lib/rebuild-setup.mjs";
import { NOT_SECRET, redactAuthConfig, SOUNDS_SECRET } from "../lib/lifeboat/supabase-setup.mjs";

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
const TOKEN = "sbp_rebuild-test-token";
const HELLO = 'const key = Deno.env.get("STRIPE_KEY");\nconst url = Deno.env.get("SUPABASE_URL");\nDeno.serve(() => new Response("hi"));\n';

/** A setup copy as the backup makes it (lifeboat/scripts/supabase-setup.mjs, which the package carries as lib/lifeboat/): one function as files, one as a bundle. */
function setupCopy() {
  const dir = folder("lastgood-setup-copy-");
  const pack = path.join(dir, "pack");
  const saved = "files/tmp/user_fn/source/index.ts";
  mkdirSync(path.join(pack, "functions", "hello", "files", "tmp", "user_fn", "source"), { recursive: true });
  writeFileSync(path.join(pack, "functions", "hello", ...saved.split("/")), HELLO);
  writeFileSync(
    path.join(pack, "functions", "hello", "source.json"),
    JSON.stringify({
      slug: "hello",
      format: "files",
      entrypoint_path: "file:///tmp/user_fn/source/index.ts",
      metadata: { entrypoint_path: "file:///tmp/user_fn/source/index.ts" },
      files: [{ path: "/tmp/user_fn/source/index.ts", saved, bytes: Buffer.byteLength(HELLO) }],
    }),
  );
  const bundle = Buffer.from('ESZIP2 ... Deno.env.get("RESEND_API_KEY") ...');
  mkdirSync(path.join(pack, "functions", "legacy"), { recursive: true });
  writeFileSync(path.join(pack, "functions", "legacy", "body.eszip"), bundle);
  writeFileSync(path.join(pack, "functions", "legacy", "source.json"), JSON.stringify({ slug: "legacy", format: "eszip", entrypoint_path: "file:///src/index.ts", bytes: bundle.length }));
  const files = {
    "functions.json": [
      { slug: "hello", name: "hello", verify_jwt: true, entrypoint_path: "file:///tmp/user_fn/source/index.ts" },
      { slug: "legacy", name: "legacy", verify_jwt: false },
    ],
    "auth-config.json": {
      site_url: "https://notes.example",
      uri_allow_list: "https://notes.example/**",
      external_google_enabled: true,
      external_google_client_id: "google-client",
      external_google_secret: "********",
      smtp_pass: "real-smtp-pass",
      external_github_secret: null,
      mailer_otp_exp: 3600,
      hook_custom_access_token_enabled: true,
      hook_custom_access_token_uri: `https://${OLD_REF}.supabase.co/functions/v1/access-token-hook`,
      hook_send_email_enabled: true,
      hook_send_email_uri: `https://${OLD_REF}.supabase.co/functions/v1/hello`,
      custom_oauth_max_providers: 3,
      saml_enabled: true,
    },
    "auth-third-party.json": [{ id: "x", type: "clerk", oidc_issuer_url: "https://clerk.notes.example" }],
    "storage-config.json": { fileSizeLimit: 104857600, features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: true } } },
    "buckets.json": [],
    "cron-jobs.json": [
      { jobid: 1, jobname: "nightly-digest", schedule: "0 3 * * *", command: `select net.http_post('https://${OLD_REF}.supabase.co/functions/v1/digest')` },
      { jobid: 2, jobname: "vacuum", schedule: "0 4 * * 0", command: "vacuum analyze" },
    ],
    "database-webhooks.json": [
      { schema: "public", table: "orders", trigger: "notify_order", definition: `... supabase_functions.http_request('https://${OLD_REF}.supabase.co/functions/v1/notify', 'POST') ...` },
    ],
    "vault-secret-names.json": [{ name: "stripe_webhook" }],
  };
  for (const [file, value] of Object.entries(files)) writeFileSync(path.join(pack, file), JSON.stringify(value));
  const archive = path.join(dir, "setup.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", pack, "."]);
  return archive;
}

/**
 * A stand-in for the Management API, holding one new project: its functions, auth, third-party auth and storage
 * settings and secrets, as Supabase answers for them. Settings in `refuse` are refused as a plan would, echoing the
 * token back to prove it never reaches a message. Every request body is kept so a test can check what was sent.
 */
async function fakeManagement({ refuse = [], refuseEszip = false } = {}) {
  const project = {
    functions: new Map(),
    auth: { site_url: "http://localhost:3000", uri_allow_list: "", external_google_enabled: false, mailer_otp_exp: 3600, saml_enabled: false },
    thirdParty: [],
    storage: { fileSizeLimit: 52428800, features: { imageTransformation: { enabled: false }, s3Protocol: { enabled: true } } },
    secrets: [],
    bodies: [],
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    project.bodies.push(body.toString("latin1"));
    const send = (status, json) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Unauthorized" });
    const url = new URL(request.url, "http://api");
    const prefix = `/v1/projects/${NEW_REF}`;
    if (!url.pathname.startsWith(prefix)) return send(404, { message: "Project not found" });
    const route = `${request.method} ${url.pathname.slice(prefix.length)}`;
    const refused = (fields) => fields.find((field) => refuse.includes(field));
    switch (route) {
      case "GET ":
        return send(200, { ref: NEW_REF, status: "ACTIVE_HEALTHY" });
      case "GET /functions":
        return send(200, [...project.functions.values()].map(({ slug, name, verify_jwt }) => ({ slug, name, verify_jwt })));
      case "POST /functions/deploy": {
        const form = await new Request("http://api", { method: "POST", headers: { "content-type": request.headers["content-type"] }, body }).formData();
        const metadata = JSON.parse(form.get("metadata"));
        const files = await Promise.all(form.getAll("file").map(async (file) => ({ name: file.name, text: await file.text() })));
        const slug = url.searchParams.get("slug");
        project.functions.set(slug, { slug, name: metadata.name, verify_jwt: metadata.verify_jwt, metadata, files });
        return send(201, { slug });
      }
      case "POST /functions": {
        if (refuseEszip) return send(400, { message: "Bundles are no longer accepted" });
        const slug = url.searchParams.get("slug");
        project.functions.set(slug, { slug, name: url.searchParams.get("name"), verify_jwt: url.searchParams.get("verify_jwt") === "true", eszip: body, type: request.headers["content-type"] });
        return send(201, { slug });
      }
      case "GET /config/auth":
        return send(200, project.auth);
      case "PATCH /config/auth": {
        const change = JSON.parse(String(body));
        const no = refused(Object.keys(change));
        if (no) return send(400, { message: `${no} needs the Pro plan (sent with ${request.headers.authorization})` });
        Object.assign(project.auth, change);
        return send(200, project.auth);
      }
      case "GET /config/auth/third-party-auth":
        return send(200, project.thirdParty);
      case "POST /config/auth/third-party-auth":
        project.thirdParty.push(JSON.parse(String(body)));
        return send(201, {});
      case "GET /config/storage":
        return send(200, project.storage);
      case "PATCH /config/storage": {
        const change = JSON.parse(String(body));
        const no = refused(Object.keys(change.features ?? {}).map((name) => `features.${name}`));
        if (no) return send(402, { message: `${no} is not on this plan` });
        project.storage = { ...project.storage, ...change, features: { ...project.storage.features, ...change.features } };
        return send(200, project.storage);
      }
      case "GET /secrets":
        return send(200, project.secrets);
      default:
        return send(404, { message: `No route for ${route}` });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { api: `http://127.0.0.1:${server.address().port}`, project, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe("lastgood rebuild: Edge Functions and settings, the decisions", () => {
  it("sends only changed auth settings, never a secret or a masked value, and lists those by name", () => {
    const { change, byHand } = authChanges(
      { site_url: "https://a.example", mailer_otp_exp: 3600, smtp_pass: "p", external_google_secret: "x", external_apple_secret: null, sms_twilio_auth_token: "t", hook_send_email_secrets: "v1,whsec", jwt_exp: "******", custom_oauth_max_providers: 3, password_min_length: 8 },
      { site_url: "http://localhost:3000", mailer_otp_exp: 3600, password_min_length: 6 },
    );
    assert.deepEqual(change, { site_url: "https://a.example", password_min_length: 8 });
    assert.deepEqual(byHand, ["external_google_secret", "hook_send_email_secrets", "jwt_exp", "sms_twilio_auth_token", "smtp_pass"]);
    assert.equal(looksMasked("abc"), false);
    assert.equal(looksMasked("<redacted>"), true);
  });

  it("treats every secret-shaped auth setting in Supabase's API spec as a secret, and knows each that only sounds like one", () => {
    // Every UpdateAuthConfigBody field in Supabase's spec. A new field that sounds like a secret but is not caught
    // fails here until it is sorted into one list or the other, so it can never be sent by accident.
    const { fields } = JSON.parse(readFileSync(path.join(HERE, "fixtures", "auth-config-fields.json"), "utf8"));
    assert.equal(fields.length, 235);
    assert.deepEqual(fields.filter((field) => SECRET_FIELD.test(field)), [
      ...["apple", "azure", "bitbucket", "discord", "facebook", "figma", "github", "gitlab", "google", "kakao", "keycloak", "linkedin_oidc", "notion", "slack_oidc", "slack", "spotify", "twitch", "twitter", "workos", "x", "zoom"].map((provider) => `external_${provider}_secret`),
      ...["after_user_created", "before_user_created", "custom_access_token", "mfa_verification_attempt", "password_verification_attempt", "send_email", "send_sms"].map((hook) => `hook_${hook}_secrets`),
      "nimbus_oauth_client_secret",
      "security_captcha_secret",
      "sms_messagebird_access_key",
      "sms_textlocal_api_key",
      "sms_twilio_auth_token",
      "sms_twilio_verify_auth_token",
      "sms_vonage_api_key",
      "sms_vonage_api_secret",
      "smtp_pass",
    ]);
    // Every other name that sounds like a secret is a setting, read one by one into NOT_SECRET in the backup's script.
    assert.deepEqual(
      fields.filter((field) => SOUNDS_SECRET.test(field) && !SECRET_FIELD.test(field)),
      [...NOT_SECRET].sort(),
    );
    assert.ok(NOT_SECRET.has("password_min_length") && NOT_SECRET.has("external_keycloak_url"));
  });

  it("lists every secret the backup blanked by name, and sends none of them", () => {
    // A copy as the backup writes it now: each secret that had a value is "<redacted>", an empty one stays empty.
    const copy = redactAuthConfig({
      site_url: "https://a.example",
      smtp_pass: "real-smtp-pass",
      external_google_secret: "g",
      external_github_secret: "",
      hook_send_email_secrets: "v1,whsec_x",
      sms_newco_token: "t",
      password_min_length: 8,
    });
    const { change, byHand } = authChanges(copy, { site_url: "http://localhost:3000", password_min_length: 6 });
    assert.deepEqual(change, { site_url: "https://a.example", password_min_length: 8 });
    assert.deepEqual(byHand, ["external_google_secret", "hook_send_email_secrets", "sms_newco_token", "smtp_pass"]);
  });

  it("sends the storage limit and only the features that differ", () => {
    assert.deepEqual(storageChanges({ fileSizeLimit: 10, features: { imageTransformation: { enabled: true }, s3Protocol: { enabled: true }, other: { enabled: true } } }, { fileSizeLimit: 5, features: { s3Protocol: { enabled: true } } }), {
      fileSizeLimit: 10,
      features: { imageTransformation: { enabled: true } },
    });
    assert.deepEqual(storageChanges({ fileSizeLimit: 5 }, { fileSizeLimit: 5 }), {});
  });

  it("points a hook at the new project only for a function this run deployed, and never back at the old one", () => {
    const fn = (ref, rest) => `https://${ref}.supabase.co/functions/v1/${rest}`;
    const { auth, rewritten } = rewriteHooks(
      {
        hook_send_email_uri: fn(OLD_REF, "mailer"),
        hook_send_sms_uri: fn(OLD_REF, "sms/send?x=1"),
        hook_custom_access_token_uri: fn(OLD_REF, "claims"),
        hook_mfa_verification_attempt_uri: fn(OLD_REF, "mfa"),
        hook_password_verification_attempt_uri: "pg-functions://postgres/public/check_password",
        hook_before_user_created_uri: fn(NEW_REF, "mailer"),
        site_url: fn(OLD_REF, "mailer"),
      },
      { hook_mfa_verification_attempt_uri: fn(NEW_REF, "mfa") },
      NEW_REF,
      ["mailer", "sms"],
    );
    assert.equal(auth.hook_send_email_uri, fn(NEW_REF, "mailer"));
    assert.equal(auth.hook_send_sms_uri, fn(NEW_REF, "sms/send?x=1"), "the path and query after the function stay");
    assert.equal(auth.hook_custom_access_token_uri, fn(OLD_REF, "claims"), "a function this run did not deploy is left for the customer");
    assert.equal(auth.hook_mfa_verification_attempt_uri, fn(NEW_REF, "mfa"), "a hook an earlier run pointed at the new project stays there");
    assert.equal(auth.hook_password_verification_attempt_uri, "pg-functions://postgres/public/check_password");
    assert.equal(auth.site_url, fn(OLD_REF, "mailer"), "only hooks are rewritten");
    assert.deepEqual(rewritten, [`hook_send_email_uri (${OLD_REF} to ${NEW_REF})`, `hook_send_sms_uri (${OLD_REF} to ${NEW_REF})`]);
  });

  it("reads the secret names a function uses, and the old project a job still calls", () => {
    assert.deepEqual([...envNames('Deno.env.get("A_KEY"); Deno.env.get(\'B\'); Deno.env.get("SUPABASE_URL"); process.env.C; Deno.env.get(name)')].sort(), ["A_KEY", "B", "C"]);
    assert.deepEqual(otherRefs(`https://${OLD_REF}.supabase.co and https://${NEW_REF}.supabase.co`, NEW_REF), [OLD_REF]);
  });

  it("takes an access token and a project ref, and refuses an API key or another project", () => {
    assert.equal(checkToken(` ${TOKEN} `), TOKEN);
    assert.throws(() => checkToken(""), /Set LASTGOOD_SUPABASE_TOKEN/);
    assert.throws(() => checkToken("sb_secret_x"), /holds a project API key/);
    assert.equal(setupRef(undefined, NEW_REF), NEW_REF);
    assert.throws(() => setupRef(undefined, null), /Give --project-ref/);
    assert.throws(() => setupRef("short", null), /20-letter ref/);
    assert.throws(() => setupRef(OLD_REF, NEW_REF), /--project-ref is oldprojectrefaaaaaaa, but the database connection string is project newprojectrefbbbbbbb/);
  });

  it("asks for the token and the project before anything runs", async () => {
    const noToken = await cli(["rebuild", "--key", "k.txt", "--setup", "s.tar.gz.age", "--project-ref", NEW_REF], { LASTGOOD_SUPABASE_TOKEN: "" });
    assert.equal(noToken.status, 2);
    assert.match(noToken.stderr, /Set LASTGOOD_SUPABASE_TOKEN to an access token for the new project/);
    const noRef = await cli(["rebuild", "--key", "k.txt", "--setup", "s.tar.gz.age"], { LASTGOOD_SUPABASE_TOKEN: TOKEN, LASTGOOD_DATABASE_TO: "" });
    assert.equal(noRef.status, 2);
    assert.match(noRef.stderr, /Give --project-ref/);
  });
});

describe("lastgood rebuild: Edge Functions and settings", () => {
  const archive = setupCopy();
  const quiet = async () => {};

  it("deploys every function, sets the changed settings, never sends a secret, lists what is left, and keeps everything on a rerun", async () => {
    const api = await fakeManagement({ refuse: ["saml_enabled", "features.imageTransformation"] });
    try {
      const said = [];
      const todo = [];
      const note = await rebuildSetup({
        archive,
        ref: NEW_REF,
        token: TOKEN,
        work: folder("lastgood-setup-work-"),
        say: (line) => said.push(line),
        todo: (line) => (todo.push(line), said.push(line)),
        api: api.api,
        sleep: quiet,
      });
      // What the customer still does by hand goes to the end-of-run list too; progress does not.
      assert.deepEqual(
        todo.map((line) => line.split(/[:.]/)[0]),
        [
          "These auth settings still name another Supabase project, so the new one would call it",
          "Set these auth settings by hand, since the copy never sends a secret",
          "Supabase did not take these, most likely because of the new project's plan",
          "The functions read secrets the new project does not have yet",
          "Scheduled jobs are not recreated, so none calls the old project by mistake",
          "Database webhooks that came back with the database still call the old project",
          "Add these Vault secrets again",
          "The new project has its own API keys (Project Settings, then API Keys)",
        ],
      );
      const text = said.join("\n");
      assert.equal(note, "2 functions, 10 settings, 5 to set by hand");
      assert.doesNotMatch(text, /rebuild-test-token/, "the token is never printed, even when Supabase echoes it");

      // Functions: the files one through the deploy endpoint, the bundle through the older one.
      const hello = api.project.functions.get("hello");
      assert.equal(hello.metadata.entrypoint_path, "/tmp/user_fn/source/index.ts");
      assert.equal(hello.verify_jwt, true);
      assert.deepEqual(hello.files, [{ name: "/tmp/user_fn/source/index.ts", text: HELLO }]);
      const legacy = api.project.functions.get("legacy");
      assert.equal(legacy.type, "application/vnd.denoland.eszip");
      assert.equal(legacy.verify_jwt, false);
      assert.match(text, /Deployed 2 Edge Functions: hello, legacy\./);
      assert.match(text, /The new project lists every Edge Function deployed, each with the JWT check it had\./);

      // Settings: changed ones set, secrets and masked values never sent, the plan's refusals named.
      assert.equal(api.project.auth.site_url, "https://notes.example");
      assert.equal(api.project.auth.external_google_client_id, "google-client");
      assert.equal(api.project.auth.saml_enabled, false);
      const sent = api.project.bodies.join("\n");
      assert.doesNotMatch(sent, /real-smtp-pass|\*\*\*\*|external_google_secret|smtp_pass|custom_oauth_max_providers|mailer_otp_exp/);
      assert.match(text, /Auth settings set as they were: site_url, uri_allow_list, external_google_enabled, external_google_client_id, hook_custom_access_token_enabled, hook_custom_access_token_uri, hook_send_email_enabled, hook_send_email_uri\./);
      // A hook calling a function this run deployed is pointed at the new project; one calling any other stays flagged.
      assert.match(text, /Pointed these hooks at the new project, since this run deployed the function each calls: hook_send_email_uri \(oldprojectrefaaaaaaa to newprojectrefbbbbbbb\)\./);
      assert.equal(api.project.auth.hook_send_email_uri, `https://${NEW_REF}.supabase.co/functions/v1/hello`);
      assert.equal(api.project.auth.hook_custom_access_token_uri, `https://${OLD_REF}.supabase.co/functions/v1/access-token-hook`);
      assert.match(text, /These auth settings still name another Supabase project, so the new one would call it: hook_custom_access_token_uri \(oldprojectrefaaaaaaa\)\. Point each at the new project/);
      assert.match(text, /site_url: https:\/\/notes\.example\. If the app moves to a new domain, change it in Supabase/);
      assert.match(text, /uri_allow_list: https:\/\/notes\.example\/\*\*\./);
      assert.match(text, /Set these auth settings by hand, since the copy never sends a secret: external_google_secret, smtp_pass\./);
      assert.match(text, /Supabase did not take these, most likely because of the new project's plan\. Set them by hand: auth saml_enabled \(saml_enabled needs the Pro plan \(sent with Bearer …\)\); storage features\.imageTransformation/);
      assert.deepEqual(api.project.thirdParty, [{ oidc_issuer_url: "https://clerk.notes.example" }]);
      assert.equal(api.project.storage.fileSizeLimit, 104857600);
      assert.match(text, /Storage settings set as they were: fileSizeLimit\./);

      // What is left for the customer.
      assert.match(text, /The functions read secrets the new project does not have yet\. Set them under Edge Functions, then Secrets: RESEND_API_KEY, STRIPE_KEY\./);
      assert.match(text, /Scheduled jobs are not recreated, so none calls the old project by mistake\. Add them again with pg_cron: nightly-digest \(0 3 \* \* \*\), which calls the old project oldprojectrefaaaaaaa; vacuum \(0 4 \* \* 0\)\./);
      assert.match(text, /Database webhooks that came back with the database still call the old project\. Point them at the new one: notify_order on public\.orders\./);
      assert.match(text, /Add these Vault secrets again: stripe_webhook\./);

      // A rerun keeps every function and sends no setting twice.
      const before = api.project.bodies.length;
      const again = [];
      await rebuildSetup({ archive, ref: NEW_REF, token: TOKEN, work: folder("lastgood-setup-work-"), say: (line) => again.push(line), api: api.api, sleep: quiet });
      assert.match(again.join("\n"), /Already in the new project, kept and not deployed again: hello, legacy\./);
      assert.doesNotMatch(again.join("\n"), /Deployed|Added/);
      assert.doesNotMatch(again.join("\n"), /Pointed these hooks/);
      assert.equal(api.project.auth.hook_send_email_uri, `https://${NEW_REF}.supabase.co/functions/v1/hello`, "a rerun never points a hook back at the old project");
      const resent = api.project.bodies.slice(before).filter((item) => item.includes("site_url") || item.includes("clerk") || item.includes("hook_send_email_uri"));
      assert.deepEqual(resent, [], "no setting already set is sent again");
    } finally {
      await api.close();
    }
  });

  it("names a bundle Supabase refuses, with how to deploy it by hand, and stops on a refused token", async () => {
    const api = await fakeManagement({ refuseEszip: true });
    try {
      const work = folder("lastgood-setup-work-");
      await assert.rejects(rebuildSetup({ archive, ref: NEW_REF, token: TOKEN, work, say: () => {}, api: api.api, sleep: quiet }), (error) => {
        assert.match(error.message, /Supabase did not take 1 Edge Function: legacy \(Bundles are no longer accepted\)\./);
        assert.match(error.hint, /The copy holds legacy as a bundle.*Deploy it by hand from the code copy's supabase\/functions folder with supabase functions deploy/);
        return true;
      });
      assert.equal(api.project.functions.has("hello"), true, "the function that went in is kept");
      await assert.rejects(rebuildSetup({ archive, ref: NEW_REF, token: "sbp_wrong", work, say: () => {}, api: api.api, sleep: quiet }), /Supabase refused the token in LASTGOOD_SUPABASE_TOKEN when reading the new project\./);
    } finally {
      await api.close();
    }
  });
});
