# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for a security problem.

You will get a reply within seven days. Fixes are released as a new version with a note in the changelog.

## What this project does with your data

- It reads your TypeSafe API key from the `TYPESAFE_API_KEY` environment variable and sends it only to
  `https://api.typesafe.ai` in the `Authorization` header. It never logs, prints or stores the key.
- It sends only the text described in the README's "What leaves your machine" section, and only when you run it
  with a key.
- It reads the plugin's public support feed from `https://wordpress.org` with plain GET requests, on every run
  including `--dry-run`. Nothing but the request itself goes there: no key, no cookies.
- It makes no other network requests: no telemetry, no update checks.

## Supported versions

Only the latest release receives fixes.
