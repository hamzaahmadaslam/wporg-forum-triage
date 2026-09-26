import assert from "node:assert/strict";
import test from "node:test";
import { UserError } from "../src/errors.mjs";
import { checkSlug, feedUrl, fetchFeedPage, MAX_FEED_BYTES, PAGE_DELAY_MS, readForum } from "../src/feed.mjs";
import { pageOf, routerFetch, xmlResponse } from "./fixtures/feeds.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

const FEED = "https://wordpress.org/support/plugin/sample-plugin/feed/";
const userError = (pattern) => (error) => error instanceof UserError && pattern.test(error.message);

test("slugs are lowercase letters, digits and hyphens; anything else is a plain error", () => {
  for (const slug of ["hello-dolly", "404-to-301", "a", "wp-super-cache2"]) assert.equal(checkSlug(slug), slug);
  const cases = [
    ["Hello-Dolly", /^"Hello-Dolly" is not a plugin slug: .* Slugs are lowercase: try hello-dolly\.$/],
    ["hello_dolly", /is not a plugin slug/],
    ["-leading", /is not a plugin slug/],
    ["trailing-", /is not a plugin slug/],
    ["../../etc", /is not a plugin slug/],
    ["hello dolly", /is not a plugin slug/],
    ["", /^"" is not a plugin slug/],
    ["https://wordpress.org/plugins/hello-dolly/", /the part after \/plugins\//],
    ["a".repeat(201), /is not a plugin slug/],
  ];
  for (const [slug, pattern] of cases) assert.throws(() => checkSlug(slug), userError(pattern), slug);
});

test("feed addresses: the newest or the unresolved topics, and later pages", () => {
  assert.equal(feedUrl("sample-plugin"), FEED);
  assert.equal(feedUrl("sample-plugin", { page: 3 }), `${FEED}?paged=3`);
  assert.equal(feedUrl("sample-plugin", { unresolved: true }), "https://wordpress.org/support/plugin/sample-plugin/unresolved/feed/");
  assert.equal(
    feedUrl("sample-plugin", { unresolved: true, page: 2 }),
    "https://wordpress.org/support/plugin/sample-plugin/unresolved/feed/?paged=2",
  );
  assert.throws(() => feedUrl("Sample/../x"), UserError);
});

test("one GET per page, with a User-Agent that names the tool and a pause between pages", async () => {
  const { fetchImpl, calls } = routerFetch({
    feeds: { [FEED]: pageOf("first"), [`${FEED}?paged=2`]: pageOf("second"), [`${FEED}?paged=3`]: pageOf("third", 2) },
  });
  const pauses = [];
  const forum = await readForum("sample-plugin", { pages: 3, fetchImpl, sleep: async (ms) => pauses.push(ms) });
  assert.deepEqual(
    calls.map((call) => call.url),
    [FEED, `${FEED}?paged=2`, `${FEED}?paged=3`],
  );
  for (const { init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.match(init.headers["user-agent"], /^wporg-forum-triage\/1\.0\.0 \(\+https:\/\/github\.com\/hamzaahmadaslam\/wporg-forum-triage\)$/);
    assert.equal(init.body, undefined);
    assert.equal(init.headers.authorization, undefined);
  }
  assert.deepEqual(pauses, [PAGE_DELAY_MS, PAGE_DELAY_MS], "a pause before each page after the first");
  assert.equal(PAGE_DELAY_MS, 2000);
  assert.equal(forum.threads.length, 8);
  assert.deepEqual(
    forum.pages.map(({ page, items, added }) => [page, items, added]),
    [
      [1, 3, 3],
      [2, 3, 3],
      [3, 2, 2],
    ],
  );
  assert.deepEqual([...new Set(forum.threads.map((thread) => thread.page))], [1, 2, 3]);
  assert.equal(forum.stoppedAfter, null);
});

test("a page that repeats the threads already read ends the run, as WordPress.org's feeds do today", async () => {
  const same = pageOf("same");
  const repeating = routerFetch({ feeds: { [FEED]: same, [`${FEED}?paged=2`]: same } });
  const forum = await readForum("sample-plugin", { pages: 10, fetchImpl: repeating.fetchImpl, sleep: async () => {} });
  assert.equal(repeating.calls.length, 2, "page 2 brought nothing new, so pages 3 to 10 were not requested");
  assert.equal(forum.stoppedAfter, 2);
  assert.equal(forum.threads.length, 3);
  assert.deepEqual(forum.pages.at(-1), { page: 2, url: `${FEED}?paged=2`, items: 3, added: 0 });

  const empty = routerFetch({ feeds: { [FEED]: pageOf("none", 0) } });
  const none = await readForum("sample-plugin", { pages: 5, fetchImpl: empty.fetchImpl, sleep: async () => {} });
  assert.equal(empty.calls.length, 1);
  assert.equal(none.stoppedAfter, 1);
  assert.deepEqual(none.threads, []);
});

test("HTTP errors, other content, oversized feeds, timeouts and redirects off wordpress.org are plain errors", async () => {
  const page = (respond) => fetchFeedPage(FEED, { fetchImpl: async (url, init) => respond(url, init), timeoutMs: 200 });
  await assert.rejects(page(() => xmlResponse("<rss><channel></channel></rss>", 404)), userError(/no support feed at .* \(HTTP 404\)\. Check the plugin slug/));
  await assert.rejects(page(() => xmlResponse("", 503)), userError(/^WordPress\.org answered HTTP 503 for /));
  await assert.rejects(page(() => xmlResponse("", 429)), userError(/asked for fewer requests \(HTTP 429\)/));
  await assert.rejects(
    page(() => new Response("<html></html>", { headers: { "content-type": "text/html; charset=UTF-8" } })),
    userError(/did not send a feed .* \(content type "text\/html; charset=UTF-8"\)/),
  );
  await assert.rejects(
    page(() => new Response("<rss/>", { headers: { "content-type": "application/rss+xml", "content-length": String(MAX_FEED_BYTES + 1) } })),
    userError(/is larger than 2 MB, so it was not read/),
  );
  // Without a content-length, the body is counted while it arrives and the read stops past the limit.
  const chunk = new Uint8Array(512 * 1024).fill(32);
  let sent = 0;
  const endless = new ReadableStream({
    pull(controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  await assert.rejects(page(() => new Response(endless, { headers: { "content-type": "application/rss+xml" } })), userError(/larger than 2 MB/));
  assert.ok(sent <= MAX_FEED_BYTES + 2 * chunk.byteLength, "reading stopped soon after the limit");

  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(xmlResponse(pageOf("late"))), 5_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  await assert.rejects(page(hanging), userError(/^Could not read .*: no complete answer within 0\.2 seconds\.$/));

  const offsite = routerFetch({
    feeds: { [FEED]: () => new Response(null, { status: 302, headers: { location: "https://example.com/feed/" } }) },
  });
  await assert.rejects(
    fetchFeedPage(FEED, { fetchImpl: offsite.fetchImpl }),
    userError(/redirected .* to "https:\/\/example\.com\/feed\/"\. The tool follows redirects only within https:\/\/wordpress\.org\.$/),
  );
  assert.equal(offsite.calls.length, 1, "the other host was never contacted");

  const onsite = routerFetch({
    feeds: {
      [`${FEED}?paged=2`]: () => new Response(null, { status: 301, headers: { location: "/support/plugin/sample-plugin/feed/" } }),
      [FEED]: pageOf("moved"),
    },
  });
  const moved = await fetchFeedPage(`${FEED}?paged=2`, { fetchImpl: onsite.fetchImpl });
  assert.equal(moved.url, FEED);
  assert.deepEqual(
    onsite.calls.map((call) => call.url),
    [`${FEED}?paged=2`, FEED],
  );
});
