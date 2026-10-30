import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { planRecords, rebuildVercelSettings, settingsChange } from "../lib/rebuild-vercel-settings.mjs";

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function folder(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const TOKEN = "vercel-settings-test-token";
const PROJECT_ID = "prj_newnotes";
const TEAM_ID = "team_acme";
const ENV_VALUE = "env-secret-value-in-the-copy";
const quiet = async () => {};

/** The settings as the backup keeps them (lifeboat/scripts/vercel-settings.mjs). */
const SETTINGS = {
  id: "prj_oldnotes",
  name: "notes",
  framework: "nextjs",
  nodeVersion: "20.x",
  buildCommand: "npm run build:app",
  installCommand: null,
  directoryListing: false,
  skewProtectionMaxAge: 3600,
  resourceConfig: { functionDefaultTimeout: 60, fluid: true, functionDefaultRegions: ["syd1"] },
  ssoProtection: { deploymentType: "prod_deployment_urls_and_all_previews" },
  link: { type: "github", org: "acme", repo: "notes", productionBranch: "production", deployHooks: [{ name: "cms", ref: "main" }] },
  crons: [{ path: "/api/cron", schedule: "0 * * * *" }],
};
const DOMAINS = [
  { name: "notes-old.vercel.app", apexName: "vercel.app", verified: true },
  { name: "www.acmenotes.com", apexName: "acmenotes.com", redirect: "acmenotes.com", redirectStatusCode: 308, verified: true },
  { name: "acmenotes.com", apexName: "acmenotes.com", verified: true },
  { name: "staging.acmenotes.com", apexName: "acmenotes.com", gitBranch: "staging", verified: true },
  { name: "taken.example.org", apexName: "example.org", verified: true },
  { name: "preview.acmenotes.com", apexName: "acmenotes.com", customEnvironmentId: "env_oldcustom", verified: true },
];
const DNS = [
  {
    domain: "acmenotes.com",
    records: [
      { name: "", type: "MX", value: "mx1.mail.example.", mxPriority: 10, ttl: 3600 },
      { name: "", type: "MX", value: "mx2.mail.example", mxPriority: 20 },
      { name: "", type: "TXT", value: "v=spf1 include:mail.example ~all" },
      { name: "", type: "TXT", value: "google-site-verification=abc" },
      { name: "api", type: "CNAME", value: "old-api.example.net" },
      { name: "_sip._tcp", type: "SRV", value: "10 5060 sip.example.net", priority: 5 },
      { name: "", type: "ALIAS", value: "cname.vercel-dns-017.com." },
    ],
    note: null,
  },
  { domain: "example.org", records: [{ name: "", type: "A", value: "192.0.2.1" }], note: null },
  { domain: "outside.net", records: null, note: "This token cannot read this domain's DNS records." },
];

/** A Vercel copy as the backup makes it: env.json and settings.json in a tar.gz, packed from the folder's root. */
function vercelCopy(settings = { project: "prj_oldnotes", teamId: TEAM_ID, settings: SETTINGS, domains: DOMAINS, dns: DNS }) {
  const dir = folder("lastgood-vercel-settings-copy-");
  const pack = path.join(dir, "pack");
  mkdirSync(pack);
  writeFileSync(path.join(pack, "env.json"), JSON.stringify({ project: "prj_oldnotes", teamId: TEAM_ID, variables: [{ key: "SECRET", type: "encrypted", target: ["production"], value: ENV_VALUE }] }));
  if (settings) writeFileSync(path.join(pack, "settings.json"), JSON.stringify(settings));
  const archive = path.join(dir, "vercel.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", pack, "."]);
  return archive;
}

/**
 * A stand-in for Vercel's API, holding one new project as an import makes it, its domains and the team's DNS zones.
 * Settings in `refuseSettings` are refused whenever a PATCH carries them, as a plan would. Domains in `taken` are
 * refused as in use elsewhere and those in `unverified` are added with a TXT challenge. Zones not in `zones` answer
 * 403. A domain or record in `dropOnce` is stored, then the connection drops before Vercel answers, and with
 * `failPatchOnce` the first settings change is made and answered with a 500. A domain or record in
 * `vanish` is answered as added but never stored. With `pageSize`, a zone's records come that many to a page, the
 * next page's `until` being where it starts, and with `stuck` every page names the second as next.
 * Every request is kept.
 */
async function fakeVercel({ refuseSettings = ["skewProtectionMaxAge"], taken = ["taken.example.org"], unverified = ["acmenotes.com"], dropOnce = [], failPatchOnce = false, vanish = [], pageSize = null, stuck = false } = {}) {
  const state = {
    project: {
      id: PROJECT_ID,
      name: "notes-rebuilt",
      framework: "nextjs",
      nodeVersion: "22.x",
      buildCommand: null,
      directoryListing: false,
      resourceConfig: { functionDefaultTimeout: 10, fluid: true, functionDefaultMemoryType: "standard" },
      ssoProtection: { deploymentType: "all_except_custom_domains" },
      link: { type: "github", org: "acme", repo: "notes-rebuilt", productionBranch: "main" },
    },
    domains: [{ name: "notes-rebuilt.vercel.app", apexName: "vercel.app", verified: true }],
    zones: {
      "acmenotes.com": [
        { id: "rec_1", name: "", type: "ALIAS", value: "cname.vercel-dns-017.com", creator: "system" },
        { id: "rec_2", name: "api", type: "CNAME", value: "new-api.example.net", creator: "user" },
      ],
    },
    requests: [],
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://api");
    state.requests.push({ method: request.method, path: url.pathname, query: url.search, body: text });
    const send = (status, json) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "forbidden", message: "Not authorized" } });
    if (url.searchParams.get("teamId") !== TEAM_ID) return send(403, { error: { code: "forbidden", message: "Not authorized" } });
    const route = `${request.method} ${url.pathname}`;
    const zone = /^\/v[25]\/domains\/([^/]+)\/records$/.exec(url.pathname)?.[1];
    if (route === `GET /v9/projects/${PROJECT_ID}`) return send(200, state.project);
    if (route === `PATCH /v9/projects/${PROJECT_ID}`) {
      const change = JSON.parse(text);
      const refused = Object.keys(change).find((field) => refuseSettings.includes(field));
      if (refused) return send(400, { error: { code: "plan", message: `${refused} needs a paid plan (${request.headers.authorization})` } });
      // resourceConfig is taken whole, as sent.
      Object.assign(state.project, change);
      if (failPatchOnce) {
        failPatchOnce = false;
        return send(500, { error: { code: "internal_server_error", message: "An unexpected error occurred" } });
      }
      return send(200, state.project);
    }
    if (route === `GET /v9/projects/${PROJECT_ID}/domains`) return send(200, { domains: state.domains, pagination: { count: state.domains.length, next: null } });
    if (route === `POST /v10/projects/${PROJECT_ID}/domains`) {
      const domain = JSON.parse(text);
      if (state.domains.some((have) => have.name === domain.name)) return send(400, { error: { code: "domain_already_in_use", message: "The domain is already on this project" } });
      if (taken.includes(domain.name)) return send(409, { error: { code: "domain_already_in_use", message: `Cannot add ${domain.name} since it's already in use by your account.` } });
      if (domain.redirect && !state.domains.some((have) => have.name === domain.redirect)) return send(400, { error: { code: "invalid_redirect", message: "The redirect target is not on this project" } });
      if (vanish.includes(domain.name)) return send(200, { ...domain, verified: true });
      const added = { ...domain, apexName: domain.name.split(".").slice(-2).join("."), verified: !unverified.includes(domain.name) };
      if (!added.verified) added.verification = [{ type: "TXT", domain: `_vercel.${domain.name}`, value: `vc-domain-verify=${domain.name},abc123`, reason: "pending_domain_verification" }];
      state.domains.push(added);
      if (dropOnce.includes(domain.name)) {
        dropOnce.splice(dropOnce.indexOf(domain.name), 1);
        return request.socket.destroy();
      }
      return send(200, added);
    }
    if (zone && request.method === "GET") {
      if (!state.zones[zone]) return send(403, { error: { code: "forbidden", message: "You don't have access to the domain" } });
      if (!pageSize) return send(200, { records: state.zones[zone], pagination: { count: state.zones[zone].length, next: null } });
      const start = Number(url.searchParams.get("until") ?? 0);
      const records = state.zones[zone].slice(start, start + pageSize);
      const next = stuck ? pageSize : start + pageSize < state.zones[zone].length ? start + pageSize : null;
      return send(200, { records, pagination: { count: records.length, next } });
    }
    if (zone && request.method === "POST") {
      if (!state.zones[zone]) return send(403, { error: { code: "forbidden", message: "You don't have access to the domain" } });
      const record = JSON.parse(text);
      if (vanish.includes(`${record.name} ${record.type} ${record.value}`)) return send(200, { uid: "rec_gone", updated: Date.now() });
      state.zones[zone].push({ id: `rec_${state.requests.length}`, creator: "user", ...record });
      const key = `${record.name} ${record.type} ${record.value}`;
      if (dropOnce.includes(key)) {
        dropOnce.splice(dropOnce.indexOf(key), 1);
        return request.socket.destroy();
      }
      return send(200, { uid: `rec_${state.requests.length}`, updated: Date.now() });
    }
    return send(404, { error: { code: "not_found", message: `No route for ${route}` } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { api: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

function step(api, archive, overrides = {}) {
  const said = [];
  const todo = [];
  const work = folder("lastgood-vercel-settings-work-");
  const done = rebuildVercelSettings({
    archive,
    project: PROJECT_ID,
    team: TEAM_ID,
    token: TOKEN,
    work,
    say: (line) => said.push(line),
    todo: (line) => (todo.push(line), said.push(line)),
    api: api.api,
    sleep: quiet,
    ...overrides,
  });
  return { done, said, todo, work };
}

describe("lastgood rebuild: Vercel settings and domains, the decisions", () => {
  it("sends only the settings that differ, and resourceConfig whole with the new project's others as they are", () => {
    const change = settingsChange(SETTINGS, { framework: "nextjs", nodeVersion: "22.x", directoryListing: false, resourceConfig: { functionDefaultTimeout: 10, fluid: true, functionDefaultMemoryType: "standard" } });
    assert.deepEqual(Object.keys(change), ["nodeVersion", "buildCommand", "skewProtectionMaxAge", "resourceConfig", "ssoProtection"], "null and missing count as the same");
    assert.deepEqual(change.resourceConfig, {
      kept: { functionDefaultTimeout: 10, fluid: true, functionDefaultMemoryType: "standard" },
      set: { functionDefaultTimeout: 60, functionDefaultRegions: ["syd1"] },
    });
    assert.deepEqual(settingsChange({ framework: "nextjs" }, { framework: "nextjs" }), {});
  });

  it("adds a zone's missing records only where every record it has for that name and type is in the copy", () => {
    const planned = planRecords("acmenotes.com", DNS[0].records, [
      { name: "", type: "ALIAS", value: "cname.vercel-dns-017.com" },
      { name: "api", type: "CNAME", value: "new-api.example.net" },
      { name: "", type: "MX", value: "MX1.mail.example", mxPriority: 10 },
    ]);
    assert.deepEqual(
      planned.add.map((record) => `${record.type} ${record.value}`),
      ["MX mx2.mail.example", "TXT v=spf1 include:mail.example ~all", "TXT google-site-verification=abc"],
      "a group already partly there gets the rest, as on a rerun",
    );
    assert.equal(planned.kept, 2, "the ALIAS and the first MX, matched without case or the final dot");
    assert.deepEqual(planned.changed, ["api.acmenotes.com CNAME"], "a record changed since the backup is never doubled up");
    assert.deepEqual(planned.byHand, ["_sip._tcp.acmenotes.com SRV 10 5060 sip.example.net"]);
    const priority = planRecords("acmenotes.com", [{ name: "", type: "MX", value: "mx1.mail.example", mxPriority: 10 }], [{ name: "", type: "MX", value: "mx1.mail.example", mxPriority: 5 }]);
    assert.deepEqual(priority.changed, ["acmenotes.com MX"], "the same host at another priority is a change");
  });

  it("never sends a record the backup kept without its value, and names it by its name and type to add by hand", () => {
    const planned = planRecords(
      "acmenotes.com",
      [
        { name: "", type: "TXT", value: "v=spf1 -all" },
        { name: "google._domainkey", type: "TXT" },
        { name: "", type: "MX", value: null, mxPriority: 10 },
      ],
      [],
    );
    assert.deepEqual(planned.add, [{ name: "", type: "TXT", value: "v=spf1 -all" }]);
    assert.deepEqual(planned.tooLong, ["google._domainkey.acmenotes.com TXT", "acmenotes.com MX 10"]);
    assert.deepEqual([planned.kept, planned.changed, planned.byHand], [0, [], []]);
  });

  it("sends resourceConfig when the new project reports none", () => {
    assert.deepEqual(settingsChange({ resourceConfig: { fluid: true } }, { framework: "nextjs" }), { resourceConfig: { kept: {}, set: { fluid: true } } });
  });

  it("reads a record with no name, type or value as empty, @ as the zone itself, a TXT value with its case, and an MX priority from either field", () => {
    assert.deepEqual(planRecords("acmenotes.com", [{ type: "HTTPS" }, { name: "x", value: "y" }], []).byHand, ["acmenotes.com HTTPS (value too long to keep)", "x.acmenotes.com  y"]);
    assert.equal(planRecords("acmenotes.com", [{ name: "@", type: "TXT", value: "v=spf1 -all" }], [{ name: "", type: "TXT", value: "v=spf1 -all" }]).kept, 1, "@ is the zone itself");
    assert.deepEqual(
      planRecords("acmenotes.com", [{ name: "", type: "TXT", value: "google-site-verification=ABC" }], [{ name: "", type: "TXT", value: "google-site-verification=abc" }]).changed,
      ["acmenotes.com TXT"],
      "a TXT value is compared with its case",
    );
    const mx = (name, priority = {}) => ({ name, type: "MX", value: "mx.mail.example", ...priority });
    const priorities = planRecords(
      "acmenotes.com",
      [mx("one"), mx("two", { mxPriority: 10 }), mx("three", { priority: 10 })],
      [mx("one"), mx("two", { priority: 10 }), mx("three", { mxPriority: 10 })],
    );
    assert.deepEqual([priorities.kept, priorities.changed], [3, []], "no priority on either side is the same, and either field holds one");
  });
});

describe("lastgood rebuild: Vercel settings and domains", () => {
  it("sets the settings that differ, adds the domains and DNS records, lists the rest, and changes nothing on a rerun", async () => {
    const archive = vercelCopy();
    const api = await fakeVercel();
    try {
      const run = step(api, archive);
      const note = await run.done;
      const text = run.said.join("\n");
      assert.equal(note, "5 settings, 3 domains, 5 DNS records, 10 to do by hand");

      // Settings: Vercel refused the whole, so each went alone and the plan's one is named.
      assert.match(text, /^Project settings set as the old project had them: nodeVersion, buildCommand, resourceConfig\.functionDefaultTimeout, resourceConfig\.functionDefaultRegions, ssoProtection\.$/m);
      assert.match(text, /Vercel did not take these settings, most likely because of the new project's plan\. Set them by hand in the project's settings: skewProtectionMaxAge \(skewProtectionMaxAge needs a paid plan \(Bearer …\)\)\./);
      assert.equal(api.state.project.nodeVersion, "20.x");
      assert.equal(api.state.project.buildCommand, "npm run build:app");
      assert.deepEqual(api.state.project.resourceConfig, { functionDefaultTimeout: 60, fluid: true, functionDefaultMemoryType: "standard", functionDefaultRegions: ["syd1"] }, "the new project's other resource settings are kept");
      assert.equal(api.state.project.ssoProtection.deploymentType, "prod_deployment_urls_and_all_previews");
      assert.equal(api.state.project.name, "notes-rebuilt", "the name and id never go");
      assert.match(text, /Build production from the production branch, as the old project did/);
      assert.match(text, /Make these deploy hooks again in the project's Git settings: cms \(main\)\. Each gets a new URL/);
      assert.match(text, /1 cron job come back with the code: Vercel reads them from vercel\.json when it deploys\./);

      // Domains: the redirect after the domain it points at, the old .vercel.app left out.
      assert.match(text, /Added 3 domains to the new project: acmenotes\.com, staging\.acmenotes\.com, www\.acmenotes\.com\./);
      assert.match(text, /Left out notes-old\.vercel\.app: the new project has its own \.vercel\.app address\./);
      assert.match(text, /Add these domains once the new project has the custom environment they were for: preview\.acmenotes\.com\./);
      assert.match(text, /Vercel did not add these domains: taken\.example\.org \(Cannot add taken\.example\.org since it's already in use by your account\.\)\. A domain still on the old project has to come off it first\./);
      assert.match(text, /Prove these domains are yours, .*: acmenotes\.com: a TXT record on _vercel\.acmenotes\.com with the value vc-domain-verify=acmenotes\.com,abc123\./);
      const staging = api.state.domains.find((domain) => domain.name === "staging.acmenotes.com");
      assert.equal(staging.gitBranch, "staging");
      const www = api.state.domains.find((domain) => domain.name === "www.acmenotes.com");
      assert.equal(www.redirect, "acmenotes.com");
      assert.equal(www.redirectStatusCode, 308);

      // DNS: the missing records added, the changed CNAME kept, the rest named.
      assert.match(text, /Added 4 DNS records to acmenotes\.com: acmenotes\.com MX 10 mx1\.mail\.example\.; acmenotes\.com MX 20 mx2\.mail\.example; acmenotes\.com TXT v=spf1 include:mail\.example ~all; acmenotes\.com TXT google-site-verification=abc\./);
      assert.match(text, /These DNS records in acmenotes\.com changed since the backup, so the zone's are kept and the copy's were not added: api\.acmenotes\.com CNAME\./);
      assert.match(text, /Add these DNS records to acmenotes\.com by hand, since Vercel takes their parts separately: _sip\._tcp\.acmenotes\.com SRV 10 5060 sip\.example\.net\./);
      assert.match(text, /The DNS of example\.org is not in this Vercel team, so add these records where it is kept now: example\.org A 192\.0\.2\.1\./);
      assert.match(text, /The backup could not read the DNS records of outside\.net, most likely because its DNS is kept outside Vercel\./);
      assert.match(text, /Already in the zones as the copy has them: 1 DNS record\./);
      const zone = api.state.zones["acmenotes.com"];
      assert.equal(zone.find((record) => record.name === "api").value, "new-api.example.net", "a record is never written over");
      assert.deepEqual(zone.find((record) => record.type === "MX" && record.mxPriority === 10), { id: zone.find((record) => record.mxPriority === 10).id, creator: "user", name: "", type: "MX", value: "mx1.mail.example.", ttl: 3600, mxPriority: 10 });
      assert.equal(run.todo.length, 10);
      assert.doesNotMatch(text, new RegExp(`${TOKEN}|${ENV_VALUE}`), "no token or variable value is printed");
      assert.deepEqual(readdirSync(run.work), [], "nothing from the copy is left on disk");
      assert.ok(api.state.requests.every((request) => request.method !== "DELETE"), "nothing is ever deleted");

      // A rerun sends no settings but the refused one, adds no domain or record, and keeps everything.
      const posts = api.state.requests.filter((request) => request.method === "POST" && !request.path.endsWith("/domains")).length;
      const again = step(api, archive);
      const second = await again.done;
      const textAgain = again.said.join("\n");
      assert.equal(second, "0 settings, 3 domains, 5 DNS records, 10 to do by hand");
      assert.match(textAgain, /Already on the new project, kept as they are: acmenotes\.com, staging\.acmenotes\.com, www\.acmenotes\.com\./);
      assert.match(textAgain, /Already in the zones as the copy has them: 5 DNS records\./);
      assert.doesNotMatch(textAgain, /Added /);
      assert.equal(api.state.requests.filter((request) => request.method === "POST" && !request.path.endsWith("/domains")).length, posts);
    } finally {
      await api.close();
    }
  });

  it("never sends a DNS record twice after a dropped connection, and counts it once the zone lists it", async () => {
    const archive = vercelCopy({ settings: { framework: "nextjs" }, domains: [], dns: [{ domain: "acmenotes.com", records: [{ name: "", type: "TXT", value: "v=spf1 -all" }], note: null }] });
    const api = await fakeVercel({ dropOnce: [" TXT v=spf1 -all"] });
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "0 settings, 0 domains, 1 DNS record");
      assert.match(run.said.join("\n"), /Added 1 DNS record to acmenotes\.com: acmenotes\.com TXT v=spf1 -all\./);
      assert.equal(api.state.zones["acmenotes.com"].filter((record) => record.type === "TXT").length, 1);
      assert.equal(api.state.requests.filter((request) => request.method === "POST").length, 1);
    } finally {
      await api.close();
    }
  });

  it("reads every page of a zone's records, and stops when Vercel's pages do not move on", async () => {
    const records = [
      { name: "", type: "ALIAS", value: "cname.vercel-dns-017.com" },
      { name: "api", type: "CNAME", value: "new-api.example.net" },
      { name: "", type: "TXT", value: "v=spf1 -all" },
    ];
    const archive = vercelCopy({ settings: { framework: "nextjs" }, domains: [], dns: [{ domain: "acmenotes.com", records, note: null }] });
    const api = await fakeVercel({ pageSize: 1 });
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "0 settings, 0 domains, 3 DNS records");
      assert.match(run.said.join("\n"), /Already in the zones as the copy has them: 2 DNS records\./, "the CNAME on the second page is found");
      assert.equal(api.state.requests.filter((request) => request.method === "POST").length, 1, "only the TXT is added");
      assert.ok(api.state.requests.some((request) => request.method === "GET" && request.query.includes("until=2")), "the third page is asked for");
    } finally {
      await api.close();
    }
    const stuck = await fakeVercel({ pageSize: 1, stuck: true });
    try {
      await assert.rejects(step(stuck, archive).done, /Vercel's pages of the DNS records of acmenotes\.com did not move on\.$/);
      assert.equal(stuck.state.requests.filter((request) => request.method === "POST").length, 0, "nothing is added from a part of the zone");
    } finally {
      await stuck.close();
    }
  });

  it("sends a record's TTL from 60 seconds and its comment cut to 500 characters, and a record the copy has twice once", async () => {
    const records = [
      { name: "a", type: "A", value: "192.0.2.10", ttl: 60, comment: "c".repeat(600) },
      { name: "b", type: "A", value: "192.0.2.11", ttl: 59, comment: "" },
      { name: "b", type: "A", value: "192.0.2.11" },
    ];
    const archive = vercelCopy({ settings: { framework: "nextjs" }, domains: [], dns: [{ domain: "acmenotes.com", records, note: null }] });
    const api = await fakeVercel();
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "0 settings, 0 domains, 2 DNS records");
      const sent = api.state.requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
      assert.deepEqual(sent, [
        { name: "a", type: "A", value: "192.0.2.10", ttl: 60, comment: "c".repeat(500) },
        { name: "b", type: "A", value: "192.0.2.11" },
      ]);
    } finally {
      await api.close();
    }
    assert.deepEqual(planRecords("acmenotes.com", records, []).add, records.slice(0, 2), "the same name, type and value goes once");
  });

  it("stops when Vercel took a domain or a DNS record but does not list it, and names each one", async () => {
    const domains = [
      { name: "acmenotes.com", apexName: "acmenotes.com", verified: true },
      { name: "staging.acmenotes.com", apexName: "acmenotes.com", verified: true },
    ];
    const records = [
      { name: "", type: "TXT", value: "v=spf1 -all" },
      { name: "", type: "TXT", value: "google-site-verification=abc" },
    ];
    for (const [vanish, said] of [
      [["acmenotes.com"], /The new project does not list acmenotes\.com after adding it\.$/],
      [["acmenotes.com", "staging.acmenotes.com"], /The new project does not list acmenotes\.com, staging\.acmenotes\.com after adding them\.$/],
    ]) {
      const api = await fakeVercel({ vanish });
      try {
        await assert.rejects(step(api, vercelCopy({ settings: { framework: "nextjs" }, domains, dns: [] })).done, said);
      } finally {
        await api.close();
      }
    }
    for (const [vanish, said] of [
      [[" TXT v=spf1 -all"], /acmenotes\.com does not list acmenotes\.com TXT v=spf1 -all after adding it\.$/],
      [[" TXT v=spf1 -all", " TXT google-site-verification=abc"], /acmenotes\.com does not list acmenotes\.com TXT v=spf1 -all; acmenotes\.com TXT google-site-verification=abc after adding them\.$/],
    ]) {
      const api = await fakeVercel({ vanish });
      try {
        await assert.rejects(step(api, vercelCopy({ settings: { framework: "nextjs" }, domains: [], dns: [{ domain: "acmenotes.com", records, note: null }] })).done, said);
      } finally {
        await api.close();
      }
    }
  });

  it("keeps Vercel Authentication on when the old project had it off, and lists it to turn off by hand instead of calling the settings a match", async () => {
    const settings = { framework: "nextjs", nodeVersion: "22.x", ssoProtection: null };
    const archive = vercelCopy({ settings, domains: [], dns: [] });
    const api = await fakeVercel({ refuseSettings: [] });
    try {
      api.state.project.nodeVersion = "22.x";
      const run = step(api, archive);
      assert.equal(await run.done, "0 settings, 0 domains, 0 DNS records, 1 to do by hand");
      assert.deepEqual(run.todo, [
        "The old project had Vercel Authentication off, so anyone with a link could open its deployments. The new project keeps it on. If the old project was open on purpose, turn it off by hand in the project's settings in Vercel, under Deployment Protection.",
      ]);
      assert.doesNotMatch(run.said.join("\n"), /already match/);
      assert.equal(api.state.requests.filter((request) => request.method === "PATCH").length, 0, "protection is never switched off");
      assert.deepEqual(api.state.project.ssoProtection, { deploymentType: "all_except_custom_domains" });

      // A new project that already has it off matches, and nothing is listed.
      api.state.project.ssoProtection = null;
      const again = step(api, archive);
      assert.equal(await again.done, "0 settings, 0 domains, 0 DNS records");
      assert.deepEqual(again.todo, []);
      assert.match(again.said.join("\n"), /^The new project's settings already match the copy's\.$/m);
    } finally {
      await api.close();
    }
  });

  it("lists the settings and domains to set by hand when the copy was made before the backup copied them", async () => {
    const api = await fakeVercel();
    try {
      const run = step(api, vercelCopy(null));
      assert.equal(await run.done, "no settings in the copy");
      assert.match(run.todo[0], /^This Vercel copy has no project settings or domains: it was made before the backup copied them, or that night's settings copy failed\./);
      assert.equal(api.state.requests.length, 0, "nothing is sent");
    } finally {
      await api.close();
    }
  });

  it("refuses a settings.json that is not as the backup writes it, and stops on a refused token", async () => {
    const api = await fakeVercel();
    try {
      await assert.rejects(step(api, vercelCopy({ settings: {}, domains: [{ redirect: "x" }], dns: [] })).done, /The Vercel copy's settings\.json is not as the backup writes it, so it was not used\./);
      await assert.rejects(step(api, vercelCopy(), { token: "wrong-token" }).done, /Vercel refused the token in LASTGOOD_VERCEL_TOKEN when reading the new project\./);
    } finally {
      await api.close();
    }
  });

  it("sends the settings in one change when Vercel takes them whole, names a deploy hook with no branch, and lists the domains once when none are to be added", async () => {
    const settings = { framework: "nextjs", nodeVersion: "20.x", link: { type: "github", org: "acme", repo: "notes", deployHooks: [{ name: "cms" }, { name: "docs", ref: "main" }] } };
    const archive = vercelCopy({ settings, domains: [{ name: "notes-old.vercel.app", apexName: "vercel.app", verified: true }], dns: [] });
    const api = await fakeVercel({ refuseSettings: [] });
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "1 setting, 0 domains, 0 DNS records, 1 to do by hand");
      const text = run.said.join("\n");
      assert.match(text, /^Project settings set as the old project had them: nodeVersion\.$/m);
      assert.match(text, /Make these deploy hooks again in the project's Git settings: cms, docs \(main\)\. Each gets a new URL/);
      assert.equal(api.state.requests.filter((request) => request.method === "PATCH").length, 1);
      assert.equal(api.state.requests.filter((request) => request.method === "GET" && request.path.endsWith("/domains")).length, 1, "nothing was added, so the list is not read again");
    } finally {
      await api.close();
    }
  });

  it("keeps a domain already on the new project, and points to its settings to prove it when Vercel names no record", async () => {
    const archive = vercelCopy({ settings: { framework: "nextjs" }, domains: [{ name: "acmenotes.com", apexName: "acmenotes.com", verified: true }], dns: [] });
    const api = await fakeVercel();
    api.state.domains.push({ name: "acmenotes.com", apexName: "acmenotes.com", verified: false });
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "0 settings, 1 domain, 0 DNS records, 1 to do by hand");
      const text = run.said.join("\n");
      assert.match(text, /Already on the new project, kept as it is: acmenotes\.com\./);
      assert.match(text, /then verify it in the project's domain settings: acmenotes\.com: see the domain in the project's settings\./);
    } finally {
      await api.close();
    }
  });

  it("sends a record with its value, and lists one the backup kept without its value to add by hand, sending nothing for it", async () => {
    const records = [
      { name: "", type: "TXT", value: "v=spf1 -all" },
      { name: "google._domainkey", type: "TXT" },
    ];
    const archive = vercelCopy({ settings: { framework: "nextjs" }, domains: [], dns: [{ domain: "acmenotes.com", records, note: null }] });
    const api = await fakeVercel();
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "0 settings, 0 domains, 1 DNS record, 1 to do by hand");
      const sent = api.state.requests.filter((request) => request.method === "POST").map((request) => JSON.parse(request.body));
      assert.deepEqual(sent, [{ name: "", type: "TXT", value: "v=spf1 -all" }]);
      assert.deepEqual(run.todo, [
        "The backup kept these DNS records of acmenotes.com without their values, which were too long to keep, so they were not sent to Vercel. Add them by hand if the zone does not have them already: google._domainkey.acmenotes.com TXT.",
      ]);
    } finally {
      await api.close();
    }
  });

  it("names the records it added when the zone can no longer be read after adding them", async () => {
    const archive = vercelCopy({ settings: { framework: "nextjs" }, domains: [], dns: [{ domain: "acmenotes.com", records: [{ name: "", type: "TXT", value: "v=spf1 -all" }], note: null }] });
    const api = await fakeVercel();
    // The zone moves out of this team once the record goes in, so the next look is refused.
    const fetchImpl = async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "POST") delete api.state.zones["acmenotes.com"];
      return response;
    };
    try {
      await assert.rejects(step(api, archive, { fetchImpl }).done, /acmenotes\.com does not list acmenotes\.com TXT v=spf1 -all after adding it\./);
    } finally {
      await api.close();
    }
  });
});

describe("lastgood rebuild: Vercel settings and domains, lost answers", () => {
  it("adds a domain and changes settings once when the answer is lost after Vercel took them, reading each back", async () => {
    const archive = vercelCopy({ settings: { framework: "nextjs", nodeVersion: "20.x" }, domains: [{ name: "acmenotes.com", apexName: "acmenotes.com", verified: true }], dns: [] });
    const api = await fakeVercel({ dropOnce: ["acmenotes.com"], failPatchOnce: true, unverified: [] });
    try {
      const run = step(api, archive);
      assert.equal(await run.done, "1 setting, 1 domain, 0 DNS records");
      const text = run.said.join("\n");
      assert.match(text, /Project settings set as the old project had them: nodeVersion\./);
      assert.match(text, /Added 1 domain to the new project: acmenotes\.com\./);
      const sent = (method, end) => api.state.requests.filter((request) => request.method === method && request.path.endsWith(end)).length;
      assert.equal(sent("PATCH", PROJECT_ID), 1, "the settings are not sent twice");
      assert.equal(sent("POST", "/domains"), 1, "the domain is not sent twice");
      assert.equal(api.state.project.nodeVersion, "20.x");
    } finally {
      await api.close();
    }
  });

  it("gives every call the same time limit", async () => {
    const archive = vercelCopy({ settings: { framework: "nextjs", nodeVersion: "20.x" }, domains: [], dns: [] });
    const api = await fakeVercel();
    try {
      const asked = [];
      const run = step(api, archive, { limit: (bytes) => (asked.push(bytes), 60_000) });
      await run.done;
      assert.equal(asked.length, api.state.requests.length, "one limit for each call");
      assert.ok(asked.every((bytes) => bytes === undefined));
    } finally {
      await api.close();
    }
  });
});
