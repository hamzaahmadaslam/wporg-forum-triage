# wporg-forum-triage

Reads a plugin's public support forum on WordPress.org, sorts each thread into bug, how-to, feature request,
conflict with another plugin, praise or spam, and lists the threads that are waiting for a reply; for plugin authors
who answer their own forum.

A plugin forum puts crash reports, setup questions, feature requests, thank-you notes and spam in one list, and
WordPress.org only shows whether a topic is resolved and how many replies it has. Finding the unanswered bug reports
means opening every thread. A search for words such as "error" misses bug reports that describe the problem in other
words and finds how-to questions that quote an error message. A text-generating model can judge the difference, but
it returns prose to parse and no measure of how sure it is. wporg-forum-triage asks narrow multiple-choice and yes/no
questions and gets probabilities back, so code does the sorting and the threads it cannot place with confidence go
to a review list.

## How it uses Jev

Jev is TypeSafe AI's System One model: it answers typed questions with probabilities and writes no text.

The tool reads the forum's feed, then sends the threads to Jev in groups of up to 5 (`--batch`). Jev sees each thread
as its title and its first post, nothing else:

```json
{ "threads": [{ "title": "Fatal error after updating to 2.4.0", "first_post": "After updating to 2.4.0 the dashboard shows [...]" }] }
```

For every thread it asks three questions, which point at the thread by its position in the state:

| Question                                                                        | Type   | What it decides                                                                                     |
| ------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| What kind of topic is `threads[2]`?                                             | choice | bug, how-to, feature-request, conflict-with-another-plugin, praise, spam or other                   |
| Does `threads[2]` need a reply from the people who make the plugin?             | noul   | whether the thread waits for you                                                                    |
| Does `threads[2]` say that its problem is solved or its question is answered?   | noul   | whether a thread that nobody marked resolved says it is solved, for example in an edit to the post  |

Bug, how-to and conflict-with-another-plugin are easy to confuse, so their descriptions also say what they are not
for. `other` takes threads that fit none of the six kinds (pricing, licenses, "is this still maintained?") instead of
forcing them into one. The full wording is in `src/triage.mjs`, and `--dry-run --json` prints every request body. At
the default batch size that is 15 questions per request.

Code makes every decision with one threshold, `--threshold` (default 0.8). A kind counts when its confidence is at
least the threshold. A yes/no answer counts as yes at or above the threshold and as no at or below 1 minus the
threshold. Then each thread gets a status:

| Status          | When                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| resolved        | the forum marks the topic resolved; this always wins, and these threads are counted, not listed         |
| looks resolved  | not marked resolved, but the post says the problem is solved                                             |
| no reply needed | the post needs no answer from you, such as praise or spam                                                |
| unanswered      | it needs your answer and has no replies yet                                                              |
| N replies       | it needs your answer and already has replies; the feed does not show who wrote them                     |
| unclear         | a yes/no answer fell between the limits                                                                  |

A thread goes to the review list when its status is unclear or its kind is below the threshold. It keeps a clear
status there, so an unanswered thread whose kind is unclear still counts as unanswered. The report groups the other
threads that are not resolved by kind, bugs first, with the unanswered ones first in each group and the oldest first
within each status. Probabilities are printed next to every thread. Every word in the report comes from the feed or
from fixed text in the code.

## Install

Needs Node.js 20 or later. There are no dependencies.

```sh
npm install -g github:hamzaahmadaslam/wporg-forum-triage
```

## Usage

```sh
export TYPESAFE_API_KEY=<your-key>
wporg-forum-triage <plugin-slug>
```

In PowerShell, set the key with `$env:TYPESAFE_API_KEY = "<your-key>"`. The slug is the part after `/plugins/` in
the plugin's WordPress.org address: for `https://wordpress.org/plugins/hello-dolly/` it is `hello-dolly`.

```sh
wporg-forum-triage hello-dolly --dry-run          # read the feed, print the questions and a token estimate; send nothing to TypeSafe
wporg-forum-triage hello-dolly --unresolved       # the forum's unresolved topics instead of the newest topics
wporg-forum-triage hello-dolly --json > triage.json
wporg-forum-triage hello-dolly --threshold 0.9    # stricter: more threads go to review
```

| Option                | Default | What it does                                                                                           |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `--pages <n>`         | `1`     | Feed pages to read, 1 to 10, one request per page with a 2-second pause between pages. See below.      |
| `--unresolved`        | off     | Read the forum's unresolved topics feed instead of the newest topics feed.                              |
| `--threshold <p>`     | `0.8`   | Confidence needed to act on an answer. Above 0.5, at most 1.                                            |
| `--batch <n>`         | `5`     | Threads per TypeSafe request, 1 to 30.                                                                  |
| `--timeout <seconds>` | `10`    | Time limit for each request. TypeSafe rate limits (429) and overload (529) are retried three times.     |
| `--json`              | off     | Print JSON: every thread, its kind and status, and the raw probabilities.                               |
| `--dry-run`           | off     | Read the feed, then print the threads, one thread's questions and the token estimate. Needs no key.    |

Environment: `TYPESAFE_API_KEY` (needed unless `--dry-run`) and `TYPESAFE_MODEL` (default `jev-latest`).

Exit codes: `0` when no thread is unanswered, `1` when at least one is, so a scheduled job can alert you, and `2` on
an error. A thread whose status is unclear does not count as unanswered.

### Which threads it reads

WordPress.org publishes these feeds for every plugin forum:

- `https://wordpress.org/support/plugin/<slug>/feed/`, the newest topics (the default);
- `https://wordpress.org/support/plugin/<slug>/unresolved/feed/`, the newest topics not marked resolved
  (`--unresolved`).

On 2026-09-26 each listed the 30 newest topics, newest first, with the title, the first post, the reply count and
the resolved marker. Sticky topics are not in them. `--pages N` asks for `?paged=2` up to `?paged=N`, but on
2026-09-26 WordPress.org answered `?paged=2` with the first page again. The tool stops at the first page that brings
no new thread and says so, so today it asks at most twice. To reach older open threads, use `--unresolved`: its list
leaves out resolved topics, so it reaches further back than the newest topics.

## Example

`examples/feed.xml` is a made-up feed for a made-up plugin, "Tidy Backups Demo", with twelve made-up threads in the
format WordPress.org uses. The probabilities come from `examples/fixture-answers.json`: they were written by hand for
the tests, not recorded from TypeSafe, and show the report format. Your numbers will differ.
`node examples/run.mjs` prints this report without a key or a network call.

```text
wporg-forum-triage: 12 threads from the tidy-backups-demo support forum (newest topics feed, 1 page)
Model jev-1.13.0, 3 requests, 7,693 input tokens, threshold 0.8

Needs your reply: 4 unanswered (1 bug), 2 already with replies
Not resolved: bug 2, conflict-with-another-plugin 1, how-to 2, feature-request 1, praise 1, spam 1, review 2
Marked resolved on the forum: 2 (not listed)

bug (2)
  unanswered: Fatal error after updating to 2.4.0
      opened 2026-09-25, 0 replies | bug 0.95 (confidence 0.94) | needs a reply 0.97 | says solved 0.02
      https://wordpress.org/support/topic/tidy-backups-demo-fatal-error-after-updating-to-2-4-0/
  2 replies: Scheduled backup did not run last night
      opened 2026-09-21, 2 replies | bug 0.92, how-to 0.05 (confidence 0.91) | needs a reply 0.94 | says solved 0.05
      https://wordpress.org/support/topic/tidy-backups-demo-scheduled-backup-did-not-run-last-night/

conflict-with-another-plugin (1)
  unanswered: Backups stop when a page cache plugin is active
      opened 2026-09-24, 0 replies | conflict-with-another-plugin 0.90, bug 0.09 (confidence 0.88) | needs a reply 0.95 | says solved 0.03
      https://wordpress.org/support/topic/tidy-backups-demo-backups-stop-when-a-page-cache-plugin-is-active/

how-to (2)
  1 reply: How do I exclude the uploads folder?
      opened 2026-09-16, 1 reply | how-to 0.95 (confidence 0.94) | needs a reply 0.93 | says solved 0.06
      https://wordpress.org/support/topic/tidy-backups-demo-how-do-i-exclude-the-uploads-folder/
  looks resolved: Where are the backup files stored?
      opened 2026-09-20, 0 replies | how-to 0.93, other 0.05 (confidence 0.92) | needs a reply 0.12 | says solved 0.91
      https://wordpress.org/support/topic/tidy-backups-demo-where-are-the-backup-files-stored/

feature-request (1)
  unanswered: Please add Dropbox as a storage option
      opened 2026-09-24, 0 replies | feature-request 0.97 (confidence 0.97) | needs a reply 0.88 | says solved 0.02
      https://wordpress.org/support/topic/tidy-backups-demo-please-add-dropbox-as-a-storage-option/

praise (1)
  no reply needed: Saved my site today, thank you
      opened 2026-09-19, 0 replies | praise 0.98 (confidence 0.98) | needs a reply 0.08 | says solved 0.10
      https://wordpress.org/support/topic/tidy-backups-demo-saved-my-site-today-thank-you/

spam (1)
  no reply needed: Cheap hosting coupons
      opened 2026-09-18, 0 replies | spam 0.97 (confidence 0.97) | needs a reply 0.03 | says solved 0.02
      https://wordpress.org/support/topic/tidy-backups-demo-cheap-hosting-coupons/

review (2)
  unanswered, kind unclear: Is this plugin still maintained?
      opened 2026-09-23, 0 replies | other 0.50, how-to 0.34, bug 0.10 (confidence 0.42) | needs a reply 0.90 | says solved 0.04
      https://wordpress.org/support/topic/tidy-backups-demo-is-this-plugin-still-maintained/
  unclear if it needs a reply, unclear if solved: Restore worked on the second try
      opened 2026-09-15, 0 replies | bug 0.86, how-to 0.12 (confidence 0.84) | needs a reply 0.64 | says solved 0.55
      https://wordpress.org/support/topic/tidy-backups-demo-restore-worked-on-the-second-try/

unanswered: no replies yet, and confident answers say the post needs a reply from you.
N replies: the post needs a reply from you and already has replies; the feed does not show who wrote them.
looks resolved: the post says the problem is solved, but the topic is not marked resolved.
review: an answer was not confident enough (threshold 0.8). Read these threads yourself.
```

The fatal error, the page cache conflict and the Dropbox request have no replies and clearly need one. "Where are the
backup files stored?" ends with "Edit: found them under Settings > Storage", so it looks resolved although nobody
marked it. "Is this plugin still maintained?" needs a reply, but its kind is split between other and how-to, and
"Restore worked on the second try" sits near the middle on both yes/no questions, so both go to review. The same run
with `--json` is in `examples/report.json`, and the dry run in `examples/dry-run.txt`.

## What leaves your machine

To `wordpress.org`, on every run, `--dry-run` included:

- one GET request per feed page, to the addresses above, with the User-Agent
  `wporg-forum-triage/1.0.0 (+https://github.com/hamzaahmadaslam/wporg-forum-triage)`. No key and no cookies are
  sent. Redirects are followed only within `https://wordpress.org`.

To `https://api.typesafe.ai/v1/systemone`, only when you run it with a key and without `--dry-run`:

- the title and the first post of each thread, as plain text, up to 5 threads per request (`--batch`); a first post
  longer than 4,000 characters is sent as about its first 3,000 and last 1,000 characters, and a title longer than
  300 characters is cut to 300;
- the fixed question text, which names threads only by position (`threads[2]`), question ids such as `t7_kind`, and
  the model name;
- your API key, in the `Authorization` header.

Thread addresses, dates, reply counts, resolved markers and the plugin slug are not sent to TypeSafe. The tool does
not read user names from the feed at all. It writes nothing to disk and makes no other network requests, for
telemetry, updates or anything else.

## Limits

- The feed has each thread's first post and reply count, not the replies. "N replies" means someone replied: you,
  another user, or the person who asked. Check those threads. "looks resolved" and "no reply needed" judge the first
  post only, including any edit its author made to it.
- The feeds list only the newest topics (30 on 2026-09-26), and WordPress.org ignored the page number on them, so on
  a busy forum older threads are out of reach except through `--unresolved`. Sticky topics are never in the feeds.
- Only the English forums at `wordpress.org` are read; localized forums, such as the one at `de.wordpress.org`, are
  not. Jev is also most accurate in English.
- Anyone can post in a support forum. Text written to steer a model, such as a post that describes itself as praise,
  can move Jev's answers.
- Each thread gets one kind. A post that reports a bug and asks for a feature gets the likelier one; the
  probabilities show the other.
- The tool reads and reports. It never posts, replies, marks topics resolved or signs in to WordPress.org. Treat the
  kinds as suggestions, read the review list yourself, and check a sample against your own forum before you rely on
  a threshold.

## Token use

The three questions add about 590 input tokens per thread, so for short posts most of the tokens are the questions.
By the tool's own estimate (four characters per token):

| Run                                                                  | Requests | Input tokens      |
| -------------------------------------------------------------------- | -------- | ----------------- |
| The example: 12 threads                                              | 3        | about 7,700       |
| A real plugin's newest topics feed on 2026-09-26: 30 threads         | 6        | about 22,200      |
| One feed of 30 threads with first posts of about 1,000 characters    | 6        | about 25,700      |
| The same feed of 30 threads with every first post at the 4,000 limit | 6        | about 48,200      |
| The 1,000-character feed read once a day for a year                  | 2,190    | about 9.4 million |

`--dry-run` prints the estimate for your own forum without sending anything to TypeSafe.

## License

MIT. Made by [Hamza Ahmad Aslam](https://hamzaahmadaslam.com), WordPress and web performance engineer.
