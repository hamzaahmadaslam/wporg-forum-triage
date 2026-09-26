// Builds the requests (a few threads as the state, three questions per thread), sends them to Jev, and turns the
// answers into a kind and a status for each thread. The thresholds and every decision live here, in code.
import { askJev, choice, DEFAULT_MODEL, noul } from "./jev.mjs";

export const DEFAULT_THRESHOLD = 0.8;
export const DEFAULT_BATCH = 5;
export const MAX_BATCH = 30;
export const DEFAULT_TIMEOUT_SECONDS = 10;
/** Estimated tokens of state per request. TypeSafe allows 32k for the state plus the longest question. */
export const STATE_BUDGET = 16_000;
/** How much of a thread goes into the state: the title, and the start and end of a long first post. */
export const TITLE_CHARS = 300;
export const POST_HEAD_CHARS = 3_000;
export const POST_TAIL_CHARS = 1_000;
/** US dollars per million input tokens for jev-1.13. Output tokens are free. */
export const PRICE_PER_MILLION = 0.042;
const CONCURRENCY = 4;

/** A rough token count: four characters per token. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * The kinds a thread can be, as Jev sees them. The three that are easy to confuse say what they are not for.
 * "other" catches threads that fit none of the six kinds the tool reports on.
 */
export const KINDS = {
  bug: {
    what: "Something in the plugin itself is broken: an error message, a crash, a warning, wrong output, or a feature that stopped working.",
    not_for: "A problem the post ties to another named plugin, a theme or an outside service; that is conflict-with-another-plugin.",
  },
  "how-to": {
    what: "A question about how to use, set up or customize the plugin.",
    not_for: "A report that something is broken; that is bug.",
  },
  "feature-request": "Asks for new functionality, a new option or a change to how the plugin works.",
  "conflict-with-another-plugin": {
    what: "A problem that appears only when the plugin runs together with another named plugin, a theme or an outside service.",
    not_for: "A problem with the plugin on its own; that is bug.",
  },
  praise: "Thanks the author or praises the plugin, with no problem or question in it.",
  spam: "Advertising, or text that has nothing to do with the plugin.",
  other: "Fits none of the other kinds, such as a question about pricing, a license, an account or whether the plugin is still maintained.",
};

/** The order kinds appear in the report: problems first. */
export const KIND_ORDER = ["bug", "conflict-with-another-plugin", "how-to", "feature-request", "other", "praise", "spam"];

const CONTEXT =
  "`threads` lists separate topics from the support forum of one WordPress plugin. Each has the `title` and the `first_post` written by the person who opened it.";

/** The three questions asked about the thread at `threads[at]` in the state. `key` prefixes the question ids. */
export function questionsFor(key, at) {
  const self = `\`threads[${at}]\``;
  return {
    [`${key}_kind`]: choice(`${CONTEXT} What kind of topic is ${self}?`, KINDS),
    [`${key}_reply`]: noul(`${CONTEXT} Does ${self} need a reply from the people who make the plugin?`, {
      true: "It reports a problem, asks a question or makes a request that the plugin's author or support team should answer.",
      false: "Nothing in it needs an answer from them: it only thanks or praises, it is spam, or it says the problem is already solved.",
    }),
    [`${key}_solved`]: noul(`${CONTEXT} Does ${self} say that its problem is solved or its question is answered?`, {
      true: "The title or the post says the problem is fixed, solved or gone, for example in an edit or update added to the post.",
      false: "It does not say so: the problem or question is still open, or there is nothing to solve.",
    }),
  };
}

const cutEnd = (text) => text.replace(/\s+\S*$/, "");
const cutStart = (text) => text.replace(/^\S*\s+/, "");

/** A first post longer than the head and tail together keeps its start and its end, where edits usually go. */
export function clipPost(text) {
  if (text.length <= POST_HEAD_CHARS + POST_TAIL_CHARS) return text;
  return `${cutEnd(text.slice(0, POST_HEAD_CHARS))} [...] ${cutStart(text.slice(-POST_TAIL_CHARS))}`;
}

const clipTitle = (title) => (title.length <= TITLE_CHARS ? title : `${cutEnd(title.slice(0, TITLE_CHARS))} [...]`);

/** What Jev sees of one thread: its title and first post. No address, name, date or reply count. */
export const stateItem = (thread) => ({ title: clipTitle(thread.title), first_post: clipPost(thread.post) });

const stateTokens = (item) => estimateTokens(JSON.stringify(item));

/**
 * Groups the threads into requests of up to `batch` threads, keeping each state under STATE_BUDGET. Question ids
 * are numbered by the thread's position in the run: t0_kind, t0_reply, t0_solved, t1_kind and so on.
 */
export function planRequests(threads, { batch = DEFAULT_BATCH, model = DEFAULT_MODEL } = {}) {
  const requests = [];
  let i = 0;
  while (i < threads.length) {
    const group = [i];
    let tokens = stateTokens(stateItem(threads[i]));
    let j = i + 1;
    while (j < threads.length && group.length < batch) {
      const more = stateTokens(stateItem(threads[j]));
      if (tokens + more > STATE_BUDGET) break;
      tokens += more;
      group.push(j++);
    }
    const questions = {};
    const targets = group.map((index, at) => {
      const key = `t${index}`;
      Object.assign(questions, questionsFor(key, at));
      return { key, at, index };
    });
    requests.push({ targets, body: { model, state: { threads: group.map((index) => stateItem(threads[index])) }, questions } });
    i = j;
  }
  return { threads, requests };
}

/** Estimated input tokens and cost of a plan, for --dry-run. */
export function estimatePlan(plan) {
  const perRequest = plan.requests.map((request) => estimateTokens(JSON.stringify(request.body)));
  const tokens = perRequest.reduce((sum, n) => sum + n, 0);
  return { perRequest, tokens, cost: (tokens * PRICE_PER_MILLION) / 1e6 };
}

const isProbability = (value) => typeof value === "number" && value >= 0 && value <= 1;

/** The three answers for one thread from a response, or null when any is missing or malformed. */
export function readAnswer(answers, key) {
  const kind = answers?.[`${key}_kind`];
  const reply = answers?.[`${key}_reply`]?.noul;
  const solved = answers?.[`${key}_solved`]?.noul;
  if (!isProbability(reply) || !isProbability(solved)) return null;
  if (typeof kind?.choice !== "string" || !Object.hasOwn(KINDS, kind.choice) || !isProbability(kind.confidence)) return null;
  if (!kind.probabilities || typeof kind.probabilities !== "object") return null;
  return { kind: { choice: kind.choice, confidence: kind.confidence, probabilities: kind.probabilities }, reply, solved };
}

// Rounding keeps float noise (1 - 0.8 is 0.19999999999999996) from moving an answer that sits on the threshold.
const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Turns one thread's answers into { kind, status, review, reasons }. A yes/no answer counts only at or above
 * `threshold` (yes) or at or below 1 - `threshold` (no), and the kind only when its confidence is at or above
 * `threshold`; `kind` is null otherwise. The forum's own resolved marker always wins. Status:
 *   resolved         the forum marks the topic resolved
 *   looks_resolved   not marked, but the post says the problem is solved
 *   no_reply_needed  the post needs no answer from the plugin's makers
 *   unanswered       it needs their answer and has no replies yet
 *   has_replies      it needs their answer and has replies (the feed does not show whose)
 *   needs_reply      it needs their answer; the feed gave no reply count
 *   unclear          an answer fell between the limits
 * A thread that is not marked resolved goes to review when its kind or its status is unclear.
 */
export function decide(answer, thread, threshold = DEFAULT_THRESHOLD) {
  const yes = (p) => round(p) >= threshold;
  const no = (p) => round(1 - p) >= threshold;
  const kind = round(answer.kind.confidence) >= threshold ? answer.kind.choice : null;
  const reasons = [];
  let status;
  if (thread.resolved) status = "resolved";
  else if (yes(answer.solved)) status = "looks_resolved";
  else if (no(answer.reply)) status = "no_reply_needed";
  else if (yes(answer.reply) && no(answer.solved)) {
    status = thread.replies === 0 ? "unanswered" : thread.replies === null ? "needs_reply" : "has_replies";
  } else {
    status = "unclear";
    if (!yes(answer.reply)) reasons.push("unsure_reply");
    if (!no(answer.solved)) reasons.push("unsure_solved");
  }
  if (kind === null) reasons.unshift("unsure_kind");
  const review = !thread.resolved && (kind === null || status === "unclear");
  return { kind, status, review, reasons };
}

/** Counts for the report and the JSON. Kind counts cover threads that are not resolved and not in review. */
export function summarize(entries) {
  const kinds = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0]));
  const summary = {
    threads: entries.length,
    marked_resolved: 0,
    not_resolved: 0,
    unanswered: 0,
    unanswered_bugs: 0,
    has_replies: 0,
    needs_reply: 0,
    looks_resolved: 0,
    no_reply_needed: 0,
    unclear: 0,
    review: 0,
    kinds,
  };
  for (const entry of entries) {
    if (entry.status === "resolved") {
      summary.marked_resolved++;
      continue;
    }
    summary.not_resolved++;
    summary[entry.status]++;
    if (entry.review) summary.review++;
    else kinds[entry.kind]++;
    if (entry.status === "unanswered" && entry.kind === "bug") summary.unanswered_bugs++;
  }
  return summary;
}

/** Runs `worker` over `items` with at most `limit` at a time; stops starting new work after the first failure. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Sends every request in the plan (four at a time) and returns
 * { model, threshold, entries: [{ thread, answer, kind, status, review, reasons }], summary, usage }, with the
 * entries in feed order. Any TypeSafe error (missing key, 401, 422, 429 or 529 after retries, timeout) stops the
 * run with a JevError.
 */
export async function runPlan(plan, options = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    apiKey,
    model = DEFAULT_MODEL,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    retries = 3,
    fetchImpl,
    onProgress,
  } = options;
  let done = 0;
  const responses = await mapLimit(plan.requests, CONCURRENCY, async (request) => {
    const response = await askJev(request.body.state, request.body.questions, {
      apiKey,
      model,
      timeoutMs: timeoutSeconds * 1000,
      retries,
      fetchImpl,
    });
    onProgress?.(++done, plan.requests.length);
    return response;
  });

  const entries = new Array(plan.threads.length);
  plan.requests.forEach((request, i) => {
    for (const { key, index } of request.targets) {
      const thread = plan.threads[index];
      const answer = readAnswer(responses[i].answers, key);
      entries[index] = answer
        ? { thread, answer, ...decide(answer, thread, threshold) }
        : {
            thread,
            answer: null,
            kind: null,
            status: thread.resolved ? "resolved" : "unclear",
            review: !thread.resolved,
            reasons: ["no_answer"],
          };
    }
  });
  const usage = {
    requests: responses.length,
    input_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.input_tokens) || 0), 0),
    output_tokens: responses.reduce((sum, r) => sum + (Number(r.usage?.output_tokens) || 0), 0),
  };
  return { model: responses[0]?.model ?? model, threshold, entries, summary: summarize(entries), usage };
}
