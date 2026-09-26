// Reads the RSS feed WordPress.org serves for a plugin's support forum, with plain string handling and no XML
// library. Each <item> is one topic: its title (with a "resolved" marker when the topic is resolved), the topic's
// address, the date it was opened, and a description that holds "Replies: N" and the first post as HTML.
// User names (<dc:creator>) are not read.
import { UserError } from "./errors.mjs";

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  times: "\u00d7",
  bull: "\u2022",
  middot: "\u00b7",
  deg: "\u00b0",
  euro: "\u20ac",
};

/** Decodes numeric entities and the common named ones. Unknown names are left as they are. */
export function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : match;
  });
}

// Control characters (tab and newline kept) and bidirectional overrides. Forum text is written by anyone, and these
// could rewrite what a terminal shows.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Removes unsafe characters, collapses spaces, trims every line and keeps at most one blank line in a row. */
export function tidy(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The same text on one line. */
export const oneLine = (text) => tidy(text).replace(/\s+/g, " ");

const BLOCK = "p|div|ul|ol|pre|blockquote|h[1-6]|figure|figcaption|table|tr|section|article|header|footer|details|summary|hr";
const BLOCK_TAG = new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi");

/**
 * Turns post HTML into plain text: paragraphs and line breaks kept, list items marked, every tag removed. As in a
 * browser, line breaks in the HTML source are only spaces, except inside <pre>, whose lines are kept.
 */
export function htmlToText(html) {
  const pre = [];
  const text = html
    .replace(/\u0000/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, body) => {
      const lines = body.replace(/<br\b[^>]*>/gi, "\n").replace(/<\/?[a-zA-Z][^>]*>/g, "");
      return `\u0000${pre.push(lines) - 1}\u0000`;
    })
    .replace(/\s+/g, " ")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<img\b[^>]*>/gi, " [image] ")
    .replace(BLOCK_TAG, "\n\n")
    .replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_, index) => `\n\n${pre[Number(index)]}\n\n`);
  return tidy(decodeEntities(text));
}

/** True when the title HTML carries the forum's resolved marker, a <span class="resolved">. */
export function hasResolvedMarker(html) {
  for (const match of html.matchAll(/<span\b[^>]*?\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if ((match[1] ?? match[2]).split(/\s+/).includes("resolved")) return true;
  }
  return false;
}

/** Splits the leading "Replies: N" paragraph from the description. `replies` is null when there is none. */
export function splitReplies(html) {
  const match = /^\s*<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(html);
  const count = match && /^Replies:\s*(\d{1,7})$/i.exec(oneLine(htmlToText(match[1])));
  return count ? { replies: Number(count[1]), html: html.slice(match[0].length) } : { replies: null, html };
}

// CDATA sections are swapped for placeholders first, so a "</item>" or "<title>" inside a post cannot confuse the
// element search. XML forbids NUL characters, so they cannot collide with real content.
function maskCdata(xml) {
  const sections = [];
  const masked = xml.replace(/\u0000/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body) => `\u0000${sections.push(body) - 1}\u0000`);
  return { masked, sections };
}

/** Text outside CDATA is XML-escaped and gets decoded; text inside CDATA is taken as it is. */
function unmask(text, sections) {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(/\u0000(\d+)\u0000/g)) {
    out += decodeEntities(text.slice(last, match.index)) + sections[Number(match[1])];
    last = match.index + match[0].length;
  }
  return out + decodeEntities(text.slice(last));
}

function element(xml, name, sections) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, "i").exec(xml);
  return match ? unmask(match[1], sections) : null;
}

/** Only topic addresses on wordpress.org are kept, so the report never prints a link to anywhere else. */
function topicLink(value) {
  const url = value?.replace(UNSAFE, "").trim();
  return url && /^https:\/\/(?:[a-z0-9-]+\.)*wordpress\.org\/\S*$/i.test(url) ? url : null;
}

function isoDate(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function parseItem(xml, sections) {
  const rawTitle = element(xml, "title", sections) ?? "";
  const description = element(xml, "description", sections) ?? "";
  const encoded = element(xml, "content:encoded", sections);
  const fromDescription = splitReplies(description);
  const fromEncoded = encoded === null ? null : splitReplies(encoded);
  return {
    title: oneLine(htmlToText(rawTitle)),
    url: topicLink(element(xml, "link", sections)) ?? topicLink(element(xml, "guid", sections)),
    created: isoDate(element(xml, "pubDate", sections)),
    replies: fromDescription.replies ?? fromEncoded?.replies ?? null,
    resolved: hasResolvedMarker(rawTitle),
    post: htmlToText(fromEncoded ? fromEncoded.html : fromDescription.html),
  };
}

/**
 * Parses a support forum feed into { title, threads }. Each thread is
 * { title, url, created, replies, resolved, post }: `created` is an ISO date or null, `replies` a number or null,
 * `resolved` whether the forum marks the topic resolved, and `post` the first post as plain text.
 */
export function parseFeed(xml) {
  if (typeof xml !== "string" || !/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) {
    throw new UserError("The answer from WordPress.org is not an RSS feed (no <rss> or <channel> element).");
  }
  const { masked, sections } = maskCdata(xml);
  const firstItem = masked.search(/<item\b/i);
  const channel = firstItem >= 0 ? masked.slice(0, firstItem) : masked;
  const threads = [];
  for (const match of masked.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) threads.push(parseItem(match[1], sections));
  return { title: oneLine(element(channel, "title", sections) ?? ""), threads };
}
