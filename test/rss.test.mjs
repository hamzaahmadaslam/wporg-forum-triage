import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { UserError } from "../src/errors.mjs";
import { hasResolvedMarker, htmlToText, parseFeed, tidy } from "../src/rss.mjs";
import { feedXml, item } from "./fixtures/feeds.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

const EXAMPLE = readFileSync(new URL("../examples/feed.xml", import.meta.url), "utf8");

test("parses the example feed: titles, addresses, dates, reply counts, resolved markers and first posts", () => {
  const feed = parseFeed(EXAMPLE);
  assert.equal(feed.title, "WordPress.org Forums \u00bb [Tidy Backups Demo] Support");
  assert.equal(feed.threads.length, 12);
  assert.deepEqual(feed.threads[0], {
    title: "Fatal error after updating to 2.4.0",
    url: "https://wordpress.org/support/topic/tidy-backups-demo-fatal-error-after-updating-to-2-4-0/",
    created: "2026-09-25T09:14:02.000Z",
    replies: 0,
    resolved: false,
    post:
      "After updating to 2.4.0 the dashboard shows \u201cThere has been a critical error on this website.\u201d The debug log says:\n\n" +
      "PHP Fatal error: Uncaught TypeError: count(): Argument #1 ($value) must be of type Countable|array, null given in " +
      "/wp-content/plugins/tidy-backups-demo/includes/class-schedule.php:88\n\n" +
      "Going back to 2.3.2 fixes it. WordPress 6.9, PHP 8.3.",
  });
  assert.deepEqual(
    feed.threads.map((thread) => thread.replies),
    [0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 3, 2],
  );
  assert.deepEqual(
    feed.threads.filter((thread) => thread.resolved).map((thread) => thread.title),
    ["Restore stops at 80 percent", "Option to keep only the last five backups"],
  );
  assert.equal(
    feed.threads[4].post,
    "The daily backup at 02:00 did not run last night, and there is nothing in the backup log. Clicking \u201cBack up now\u201d " +
      "still works. What I checked:\n\n- WP-Cron is enabled\n- The schedule still shows 02:00",
  );
  assert.equal(feed.threads[5].post.split("\n\n")[1], "Edit: found them under Settings > Storage. Never mind!");
  assert.equal(feed.threads[8].post, "My uploads folder is 12 GB and my host already backs it up.\nHow can I leave it out of the backup?");
  // A copy with Windows line endings (a checkout with core.autocrlf) reads the same.
  assert.deepEqual(parseFeed(EXAMPLE.replace(/\r?\n/g, "\r\n")), feed);
});

test("entity-escaped descriptions read the same as CDATA ones", () => {
  const parts = {
    slug: "sample-plugin-escaped",
    title: "Quotes &#8220;here&#8221; &amp; an <em>emphasis</em>",
    replies: 4,
    resolved: true,
    post: '<p class="wp-block-paragraph">Line one<br />line two with &lt;code&gt; as text</p><ol><li>first</li><li>second</li></ol>',
  };
  const withCdata = parseFeed(feedXml([item({ ...parts, cdata: true })])).threads;
  const escaped = parseFeed(feedXml([item({ ...parts, cdata: false })])).threads;
  assert.deepEqual(escaped, withCdata);
  assert.equal(withCdata[0].title, "Quotes \u201chere\u201d & an emphasis");
  assert.equal(withCdata[0].post, "Line one\nline two with <code> as text\n\n- first\n- second");
  assert.equal(withCdata[0].replies, 4);
  assert.equal(withCdata[0].resolved, true);
});

test("htmlToText keeps paragraphs, breaks, lists and code lines, and drops scripts, comments and markup", () => {
  const html = [
    '<p class="wp-block-paragraph">First   paragraph\nspread over\nsource lines.</p>',
    "<!-- a comment --><script>alert('x')</script><style>p { color: red }</style>",
    '<pre class="wp-block-code"><code>line 1\n  line 2 &amp; more</code></pre>',
    '<ul><li>one</li>\n\n<li>two <a href="https://example.com/">link text</a></li></ul>',
    '<p>Screenshot: <img src="https://example.com/a.png" alt="a" /> done&hellip; 5 &gt; 3 &#x263A;</p>',
    "<table><tr><td>a</td><td>b</td></tr></table>",
  ].join("");
  assert.equal(
    htmlToText(html),
    "First paragraph spread over source lines.\n\nline 1\nline 2 & more\n\n- one\n- two link text\n\n" +
      "Screenshot: [image] done\u2026 5 > 3 \u263a\n\na b",
  );
});

test("unsafe characters are removed, and addresses outside wordpress.org are dropped", () => {
  assert.equal(tidy("red\u001b[31m text\u202e and\u0007 bell\r\nnext"), "red[31m text and bell\nnext");
  const threads = parseFeed(
    feedXml([
      item({ slug: "sample-plugin-safe", title: "Title with \u001b[2J escape" }),
      item({ slug: "sample-plugin-offsite", title: "Off-site link", link: "https://example.com/phish" }),
    ]),
  ).threads;
  assert.equal(threads[0].title, "Title with [2J escape");
  // The <link> points elsewhere, so the <guid> (on wordpress.org) is used instead.
  assert.equal(threads[1].url, "https://wordpress.org/support/topic/sample-plugin-offsite/");
  const noAddress = parseFeed(
    feedXml(["<item><guid>https://wordpress.org.example.com/x/</guid><link>javascript:alert(1)</link><title>t</title></item>"]),
  ).threads;
  assert.equal(noAddress[0].url, null);
  assert.equal(hasResolvedMarker('<span class="unresolved"></span>'), false);
  assert.equal(hasResolvedMarker("<span class='sticky resolved'></span>"), true);
});

test("a missing reply count is null, an empty feed has no threads, and a page that is not RSS is a plain error", () => {
  const [thread] = parseFeed(feedXml([item({ slug: "sample-plugin-no-count", title: "No count", replies: null, date: "not a date" })]))
    .threads;
  assert.equal(thread.replies, null);
  assert.equal(thread.created, null);
  assert.equal(thread.post, "A made-up post.");
  assert.deepEqual(parseFeed(feedXml([])).threads, []);
  for (const page of ["<!DOCTYPE html><html><body>Checking your browser</body></html>", "", "{}"]) {
    assert.throws(() => parseFeed(page), (error) => error instanceof UserError && /is not an RSS feed/.test(error.message));
  }
});
