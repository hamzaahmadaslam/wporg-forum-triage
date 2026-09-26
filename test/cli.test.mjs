import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { exampleFetch, SLUG } from "../examples/run.mjs";
import { main, USAGE } from "../src/cli.mjs";
import { answersFor, pageOf, routerFetch } from "./fixtures/feeds.mjs";

globalThis.fetch = () => {
  throw new Error("Tests must not use the network.");
};

const KEY = "test-key-never-printed";
const EXAMPLE_FEED = `https://wordpress.org/support/plugin/${SLUG}/feed/`;
const text = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Runs the CLI in this process with captured output. The default fetch fails, so nothing can reach the network. */
async function run(args, { env = {}, fetchImpl = globalThis.fetch, sleep = async () => {} } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    env,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
    fetchImpl,
    sleep,
  });
  return { code, stdout, stderr };
}

test("tests cannot reach the network: the global fetch is replaced", async () => {
  await assert.rejects(async () => globalThis.fetch("https://wordpress.org/support/plugin/hello-dolly/feed/"), /must not use the network/);
});

test("the example reproduces report.txt, report.json and dry-run.txt exactly, contacting only the two hosts", async () => {
  const example = exampleFetch();
  const report = await run([SLUG], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: example.fetchImpl });
  assert.equal(report.code, 1, "four unanswered threads, so the exit code is 1");
  assert.equal(report.stdout, text("../examples/report.txt"));
  assert.equal(report.stderr, "");
  assert.deepEqual(
    example.calls.map((call) => new URL(call.url).origin),
    ["https://wordpress.org", "https://api.typesafe.ai", "https://api.typesafe.ai", "https://api.typesafe.ai"],
  );
  assert.equal(example.calls[0].url, EXAMPLE_FEED);
  for (const call of example.calls.slice(1)) assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(example.calls[0].init.headers.authorization, undefined, "the key never goes to WordPress.org");

  const json = await run([SLUG, "--json"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: exampleFetch().fetchImpl });
  assert.equal(json.stdout, text("../examples/report.json"));
  const data = JSON.parse(json.stdout);
  assert.equal(data.threads.length, 12);
  assert.deepEqual(
    [data.summary.unanswered, data.summary.unanswered_bugs, data.summary.review, data.summary.marked_resolved],
    [4, 1, 2, 2],
  );

  const dry = await run([SLUG, "--dry-run"], { fetchImpl: exampleFetch().fetchImpl });
  assert.equal(dry.stdout, text("../examples/dry-run.txt"));

  const readme = text("../README.md");
  assert.ok(readme.includes(text("../examples/report.txt")), "the README shows examples/report.txt exactly");
  for (const output of [report, json, dry]) assert.ok(!(output.stdout + output.stderr).includes(KEY), "the key is never printed");
});

test("--dry-run reads the feed, needs no key and sends nothing to TypeSafe", async () => {
  const example = exampleFetch();
  const dry = await run([SLUG, "--dry-run", "--json"], { env: { TYPESAFE_MODEL: "jev-1.13.0" }, fetchImpl: example.fetchImpl });
  assert.equal(dry.code, 0);
  assert.deepEqual(
    example.calls.map((call) => call.url),
    [EXAMPLE_FEED],
  );
  const data = JSON.parse(dry.stdout);
  assert.equal(data.dry_run, true);
  assert.equal(data.model, "jev-1.13.0");
  assert.deepEqual(
    data.requests.map((request) => request.threads.length),
    [5, 5, 2],
  );
  assert.equal(Object.keys(data.requests[0].body.questions).length, 15);
  assert.equal(data.requests[0].body.model, "jev-1.13.0");
  assert.equal(data.estimated_input_tokens, data.requests.reduce((sum, request) => sum + request.estimated_tokens, 0));
});

test("exit code 0 and a short report when nothing waits for a reply", async () => {
  const { fetchImpl } = routerFetch({
    feeds: { "https://wordpress.org/support/plugin/sample-plugin/feed/": pageOf("thanks", 3) },
    jev: (body) => answersFor(body, () => ({ kind: "praise", confidence: 0.97, reply: 0.05, solved: 0.1 })),
  });
  const { code, stdout } = await run(["sample-plugin", "--threshold", "0.9"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl });
  assert.equal(code, 0);
  assert.match(stdout, /^wporg-forum-triage: 3 threads from the sample-plugin support forum \(newest topics feed, 1 page\)\n/);
  assert.match(stdout, /Model jev-1\.13\.0, 1 request, 1,000 input tokens \(under \$0\.0001\), threshold 0\.9/);
  assert.match(stdout, /Needs your reply: 0 unanswered, 0 already with replies\nNot resolved: praise 3\n/);
  assert.doesNotMatch(stdout, /^unanswered:/m);
});

test("--pages reads later pages politely and says when WordPress.org repeats a page; --unresolved reads that feed", async () => {
  const base = "https://wordpress.org/support/plugin/sample-plugin/unresolved/feed/";
  const same = pageOf("open", 2);
  const { fetchImpl, calls } = routerFetch({ feeds: { [base]: same, [`${base}?paged=2`]: same } });
  const pauses = [];
  const dry = await run(["sample-plugin", "--unresolved", "--pages", "5", "--dry-run"], { fetchImpl, sleep: async (ms) => pauses.push(ms) });
  assert.equal(dry.code, 0);
  assert.deepEqual(
    calls.map((call) => call.url),
    [base, `${base}?paged=2`],
  );
  assert.deepEqual(pauses, [2000]);
  assert.match(dry.stdout, /2 threads from the sample-plugin support forum \(unresolved topics feed, 2 pages of 5 asked\), 0 marked resolved/);
  assert.match(dry.stdout, /Page 2 had only threads that were already read, so pages 3 to 5 were not requested\. WordPress\.org sent the same topics again\./);
});

test("usage errors and a missing key exit 2 with one plain line, before any request", async () => {
  const cases = [
    [["Hello-Dolly"], /^"Hello-Dolly" is not a plugin slug: use lowercase letters, digits and hyphens\. Slugs are lowercase: try hello-dolly\.$/],
    [["hello_dolly"], /is not a plugin slug/],
    [["sample-plugin", "--pages", "11"], '--pages must be a whole number from 1 to 10, not "11".'],
    [["sample-plugin", "--pages", "0"], '--pages must be a whole number from 1 to 10, not "0".'],
    [["sample-plugin", "--threshold", "0.5"], '--threshold must be a number above 0.5 and at most 1, not "0.5".'],
    [["sample-plugin", "--batch", "31"], '--batch must be a whole number from 1 to 30, not "31".'],
    [["sample-plugin", "--timeout", "0"], '--timeout must be a number of seconds above 0 and at most 600, not "0".'],
    [["sample-plugin", "--frobnicate"], /Unknown option '--frobnicate'.*Run wporg-forum-triage --help/],
    [[], /^Give one plugin slug, such as hello-dolly\./],
    [["one", "two"], /^Give one plugin slug/],
    [["sample-plugin"], /^TYPESAFE_API_KEY is not set\./],
  ];
  for (const [args, expected] of cases) {
    const { fetchImpl, calls } = routerFetch();
    const { code, stdout, stderr } = await run(args, { env: { TYPESAFE_API_KEY: "  " }, fetchImpl });
    const label = args.join(" ") || "(no arguments)";
    assert.equal(code, 2, label);
    assert.equal(stdout, "", label);
    assert.equal(calls.length, 0, `no request for ${label}`);
    assert.equal(stderr.split("\n").length, 2, `one line for ${label}`);
    assert.ok(stderr.startsWith("wporg-forum-triage: "), label);
    const message = stderr.slice("wporg-forum-triage: ".length).trimEnd();
    if (typeof expected === "string") assert.equal(message, expected, label);
    else assert.match(message, expected, label);
  }

  // A feed error is one plain line too.
  const missing = routerFetch();
  const notFound = await run(["no-such-plugin-sample"], { env: { TYPESAFE_API_KEY: KEY }, fetchImpl: missing.fetchImpl });
  assert.equal(notFound.code, 2);
  assert.match(notFound.stderr, /^wporg-forum-triage: WordPress\.org has no support feed at .* \(HTTP 404\)\. Check the plugin slug: .*\n$/);
  assert.equal(missing.calls.length, 1);
});

test("--help and --version", async () => {
  assert.deepEqual(await run(["--help"]), { code: 0, stdout: USAGE, stderr: "" });
  assert.deepEqual(await run(["-v"]), { code: 0, stdout: "1.0.0\n", stderr: "" });
  assert.match(USAGE, /--pages <n> +feed pages to read, 1 to 10 \(default 1\)/);
});
