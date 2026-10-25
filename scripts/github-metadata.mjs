// Issues and pull requests with their comments, read with the workflow's own token, as JSON files in one folder.
// Only GET requests. The token goes in a header and is never printed.
// Usage: node github-metadata.mjs <folder>. Prints "<issues> <pull requests> <comments>" on success.
// node github-metadata.mjs --count <folder> reads a folder this script wrote back, as the test restore does, and prints the same counts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PER_PAGE = 100;
/** 100,000 items per list. A repository with more stops the copy instead of saving part of it. */
const MAX_PAGES = 1000;
const ATTEMPTS = 3;

/** What goes in the folder. Issues include pull requests, as GitHub lists them; pulls.json adds branch details. */
export const LISTS = [
  { file: "issues.json", path: "issues", query: { state: "all", sort: "created", direction: "asc" }, issues: true },
  { file: "issue-comments.json", path: "issues/comments", query: { sort: "created", direction: "asc" }, issues: true },
  { file: "pulls.json", path: "pulls", query: { state: "all", sort: "created", direction: "asc" } },
  { file: "review-comments.json", path: "pulls/comments", query: { sort: "created", direction: "asc" } },
];

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class MetadataError extends Error {}

/** The next page from a Link header, or null on the last page. */
export function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

function explain(status, body, what) {
  const message = typeof body?.message === "string" ? body.message : "";
  if (status === 401) return "GitHub did not accept the workflow's token.";
  if (status === 403 && /rate limit/i.test(message)) {
    return `GitHub's rate limit stopped the copy of ${what}. The next run tries again.`;
  }
  if (status === 403 || status === 404) {
    return `The workflow's token cannot read ${what}. Add issues: read and pull-requests: read under permissions in .github/workflows/lifeboat.yml.`;
  }
  return `GitHub answered ${status} when reading ${what}.`;
}

async function getJson(url, { token, fetchImpl, sleep, what }) {
  let last = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "LastGood-lifeboat/0.1 (+https://lastgood.app)",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      last = `GitHub could not be reached when reading ${what}.`;
      if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (response.ok) return { body: await response.json(), next: nextLink(response.headers.get("link")) };
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    // Issues switched off in the repository's settings: there are none to copy.
    if (response.status === 410) return { body: [], next: null, gone: true };
    last = explain(response.status, body, what);
    if (response.status < 500 && response.status !== 429) break;
    if (attempt < ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
  }
  throw new MetadataError(last ?? `GitHub did not answer when reading ${what}.`);
}

async function readList(base, list, deps) {
  const query = new URLSearchParams({ ...list.query, per_page: String(PER_PAGE) });
  let url = `${base}/${list.path}?${query}`;
  const items = [];
  let gone = false;
  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) {
      throw new MetadataError(`${list.file} has more than ${MAX_PAGES * PER_PAGE} entries, which this copy does not take.`);
    }
    const result = await getJson(url, { ...deps, what: list.path });
    if (!Array.isArray(result.body)) throw new MetadataError(`GitHub sent something other than a list for ${list.path}.`);
    items.push(...result.body);
    gone = gone || Boolean(result.gone);
    url = result.next;
  }
  return { items, gone };
}

/**
 * Writes repository.json and one JSON file per list into `dir`. Returns the counts for the run's report:
 * issues (pull requests left out), pull requests, and comments on both, including review comments.
 */
export async function exportMetadata({ api, repository, token, dir, fetchImpl = fetch, sleep = defaultSleep, note = () => {} }) {
  if (!REPOSITORY.test(repository ?? "")) throw new MetadataError("GITHUB_REPOSITORY is not owner/repo.");
  if (!token) throw new MetadataError("Set github-token, so the workflow can read issues and pull requests.");
  const base = `${(api || "https://api.github.com").replace(/\/+$/, "")}/repos/${repository}`;
  const deps = { token, fetchImpl, sleep };
  mkdirSync(dir, { recursive: true });
  const repo = await getJson(base, { ...deps, what: "the repository" });
  writeFileSync(path.join(dir, "repository.json"), JSON.stringify(repo.body));
  const counts = { issues: 0, pullRequests: 0, comments: 0 };
  for (const list of LISTS) {
    const { items, gone } = await readList(base, list, deps);
    if (gone && list.issues) note(`Issues are switched off for ${repository}, so ${list.file} is empty.`);
    writeFileSync(path.join(dir, list.file), JSON.stringify(items));
    if (list.file === "issues.json") counts.issues = items.filter((item) => !item?.pull_request).length;
    if (list.file === "pulls.json") counts.pullRequests = items.length;
    if (list.file.endsWith("comments.json")) counts.comments += items.length;
  }
  return counts;
}

/** The counts for a folder `exportMetadata` wrote, read back the way a restore reads them. Throws if any file is missing or damaged. */
export function countMetadata(dir) {
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch {
      throw new MetadataError(`${file} in the code copy did not read back.`);
    }
  };
  const repository = read("repository.json");
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) throw new MetadataError("repository.json in the code copy is not a repository.");
  const lists = {};
  for (const list of LISTS) {
    const items = read(list.file);
    if (!Array.isArray(items)) throw new MetadataError(`${list.file} in the code copy is not a list.`);
    lists[list.file] = items;
  }
  return {
    issues: lists["issues.json"].filter((item) => !item?.pull_request).length,
    pullRequests: lists["pulls.json"].length,
    comments: lists["issue-comments.json"].length + lists["review-comments.json"].length,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const counting = process.argv[2] === "--count";
  const dir = counting ? process.argv[3] : process.argv[2];
  try {
    if (!dir) throw new MetadataError("Usage: github-metadata.mjs [--count] <folder>");
    const counts = counting
      ? countMetadata(dir)
      : await exportMetadata({
          api: process.env.GITHUB_API_URL,
          repository: process.env.GITHUB_REPOSITORY,
          token: process.env.GITHUB_TOKEN?.trim(),
          dir,
          note: (line) => console.error(line),
        });
    process.stdout.write(`${counts.issues} ${counts.pullRequests} ${counts.comments}\n`);
  } catch (error) {
    console.error(error instanceof MetadataError ? error.message : "The GitHub metadata copy failed.");
    process.exit(1);
  }
}
