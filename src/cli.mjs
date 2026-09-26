// The command line: parses options, reads the feed, and prints the report, the JSON or the dry run.
// main() takes its environment, output streams, fetch and sleep as arguments, so tests run it without a network.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { UserError } from "./errors.mjs";
import { checkSlug, MAX_PAGES, readForum } from "./feed.mjs";
import { DEFAULT_MODEL, JevError } from "./jev.mjs";
import { dryRunJson, formatDryRun, formatReport, toJson } from "./report.mjs";
import { DEFAULT_BATCH, DEFAULT_THRESHOLD, DEFAULT_TIMEOUT_SECONDS, MAX_BATCH, planRequests, runPlan } from "./triage.mjs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const USAGE = `Usage: wporg-forum-triage <plugin-slug> [options]

Reads a plugin's public support feed on WordPress.org, sorts the threads into bug, how-to, feature-request,
conflict-with-another-plugin, praise, spam and other, and lists the ones waiting for your reply.

Options:
  --pages <n>          feed pages to read, 1 to ${MAX_PAGES} (default 1)
  --unresolved         read the forum's unresolved topics instead of the newest topics
  --threshold <p>      confidence needed to act on an answer, above 0.5 and up to 1 (default ${DEFAULT_THRESHOLD})
  --batch <n>          threads per TypeSafe request, 1 to ${MAX_BATCH} (default ${DEFAULT_BATCH})
  --timeout <seconds>  time limit for each request (default ${DEFAULT_TIMEOUT_SECONDS})
  --json               print JSON instead of the report
  --dry-run            read the feed, then print the questions and a token estimate; send nothing to TypeSafe
  -h, --help           show this help
  -v, --version        show the version

Environment:
  TYPESAFE_API_KEY     your TypeSafe API key (not needed for --dry-run)
  TYPESAFE_MODEL       the model to use (default ${DEFAULT_MODEL})

Exit codes: 0 no unanswered thread, 1 at least one unanswered thread needs your reply, 2 error.
`;

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        pages: { type: "string" },
        unresolved: { type: "boolean", default: false },
        threshold: { type: "string" },
        batch: { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    throw new UserError(`${error.message} Run wporg-forum-triage --help for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.help || values.version) return { help: values.help, version: values.version };
  if (positionals.length !== 1) {
    throw new UserError("Give one plugin slug, such as hello-dolly. Run wporg-forum-triage --help for usage.");
  }

  const pages = values.pages === undefined ? 1 : Number(values.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) {
    throw new UserError(`--pages must be a whole number from 1 to ${MAX_PAGES}, not "${values.pages}".`);
  }
  const threshold = values.threshold === undefined ? DEFAULT_THRESHOLD : Number(values.threshold);
  if (!(threshold > 0.5 && threshold <= 1)) {
    throw new UserError(`--threshold must be a number above 0.5 and at most 1, not "${values.threshold}".`);
  }
  const batch = values.batch === undefined ? DEFAULT_BATCH : Number(values.batch);
  if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) {
    throw new UserError(`--batch must be a whole number from 1 to ${MAX_BATCH}, not "${values.batch}".`);
  }
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);
  if (!(timeoutSeconds > 0 && timeoutSeconds <= 600)) {
    throw new UserError(`--timeout must be a number of seconds above 0 and at most 600, not "${values.timeout}".`);
  }
  return {
    slug: checkSlug(positionals[0]),
    pages,
    unresolved: values.unresolved,
    threshold,
    batch,
    timeoutSeconds,
    json: values.json,
    dryRun: values["dry-run"],
  };
}

/** Runs the tool. Returns the exit code: 0 nothing unanswered, 1 at least one unanswered thread, 2 an error. */
export async function main(argv, io = {}) {
  const { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch, sleep } = io;
  const write = (stream, text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  try {
    const options = parseOptions(argv);
    if (options.help || options.version) {
      write(stdout, options.help ? USAGE : VERSION);
      return 0;
    }

    // The key is checked before anything is fetched, so a missing key costs no request to WordPress.org either.
    const apiKey = env.TYPESAFE_API_KEY?.trim();
    if (!options.dryRun && !apiKey) {
      throw new UserError(
        "TYPESAFE_API_KEY is not set. Get a key at https://typesafe.ai and export it first, or use --dry-run to see what would be sent.",
      );
    }
    const model = env.TYPESAFE_MODEL?.trim() || DEFAULT_MODEL;
    const tty = Boolean(stderr.isTTY);
    const forum = await readForum(options.slug, {
      pages: options.pages,
      unresolved: options.unresolved,
      fetchImpl,
      timeoutMs: options.timeoutSeconds * 1000,
      sleep,
      onPage: tty ? (page, total) => stderr.write(`\rread feed page ${page} of ${total}${page === total ? "\n" : ""}`) : undefined,
    });
    if (tty && forum.stoppedAfter) stderr.write("\n");
    const meta = {
      version: VERSION,
      slug: options.slug,
      unresolved: options.unresolved,
      pagesAsked: options.pages,
      forum,
      batch: options.batch,
      model,
    };
    const plan = planRequests(forum.threads, { batch: options.batch, model });

    if (options.dryRun) {
      write(stdout, options.json ? JSON.stringify(dryRunJson(plan, meta), null, 2) : formatDryRun(plan, meta));
      return 0;
    }

    const result = await runPlan(plan, {
      threshold: options.threshold,
      apiKey,
      model,
      timeoutSeconds: options.timeoutSeconds,
      fetchImpl,
      onProgress: tty ? (done, total) => stderr.write(`\rasked ${done} of ${total} requests${done === total ? "\n" : ""}`) : undefined,
    });
    write(stdout, options.json ? JSON.stringify(toJson(result, meta), null, 2) : formatReport(result, meta));
    return result.summary.unanswered > 0 ? 1 : 0;
  } catch (error) {
    const known = error instanceof UserError || error instanceof JevError;
    write(stderr, `wporg-forum-triage: ${known ? error.message : `unexpected error: ${error?.message ?? error}`}`);
    return 2;
  }
}
