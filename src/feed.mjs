// Reads a plugin's public support feed from WordPress.org: one GET per page, a pause between pages, a time limit,
// a size limit and a User-Agent that names the tool. Redirects are followed only within https://wordpress.org, so
// no other host is ever contacted. Nothing is sent but the request itself: no cookies, no key.
import { readFileSync } from "node:fs";
import { UserError } from "./errors.mjs";
import { parseFeed } from "./rss.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const USER_AGENT = `wporg-forum-triage/${VERSION} (+https://github.com/hamzaahmadaslam/wporg-forum-triage)`;
export const FEED_ORIGIN = "https://wordpress.org";
export const MAX_PAGES = 10;
export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const PAGE_DELAY_MS = 2_000;
export const DEFAULT_FEED_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => `${ms / 1000} second${ms === 1000 ? "" : "s"}`;

/** Returns the slug when it is a valid WordPress.org plugin slug; throws a UserError otherwise. */
export function checkSlug(slug) {
  if (typeof slug === "string" && SLUG.test(slug)) return slug;
  const shown = JSON.stringify(String(slug).slice(0, 80));
  const lower = String(slug).toLowerCase();
  const hint = SLUG.test(lower)
    ? `Slugs are lowercase: try ${lower}.`
    : "The slug is the part after /plugins/ in the plugin's WordPress.org address, such as hello-dolly.";
  throw new UserError(`${shown} is not a plugin slug: use lowercase letters, digits and hyphens. ${hint}`);
}

/** The feed address for a page: the newest topics, or with `unresolved` the forum's unresolved topics. */
export function feedUrl(slug, { unresolved = false, page = 1 } = {}) {
  const base = `${FEED_ORIGIN}/support/plugin/${checkSlug(slug)}/${unresolved ? "unresolved/" : ""}feed/`;
  return page > 1 ? `${base}?paged=${page}` : base;
}

function reason(error, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `no complete answer within ${seconds(timeoutMs)}`;
  const code = error?.cause?.code;
  return `${error?.message ?? error}${code ? ` (${code})` : ""}`;
}

const discard = (res) => res.body?.cancel().catch(() => {});
const tooLarge = (url) => new UserError(`The feed at ${url} is larger than ${MAX_FEED_BYTES / 1024 / 1024} MB, so it was not read.`);

async function readCapped(res, url, timeoutMs) {
  if (Number(res.headers.get("content-length")) > MAX_FEED_BYTES) {
    await discard(res);
    throw tooLarge(url);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge(url);
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(`Could not read ${url}: ${reason(error, timeoutMs)}.`);
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * GETs one feed page and returns { url, xml }. The time limit covers the whole page, redirects and body included.
 * Every failure is a UserError with a plain message.
 */
export async function fetchFeedPage(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_FEED_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hops = 0; ; hops++) {
    let res;
    try {
      res = await fetchImpl(current, {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8" },
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw new UserError(`Could not read ${current}: ${reason(error, timeoutMs)}.`);
    }
    if (res.status >= 300 && res.status < 400) {
      await discard(res);
      const location = res.headers.get("location");
      let next = null;
      try {
        next = location ? new URL(location, current) : null;
      } catch {
        next = null;
      }
      if (!next || next.origin !== FEED_ORIGIN || hops >= MAX_REDIRECTS) {
        const target = location ? JSON.stringify(location.slice(0, 120)) : "no address";
        throw new UserError(`WordPress.org redirected ${current} to ${target}. The tool follows redirects only within ${FEED_ORIGIN}.`);
      }
      current = next.href;
      continue;
    }
    if (!res.ok) {
      await discard(res);
      if (res.status === 404) {
        throw new UserError(
          `WordPress.org has no support feed at ${current} (HTTP 404). Check the plugin slug: it is the part after /plugins/ in the plugin's WordPress.org address.`,
        );
      }
      if (res.status === 429) throw new UserError("WordPress.org asked for fewer requests (HTTP 429). Wait a few minutes and try again.");
      throw new UserError(`WordPress.org answered HTTP ${res.status} for ${current}. Try again later.`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/xml/i.test(type)) {
      await discard(res);
      throw new UserError(`WordPress.org did not send a feed for ${current} (content type "${type.slice(0, 60) || "none"}").`);
    }
    return { url: current, xml: await readCapped(res, current, timeoutMs) };
  }
}

/**
 * Reads up to `pages` feed pages, one request at a time with PAGE_DELAY_MS between them, and returns
 * { threads, pages: [{ page, url, items, added }], stoppedAfter }. Threads already seen on an earlier page are
 * dropped. A page that adds no thread ends the run early (`stoppedAfter` is its number), so a forum that repeats
 * its first page is asked at most twice.
 */
export async function readForum(slug, options = {}) {
  const {
    pages = 1,
    unresolved = false,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_FEED_TIMEOUT_MS,
    sleep = wait,
    onPage,
  } = options;
  checkSlug(slug);
  const threads = [];
  const seen = new Set();
  const read = [];
  let stoppedAfter = null;
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const { url, xml } = await fetchFeedPage(feedUrl(slug, { unresolved, page }), { fetchImpl, timeoutMs });
    const feed = parseFeed(xml);
    let added = 0;
    for (const thread of feed.threads) {
      const key = thread.url ?? `${thread.title}\n${thread.created}`;
      if (seen.has(key)) continue;
      seen.add(key);
      threads.push({ ...thread, page });
      added++;
    }
    read.push({ page, url, items: feed.threads.length, added });
    onPage?.(page, pages);
    if (added === 0 && page < pages) {
      stoppedAfter = page;
      break;
    }
  }
  return { threads, pages: read, stoppedAfter };
}
