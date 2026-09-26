// Reproduces the README example without a network and without a TypeSafe key: the feed comes from
// examples/feed.xml (a made-up plugin's forum) and every answer from the hand-written probabilities in
// fixture-answers.json. Nothing leaves the machine.
//   node examples/run.mjs              the report (examples/report.txt)
//   node examples/run.mjs --json       the JSON (examples/report.json)
//   node examples/run.mjs --dry-run    the dry run (examples/dry-run.txt)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { main } from "../src/cli.mjs";
import { parseFeed } from "../src/rss.mjs";
import { estimateTokens, KINDS } from "../src/triage.mjs";

export const SLUG = "tidy-backups-demo";
export const FEED = readFileSync(new URL("./feed.xml", import.meta.url), "utf8");
const FIXTURE = JSON.parse(readFileSync(new URL("./fixture-answers.json", import.meta.url), "utf8"));

/** A choice answer shaped like TypeSafe's, with the confidence approximation from TypeSafe's confidence page. */
export function choiceAnswer(probabilities, options = Object.keys(KINDS)) {
  const offered = Object.fromEntries(options.map((option) => [option, probabilities[option] ?? 0]));
  const total = Object.values(offered).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.001) throw new Error(`Fixture probabilities for ${options.join(", ")} add up to ${total}.`);
  const choice = options.reduce((best, option) => (offered[option] > offered[best] ? option : best));
  const k = options.length;
  const confidence = Math.min(1, Math.max(0, (k * offered[choice] - 1) / (k - 1)));
  return { type: "choice", choice, probabilities: offered, confidence: Math.round(confidence * 100) / 100 };
}

/** The last part of a topic address, which keys the fixture answers. */
const topicSlug = (url) => new URL(url).pathname.split("/").filter(Boolean).pop();

/**
 * A fetch stand-in for the only two hosts the tool contacts: WordPress.org answers with examples/feed.xml, TypeSafe
 * with the fixture answers (the number in each question id is the thread's position in the feed). Any other host
 * throws. `calls` records every request.
 */
export function exampleFetch() {
  const threads = parseFeed(FEED).threads;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { hostname } = new URL(url);
    calls.push({ url, init });
    if (hostname === "wordpress.org") {
      return new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml; charset=UTF-8" } });
    }
    if (hostname !== "api.typesafe.ai") throw new Error(`The example contacts only wordpress.org and api.typesafe.ai, not ${hostname}.`);
    const body = JSON.parse(init.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      const [, index, question] = /^t(\d+)_(kind|reply|solved)$/.exec(key);
      const fixture = FIXTURE.answers[topicSlug(threads[Number(index)].url)];
      answers[key] = question === "kind" ? choiceAnswer(fixture.kind) : { type: "noul", noul: fixture[question] };
    }
    const usage = { input_tokens: estimateTokens(JSON.stringify(body)), output_tokens: 0 };
    return new Response(JSON.stringify({ model: FIXTURE.model, answers, usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2).filter((flag) => flag === "--json" || flag === "--dry-run");
  process.exitCode = await main([SLUG, ...flags], {
    env: { TYPESAFE_API_KEY: "fixture" },
    fetchImpl: exampleFetch().fetchImpl,
  });
}
