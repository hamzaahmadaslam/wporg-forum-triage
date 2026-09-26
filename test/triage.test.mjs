import assert from "node:assert/strict";
import test from "node:test";
import { fixtureFetch } from "../src/jev.mjs";
import {
  decide,
  estimateTokens,
  planRequests,
  POST_HEAD_CHARS,
  POST_TAIL_CHARS,
  runPlan,
  STATE_BUDGET,
} from "../src/triage.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

/** A thread as the feed reader returns it. */
const thread = (title, post, extra = {}) => ({
  title,
  post,
  url: `https://wordpress.org/support/topic/${title.toLowerCase().replace(/\W+/g, "-")}/`,
  created: "2026-09-20T10:00:00.000Z",
  replies: 0,
  resolved: false,
  page: 1,
  ...extra,
});

const CONTEXT =
  "`threads` lists separate topics from the support forum of one WordPress plugin. Each has the `title` and the `first_post` written by the person who opened it.";
const KINDS = {
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
const REPLY_CRITERIA = {
  true: "It reports a problem, asks a question or makes a request that the plugin's author or support team should answer.",
  false: "Nothing in it needs an answer from them: it only thanks or praises, it is spam, or it says the problem is already solved.",
};
const SOLVED_CRITERIA = {
  true: "The title or the post says the problem is fixed, solved or gone, for example in an edit or update added to the post.",
  false: "It does not say so: the problem or question is still open, or there is nothing to solve.",
};
const questions = (key, at) => ({
  [`${key}_kind`]: { type: "choice", instructions: `${CONTEXT} What kind of topic is \`threads[${at}]\`?`, criteria: KINDS },
  [`${key}_reply`]: {
    type: "noul",
    instructions: `${CONTEXT} Does \`threads[${at}]\` need a reply from the people who make the plugin?`,
    criteria: REPLY_CRITERIA,
  },
  [`${key}_solved`]: {
    type: "noul",
    instructions: `${CONTEXT} Does \`threads[${at}]\` say that its problem is solved or its question is answered?`,
    criteria: SOLVED_CRITERIA,
  },
});

test("the request body: titles and first posts as the state, three questions per thread", () => {
  const plan = planRequests(
    [thread("Error after update", "The settings page is blank.", { replies: 3 }), thread("Thanks", "Great plugin.", { resolved: true })],
    { batch: 5, model: "jev-latest" },
  );
  assert.equal(plan.requests.length, 1);
  assert.deepEqual(plan.requests[0].body, {
    model: "jev-latest",
    state: {
      threads: [
        { title: "Error after update", first_post: "The settings page is blank." },
        { title: "Thanks", first_post: "Great plugin." },
      ],
    },
    questions: { ...questions("t0", 0), ...questions("t1", 1) },
  });
  // Addresses, dates, reply counts and the resolved marker stay on the machine.
  const sent = JSON.stringify(plan.requests[0].body);
  for (const kept of ["wordpress.org", "2026-09-20", "replies", "resolved"]) assert.ok(!sent.includes(kept), kept);
});

test("batching: at most --batch threads per request, state under the budget, long posts keep their start and end", () => {
  const threads = Array.from({ length: 12 }, (_, i) => thread(`Thread ${i}`, `Post ${i}.`));
  const plan = planRequests(threads, { batch: 5 });
  assert.deepEqual(
    plan.requests.map((request) => request.targets.map((target) => target.key)),
    [
      ["t0", "t1", "t2", "t3", "t4"],
      ["t5", "t6", "t7", "t8", "t9"],
      ["t10", "t11"],
    ],
  );
  assert.deepEqual(
    plan.requests[1].targets.map((target) => target.at),
    [0, 1, 2, 3, 4],
  );
  assert.equal(Object.keys(plan.requests[2].body.questions).join(","), "t10_kind,t10_reply,t10_solved,t11_kind,t11_reply,t11_solved");

  const long = `Start of the post. ${"word ".repeat(3_000)}EDIT: fixed by clearing the cache.`;
  const clipped = planRequests([thread("Long post", long)]).requests[0].body.state.threads[0].first_post;
  assert.ok(clipped.startsWith("Start of the post. word"));
  assert.ok(clipped.endsWith("EDIT: fixed by clearing the cache."));
  assert.ok(clipped.includes(" [...] "));
  assert.ok(clipped.length <= POST_HEAD_CHARS + POST_TAIL_CHARS + 7);

  const big = Array.from({ length: 30 }, (_, i) => thread(`Big ${i}`, "x ".repeat(4_000)));
  const split = planRequests(big, { batch: 30 });
  assert.ok(split.requests.length > 1, "30 long posts do not fit one state");
  for (const request of split.requests) assert.ok(estimateTokens(JSON.stringify(request.body.state)) <= STATE_BUDGET);
  assert.equal(split.requests.flatMap((request) => request.targets).length, 30);
});

const answer = (kind, confidence, reply, solved) => ({ kind: { choice: kind, confidence, probabilities: { [kind]: confidence } }, reply, solved });

test("decide: kind and status at, above and below the threshold", () => {
  const open = thread("Open", "Post.", { replies: 0 });
  // At the threshold counts; float noise (1 - 0.8) does not move an answer off it.
  assert.deepEqual(decide(answer("bug", 0.8, 0.8, 0.2), open, 0.8), { kind: "bug", status: "unanswered", review: false, reasons: [] });
  assert.deepEqual(decide(answer("bug", 0.95, 0.97, 0.02), thread("Replied", "Post.", { replies: 2 })), {
    kind: "bug",
    status: "has_replies",
    review: false,
    reasons: [],
  });
  assert.equal(decide(answer("bug", 0.95, 0.97, 0.02), thread("No count", "Post.", { replies: null })).status, "needs_reply");
  // Below the threshold: the kind is unclear and the thread goes to review, with its status kept.
  assert.deepEqual(decide(answer("other", 0.79, 0.9, 0.05), open, 0.8), {
    kind: null,
    status: "unanswered",
    review: true,
    reasons: ["unsure_kind"],
  });
  // A yes/no answer between the limits makes the status unclear.
  assert.deepEqual(decide(answer("bug", 0.84, 0.64, 0.55), open), {
    kind: "bug",
    status: "unclear",
    review: true,
    reasons: ["unsure_reply", "unsure_solved"],
  });
  assert.deepEqual(decide(answer("bug", 0.9, 0.95, 0.3), open).reasons, ["unsure_solved"]);
  assert.equal(decide(answer("how-to", 0.92, 0.12, 0.91), open).status, "looks_resolved");
  assert.equal(decide(answer("praise", 0.98, 0.08, 0.5), open).status, "no_reply_needed");
  // A stricter threshold moves the same answers to review.
  assert.equal(decide(answer("bug", 0.85, 0.85, 0.1), open, 0.9).review, true);
  assert.equal(decide(answer("bug", 0.85, 0.85, 0.1), open, 0.8).review, false);
  // The forum's resolved marker wins over every answer, and a resolved thread never needs review.
  assert.deepEqual(decide(answer("bug", 0.3, 0.5, 0.5), thread("Done", "Post.", { resolved: true })), {
    kind: null,
    status: "resolved",
    review: false,
    reasons: ["unsure_kind"],
  });
});

test("runPlan: answers become entries in feed order, and a malformed answer goes to review", async () => {
  const threads = [thread("One", "Broken."), thread("Two", "Thanks!"), thread("Three", "Fixed?", { resolved: true })];
  const plan = planRequests(threads, { batch: 2 });
  const { fetchImpl, calls } = fixtureFetch((body) => {
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      if (key.startsWith("t1_")) continue; // thread two gets no answers at all
      answers[key] = key.endsWith("_kind")
        ? { type: "choice", choice: "bug", confidence: 0.9, probabilities: { bug: 0.93, "how-to": 0.07 } }
        : { type: "noul", noul: key.endsWith("_reply") ? 0.95 : 0.04 };
    }
    return { model: "jev-1.13.0", answers, usage: { input_tokens: 500, output_tokens: 10 } };
  });
  const result = await runPlan(plan, { apiKey: "test-key", fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, "Bearer test-key");
  assert.deepEqual(
    result.entries.map(({ thread: t, kind, status, review, reasons }) => [t.title, kind, status, review, reasons]),
    [
      ["One", "bug", "unanswered", false, []],
      ["Two", null, "unclear", true, ["no_answer"]],
      ["Three", "bug", "resolved", false, []],
    ],
  );
  assert.deepEqual(result.usage, { requests: 2, input_tokens: 1000, output_tokens: 20 });
  assert.equal(result.summary.unanswered, 1);
  assert.equal(result.summary.unanswered_bugs, 1);
  assert.equal(result.summary.review, 1);
  assert.equal(result.summary.marked_resolved, 1);
  assert.equal(result.summary.kinds.bug, 1);
});
