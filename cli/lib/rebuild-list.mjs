/**
 * Which parts of a backup's database dump go into a new Supabase project (R4). Unlike the monthly test restore, which
 * loads into a throwaway database it may clear first, this restores into the customer's real new project, so it never
 * drops anything. Supabase made that project's own schemas (auth, storage, realtime and the rest) and keeps them up to
 * date, so their tables, functions and types stay as Supabase made them. What comes across into them is only the app's
 * part: its users and their sign-in identities, its storage buckets, and the triggers and policies the app added to
 * Supabase's tables. Everything in the app's own schemas comes across as it was dumped.
 */

/** Schemas a new Supabase project has, or that Supabase's extensions make. The app's rows in them are left out. */
export const SUPABASE_SCHEMAS = [
  "auth",
  "storage",
  "realtime",
  "_realtime",
  "supabase_functions",
  "supabase_migrations",
  "extensions",
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "pgbouncer",
  "_analytics",
  "pgtle",
  "pgmq",
  "wrappers",
  "information_schema",
  "pg_catalog",
  "pg_toast",
];

/** The rows from Supabase's schemas that belong to the app: who can sign in, and its buckets. */
export const KEPT_ROWS = new Set(["auth.users", "auth.identities", "storage.buckets"]);

/** Event triggers a Supabase project makes for itself. Any other is the app's, and is listed, since only a superuser can make one. */
const SUPABASE_EVENT_TRIGGERS = new Set([
  "issue_pg_graphql_access",
  "issue_graphql_placeholder",
  "pgrst_ddl_watch",
  "pgrst_drop_watch",
  "issue_pg_cron_access",
  "issue_pg_net_access",
]);

/** The storage login's policies (lib/supabase/storage-login.ts). They let LastGood's old login read files, so they stay behind. */
export const STORAGE_LOGIN_POLICY_PREFIX = "lastgood_backup_";

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
  "DEFAULT",
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

/**
 * One line of `pg_restore --list`: `id; tableoid oid DESC NAMESPACE NAME... OWNER`. The owner is empty for some
 * entries, such as an extension's comment, so the line keeps its trailing space and the last word is read as the
 * owner only when there is one. `words` are the name's parts: a trigger or policy names its table first.
 */
export function tocEntry(line) {
  const match = /^(\d+); \d+ \d+ (.*)$/.exec(String(line).replace(/\r$/, ""));
  if (!match) return null;
  const rest = match[2];
  const desc = DESCRIPTIONS.find((candidate) => rest === candidate || rest.startsWith(`${candidate} `));
  if (!desc) return null;
  const parts = rest.slice(desc.length + 1).split(" ");
  if (parts.length < 2) return null;
  const namespace = parts[0];
  // The owner is the last word; an empty one leaves a trailing "".
  const words = parts.slice(1, -1);
  if (words.length === 0) return null;
  return { id: match[1], desc, namespace, words, name: words.join(" "), owner: parts[parts.length - 1] };
}

/** `schema.table` for an entry that belongs to a table, else null. */
function tableOf(entry) {
  if (["TABLE", "TABLE DATA", "TRIGGER", "POLICY", "ROW SECURITY", "CONSTRAINT", "FK CONSTRAINT", "INDEX", "DEFAULT"].includes(entry.desc)) {
    return `${entry.namespace}.${entry.words[0]}`;
  }
  return null;
}

/**
 * The pg_restore -L list for a new project, and what it left out, so the steps can say so.
 * `target` describes the new project: `schemas` it has, extensions `installed` and `available`.
 */
export function rebuildRestoreList(toc, target = {}) {
  const existing = new Set((target.schemas ?? []).filter((name) => name !== "public"));
  const supabase = new Set([...SUPABASE_SCHEMAS, ...existing]);
  const installed = new Set(target.installed ?? []);
  const available = new Set(target.available ?? []);
  const result = {
    kept: [],
    supabaseRows: [],
    unavailableExtensions: [],
    eventTriggers: [],
    storageLoginPolicies: [],
    leftOut: [],
  };
  const rows = [];
  const lines = String(toc).split("\n").map((line) => {
    const entry = tocEntry(line);
    if (!entry) return line;
    const keep = decide(entry);
    if (keep) result.kept.push(entry);
    if (keep && entry.desc === "TABLE DATA" && KEPT_ROWS.has(tableOf(entry))) rows.push({ line, table: tableOf(entry) });
    return keep ? line : `;${line}`;
  });
  // A new project already has Supabase's foreign keys, such as auth.identities to auth.users, so these rows must load
  // in that order. pg_restore -L restores in the list's order: they go together, in KEPT_ROWS order, where the first was.
  if (rows.length > 1) {
    const order = [...KEPT_ROWS];
    rows.sort((left, right) => order.indexOf(left.table) - order.indexOf(right.table));
    const first = lines.findIndex((line) => rows.some((row) => row.line === line));
    const rest = lines.filter((line) => !rows.some((row) => row.line === line));
    rest.splice(first, 0, ...rows.map((row) => row.line));
    lines.splice(0, lines.length, ...rest);
  }

  function decide(entry) {
    const { desc, namespace } = entry;
    if (namespace === "-") {
      if (desc === "EXTENSION") {
        if (installed.has(entry.name)) return false;
        if (!available.has(entry.name)) {
          result.unavailableExtensions.push(entry.name);
          return false;
        }
        return true;
      }
      if (desc === "SCHEMA") return !supabase.has(entry.name) && entry.name !== "public";
      if (desc === "EVENT TRIGGER") {
        if (!SUPABASE_EVENT_TRIGGERS.has(entry.name)) result.eventTriggers.push(entry.name);
        return false;
      }
      // A new project has its own realtime publication; the app's tables join it through PUBLICATION TABLE.
      if (desc === "PUBLICATION") return entry.name !== "supabase_realtime";
      // The app's own schemas keep their comments. Comments on extensions and Supabase's schemas need an owner that a
      // project's postgres role is not, and Supabase wrote them anyway.
      if (desc === "COMMENT") return entry.words[0] === "SCHEMA" && !supabase.has(entry.words[1]) && entry.words[1] !== "public";
      result.leftOut.push(`${desc.toLowerCase()} ${entry.name}`);
      return false;
    }
    if (!supabase.has(namespace)) return true;
    const table = tableOf(entry);
    if (desc === "TABLE DATA") {
      if (KEPT_ROWS.has(table)) return true;
      result.supabaseRows.push(table);
      return false;
    }
    // The app's own triggers and policies on Supabase's tables, such as a sign-up trigger on auth.users or who may
    // read a bucket. Supabase's own are already there in a new project, and pg_restore says so.
    if (desc === "TRIGGER") return true;
    if (desc === "POLICY") {
      if (entry.words[1]?.startsWith(STORAGE_LOGIN_POLICY_PREFIX)) {
        result.storageLoginPolicies.push(entry.words.slice(1).join(" "));
        return false;
      }
      return true;
    }
    return false;
  }

  return { text: lines.join("\n"), ...result };
}

/**
 * Sorts pg_restore's errors by the entry each came from: with --verbose it names each object before making it
 * (`creating TRIGGER "storage.objects update_objects_updated_at"`), and some versions also print `from TOC entry`.
 * "Already exists" on a trigger, policy, publication or schema means the new project had made it already, and is fine.
 * An error on rows is a failure. Anything else is an object that did not come across, named so the customer can add it.
 */
export function sortRestoreErrors(stderr) {
  const failed = [];
  const notRestored = [];
  let already = 0;
  let current = null;
  for (const raw of String(stderr).split("\n")) {
    const line = raw.trim();
    const from = /^pg_restore: from TOC entry \d+; \d+ \d+ (.*)$/.exec(line);
    if (from) {
      current = tocEntry(`0; 0 0 ${from[1]}`);
      continue;
    }
    const creating = /^pg_restore: creating (.+?) "(.*)"$/.exec(line);
    if (creating) {
      current = { desc: creating[1], namespace: "-", name: creating[2] };
      continue;
    }
    const data = /^pg_restore: processing data for table "(.*)"$/.exec(line);
    if (data) {
      current = { desc: "TABLE DATA", namespace: "-", name: data[1] };
      continue;
    }
    const error = /^pg_restore: error: (.*)$/.exec(line);
    if (!error) continue;
    const message = error[1].replace(/^could not execute query: /, "").replace(/^ERROR:\s+/, "");
    if (current && /already exists|is already member of publication/i.test(message) && ["TRIGGER", "POLICY", "PUBLICATION", "PUBLICATION TABLE", "SCHEMA"].includes(current.desc)) {
      already += 1;
    } else if (!current || current.desc === "TABLE DATA" || /COPY failed|duplicate key|violates|invalid input syntax|could not connect|connection to server/i.test(message)) {
      failed.push(describe(current, message));
    } else {
      notRestored.push(describe(current, message));
    }
  }
  return { failed, notRestored, already };
}

function describe(entry, message) {
  // pg_restore names a COPY's table in the message itself, without a TOC line before it.
  if (!entry) return clean(message);
  return `${entry.desc.toLowerCase()} ${entry.namespace === "-" ? "" : `${entry.namespace}.`}${entry.name}: ${clean(message)}`;
}

/** One line of a message, with any connection string, password or Supabase key taken out. */
export function clean(text) {
  return String(text)
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgresql://…")
    .replace(/password=\S+/gi, "password=…")
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "sb_$1_…")
    .replace(/sbp_[A-Za-z0-9_-]+/g, "sbp_…")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
