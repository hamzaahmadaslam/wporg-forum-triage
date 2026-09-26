// Formats results for people (the report, the dry run) and for programs (JSON). Every word printed comes from the
// forum feed or from the fixed text in this file; Jev returns only probabilities.
import { estimatePlan, KIND_ORDER, KINDS, PRICE_PER_MILLION } from "./triage.mjs";

/** The order threads are listed in within a group: the ones waiting for you first. */
const STATUS_ORDER = ["unanswered", "needs_reply", "has_replies", "unclear", "looks_resolved", "no_reply_needed", "resolved"];

const REASONS = {
  unsure_kind: "kind unclear",
  unsure_reply: "unclear if it needs a reply",
  unsure_solved: "unclear if solved",
  no_answer: "no answer from TypeSafe",
};

const LIST_LIMIT = 30;

const count = (n) => n.toLocaleString("en-US");
const plural = (n, word, many = `${word}s`) => `${count(n)} ${n === 1 ? word : many}`;
const p2 = (value) => value.toFixed(2);
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const day = (iso) => iso?.slice(0, 10) ?? null;

/** Dollars, with enough decimals to show a cost that is usually a fraction of a cent. */
export function money(cost) {
  if (cost === 0) return "$0";
  if (cost < 0.0001) return "under $0.0001";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** Which feed was read and how many of its pages, for the first line. */
function source(meta) {
  const feed = meta.unresolved ? "unresolved topics feed" : "newest topics feed";
  const read = meta.forum.pages.length;
  return `${feed}, ${plural(read, "page")}${read < meta.pagesAsked ? ` of ${meta.pagesAsked} asked` : ""}`;
}

function statusLabel(entry) {
  switch (entry.status) {
    case "unanswered":
      return "unanswered";
    case "has_replies":
      return plural(entry.thread.replies, "reply", "replies");
    case "needs_reply":
      return "needs a reply";
    case "looks_resolved":
      return "looks resolved";
    case "no_reply_needed":
      return "no reply needed";
    case "resolved":
      return "resolved";
    default:
      return null; // unclear: the reasons say what was unclear
  }
}

/** The kind answer: the likeliest kinds (at most three, each 0.05 or more) and the confidence. */
function kindAnswer(kind) {
  const ranked = Object.entries(kind.probabilities)
    .filter(([name, value]) => Object.hasOwn(KINDS, name) && typeof value === "number")
    .sort((a, b) => b[1] - a[1] || KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]));
  const shown = ranked.filter(([, value], i) => i === 0 || value >= 0.05).slice(0, 3);
  return `${shown.map(([name, value]) => `${name} ${p2(value)}`).join(", ")} (confidence ${p2(kind.confidence)})`;
}

function formatEntry(entry) {
  const { thread, answer } = entry;
  const label = [statusLabel(entry), ...entry.reasons.map((reason) => REASONS[reason] ?? reason)].filter(Boolean).join(", ");
  const opened = day(thread.created) ? `opened ${day(thread.created)}` : "opening date unknown";
  const replies = thread.replies === null ? "reply count unknown" : plural(thread.replies, "reply", "replies");
  const facts = [`${opened}, ${replies}`];
  if (answer) facts.push(kindAnswer(answer.kind), `needs a reply ${p2(answer.reply)}`, `says solved ${p2(answer.solved)}`);
  const lines = [`  ${label}: ${thread.title || "(no title)"}`, `      ${facts.join(" | ")}`];
  if (thread.url) lines.push(`      ${thread.url}`);
  return lines;
}

/** Waiting for you first, then oldest first, then feed order. */
function byUrgency(a, b) {
  return (
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    (a.thread.created ?? "~").localeCompare(b.thread.created ?? "~") ||
    a.order - b.order
  );
}

/** Says when a page brought nothing new, and whether later pages were skipped because of it. */
function pagesNote(meta) {
  const { pages, stoppedAfter } = meta.forum;
  const empty = pages.find((page) => page.added === 0);
  if (!empty || (empty.page === 1 && !stoppedAfter)) return [];
  const what = empty.page === 1 ? "Page 1 had no threads" : `Page ${empty.page} had only threads that were already read`;
  const next = (stoppedAfter ?? 0) + 1;
  const skipped = !stoppedAfter
    ? ""
    : next === meta.pagesAsked
      ? `, so page ${next} was not requested`
      : `, so pages ${next} to ${meta.pagesAsked} were not requested`;
  const hint =
    empty.page === 1
      ? ""
      : meta.unresolved
        ? " WordPress.org sent the same topics again."
        : " WordPress.org sent the same topics again; --unresolved reads the forum's unresolved topics, which reach further back.";
  return ["", `${what}${skipped}.${hint}`];
}

/** The human-readable report: counts, then the threads that are not resolved, grouped by kind, with probabilities. */
export function formatReport(result, meta) {
  const { summary, usage, threshold } = result;
  const cost = (usage.input_tokens * PRICE_PER_MILLION) / 1e6;
  const price = cost === 0 || cost < 0.0001 ? money(cost) : `about ${money(cost)}`;
  const lines = [
    `wporg-forum-triage: ${plural(summary.threads, "thread")} from the ${meta.slug} support forum (${source(meta)})`,
    `Model ${result.model}, ${plural(usage.requests, "request")}, ${count(usage.input_tokens)} input tokens (${price}), threshold ${threshold}`,
    "",
  ];
  if (!summary.threads) {
    lines.push("The feed has no threads.", ...pagesNote(meta));
    return `${lines.join("\n")}\n`;
  }
  const kinds = KIND_ORDER.filter((kind) => summary.kinds[kind]).map((kind) => `${kind} ${summary.kinds[kind]}`);
  if (summary.review) kinds.push(`review ${summary.review}`);
  lines.push(
    `Needs your reply: ${count(summary.unanswered)} unanswered` +
      (summary.unanswered_bugs ? ` (${plural(summary.unanswered_bugs, "bug")})` : "") +
      `, ${count(summary.has_replies)} already with replies` +
      (summary.needs_reply ? `, ${count(summary.needs_reply)} with no reply count` : ""),
    `Not resolved: ${kinds.join(", ") || "none"}`,
    `Marked resolved on the forum: ${count(summary.marked_resolved)}${summary.marked_resolved ? " (not listed)" : ""}`,
  );

  const entries = result.entries.map((entry, order) => ({ ...entry, order }));
  const open = entries.filter((entry) => entry.status !== "resolved");
  for (const kind of KIND_ORDER) {
    const group = open.filter((entry) => !entry.review && entry.kind === kind).sort(byUrgency);
    if (!group.length) continue;
    lines.push("", `${kind} (${group.length})`);
    for (const entry of group) lines.push(...formatEntry(entry));
  }
  const review = open.filter((entry) => entry.review).sort(byUrgency);
  if (review.length) {
    lines.push("", `review (${review.length})`);
    for (const entry of review) lines.push(...formatEntry(entry));
  }
  if (!open.length) lines.push("", "Every thread is marked resolved.");

  const legend = [];
  if (summary.unanswered) legend.push("unanswered: no replies yet, and confident answers say the post needs a reply from you.");
  if (summary.has_replies) {
    legend.push("N replies: the post needs a reply from you and already has replies; the feed does not show who wrote them.");
  }
  if (summary.needs_reply) legend.push("needs a reply: the feed gave no reply count for these threads.");
  if (summary.looks_resolved) legend.push("looks resolved: the post says the problem is solved, but the topic is not marked resolved.");
  if (summary.review) legend.push(`review: an answer was not confident enough (threshold ${threshold}). Read these threads yourself.`);
  if (legend.length) lines.push("", ...legend);
  lines.push(...pagesNote(meta));
  return `${lines.join("\n")}\n`;
}

/** The report as JSON: every thread in feed order, its kind and status, and the raw probabilities. */
export function toJson(result, meta) {
  const cost = (result.usage.input_tokens * PRICE_PER_MILLION) / 1e6;
  return {
    tool: "wporg-forum-triage",
    version: meta.version,
    plugin: meta.slug,
    feed: meta.unresolved ? "unresolved" : "newest",
    pages_asked: meta.pagesAsked,
    pages: meta.forum.pages,
    threshold: result.threshold,
    batch: meta.batch,
    model: result.model,
    summary: result.summary,
    usage: { ...result.usage, estimated_cost_usd: round6(cost) },
    threads: result.entries.map(({ thread, answer, kind, status, review, reasons }) => ({
      title: thread.title,
      url: thread.url,
      opened: thread.created,
      replies: thread.replies,
      marked_resolved: thread.resolved,
      page: thread.page,
      kind,
      status,
      review,
      reasons,
      kind_top: answer?.kind.choice ?? null,
      kind_confidence: answer?.kind.confidence ?? null,
      kind_probabilities: answer?.kind.probabilities ?? null,
      needs_reply: answer?.reply ?? null,
      says_solved: answer?.solved ?? null,
    })),
  };
}

/** What --dry-run prints: the pages read, the threads, the token estimate and one thread's questions. */
export function formatDryRun(plan, meta) {
  const estimate = estimatePlan(plan);
  const resolved = plan.threads.filter((thread) => thread.resolved).length;
  const lines = [
    "Dry run: the feed was read from WordPress.org; nothing was sent to TypeSafe.",
    "",
    `${plural(plan.threads.length, "thread")} from the ${meta.slug} support forum (${source(meta)}), ${count(resolved)} marked resolved`,
  ];
  for (const page of meta.forum.pages) {
    lines.push(`  ${page.url}  ${plural(page.items, "thread")}${page.added < page.items ? `, ${count(page.added)} new` : ""}`);
  }
  if (plan.threads.length) lines.push("");
  plan.threads.slice(0, LIST_LIMIT).forEach((thread, i) => {
    const replies = thread.replies === null ? "?" : plural(thread.replies, "reply", "replies");
    const flags = thread.resolved ? "resolved  " : "";
    lines.push(`  ${`t${i}`.padEnd(4)} ${day(thread.created) ?? "no date   "}  ${replies.padEnd(10)} ${flags}${thread.title || "(no title)"}`);
  });
  if (plan.threads.length > LIST_LIMIT) lines.push(`  and ${plural(plan.threads.length - LIST_LIMIT, "more thread")}`);
  lines.push(...pagesNote(meta));
  lines.push(
    "",
    `${plural(plan.requests.length, "request")} to ${meta.model}, about ${count(estimate.tokens)} input tokens ` +
      `(${money(estimate.cost)} at $${PRICE_PER_MILLION} per million)`,
  );
  const request = plan.requests[0];
  if (request) {
    const target = request.targets[0];
    const title = plan.threads[target.index].title || "(no title)";
    lines.push("", `Each thread gets three questions. For t${target.index} "${title}", which is \`threads[${target.at}]\` in its request:`);
    for (const suffix of ["kind", "reply", "solved"]) {
      const id = `${target.key}_${suffix}`;
      const question = request.body.questions[id];
      const options = question.type === "choice" ? `: ${Object.keys(question.criteria).join(", ")}` : "";
      lines.push(`  ${id} (${question.type}${options})`, `    ${question.instructions}`);
    }
  }
  lines.push("", "Run with --dry-run --json to see every request body.");
  return `${lines.join("\n")}\n`;
}

/** What --dry-run --json prints: the estimate and every request body exactly as it would be sent. */
export function dryRunJson(plan, meta) {
  const estimate = estimatePlan(plan);
  return {
    tool: "wporg-forum-triage",
    version: meta.version,
    dry_run: true,
    plugin: meta.slug,
    feed: meta.unresolved ? "unresolved" : "newest",
    pages_asked: meta.pagesAsked,
    pages: meta.forum.pages,
    batch: meta.batch,
    model: meta.model,
    summary: {
      threads: plan.threads.length,
      marked_resolved: plan.threads.filter((thread) => thread.resolved).length,
      requests: plan.requests.length,
    },
    estimated_input_tokens: estimate.tokens,
    estimated_cost_usd: round6(estimate.cost),
    requests: plan.requests.map((request, i) => ({
      threads: request.targets.map((target) => plan.threads[target.index].url ?? plan.threads[target.index].title),
      estimated_tokens: estimate.perRequest[i],
      body: request.body,
    })),
  };
}
