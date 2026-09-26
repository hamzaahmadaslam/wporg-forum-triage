// Test helpers: small synthetic feeds in the shape WordPress.org uses, and a fetch stand-in that answers for the two
// hosts the tool may contact. Every title, post and user name here is made up.

const RESOLVED = '<span class="resolved" aria-label="Resolved" title="Topic is resolved."></span>';
const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One <item>. With `cdata: false` the title and description are entity-escaped instead of wrapped in CDATA. */
export function item({
  slug,
  title,
  replies = 0,
  resolved = false,
  date = "Fri, 25 Sep 2026 09:14:02 +0000",
  post = '<p class="wp-block-paragraph">A made-up post.</p>',
  cdata = true,
  link,
}) {
  const url = `https://wordpress.org/support/topic/${slug}/`;
  const wrap = (html) => (cdata ? `<![CDATA[${html}]]>` : escapeXml(html));
  const description = replies === null ? post : `\n<p>\n\t\t\t\t\t\t\tReplies: ${replies}\t\t\t\t\t\t</p>\n${post}\n`;
  return [
    "<item>",
    `  <guid>${url}</guid>`,
    `  <title>${wrap(`${resolved ? RESOLVED : ""}${title}`)}</title>`,
    `  <link>${link ?? url}</link>`,
    `  <pubDate>${date}</pubDate>`,
    "  <dc:creator>sample-user</dc:creator>",
    `  <description>${wrap(description)}</description>`,
    "</item>",
  ].join("\n");
}

/** A whole feed around the given items. */
export function feedXml(items, title = "WordPress.org Forums &#187; [Sample Plugin] Support") {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<channel><title>${title}</title>`,
    ...items,
    "</channel></rss>",
  ].join("\n");
}

/** A feed of `count` made-up threads whose slugs start with `prefix`. */
export const pageOf = (prefix, count = 3) =>
  feedXml(Array.from({ length: count }, (_, i) => item({ slug: `${prefix}-${i + 1}`, title: `Made-up thread ${prefix} ${i + 1}` })));

export const xmlResponse = (xml, status = 200) =>
  new Response(xml, { status, headers: { "content-type": "application/rss+xml; charset=UTF-8" } });

/**
 * A fetch stand-in. `feeds` maps a feed address to XML, or to a function returning a Response; any other
 * wordpress.org address gets a 404. `jev(body, n)` answers the nth TypeSafe request with an object or an HTTP
 * status. Any other host fails the test. `calls` records every request.
 */
export function routerFetch({ feeds = {}, jev } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const { hostname } = new URL(url);
    if (hostname === "wordpress.org") {
      const entry = feeds[url];
      if (entry === undefined) return xmlResponse(feedXml([]), 404);
      return typeof entry === "function" ? entry(url, init) : xmlResponse(entry);
    }
    if (hostname === "api.typesafe.ai" && jev) {
      const body = JSON.parse(init.body);
      const out = await jev(body, calls.filter((call) => call.url.startsWith("https://api.typesafe.ai/")).length);
      if (typeof out === "number") return new Response(JSON.stringify({ error: "fixture" }), { status: out });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`A test tried to contact ${hostname}.`);
  };
  return { fetchImpl, calls };
}

/**
 * A TypeSafe response for every question in `body`. `pick(index)` returns { kind, confidence, reply, solved } for
 * the thread at that position in the run.
 */
export function answersFor(body, pick) {
  const answers = {};
  for (const key of Object.keys(body.questions)) {
    const [, index, question] = /^t(\d+)_(kind|reply|solved)$/.exec(key);
    const a = pick(Number(index));
    answers[key] =
      question === "kind"
        ? { type: "choice", choice: a.kind, confidence: a.confidence, probabilities: { [a.kind]: a.confidence } }
        : { type: "noul", noul: a[question] };
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 1000, output_tokens: 0 } };
}
