# Privacy Policy — OctoScore

Last updated: 2026-02-16

OctoScore is a browser extension that shows a maintainer what happened the last few times
someone reviewed a pull request author's work. It has no backend, no accounts, and no
analytics.

## The short version

Everything the extension stores stays in your browser. The only server it ever contacts is
`api.github.com`, using a token you supply. Nothing is sent to us, because there is no
"us" to send it to — there is no server operated by this project.

## What is stored, and where

All of it lives in your browser's extension storage (`storage.local`), on your machine.

| What | Why | Leaves your machine? |
|---|---|---|
| Your GitHub token | To read public data from the GitHub API on your behalf | Sent **only** to `api.github.com`, as an `Authorization` header |
| The login the token belongs to | So settings can show you which account is connected | No |
| Cached pull request evidence | So opening a second PR doesn't re-read the same history | No |
| Your scoring profile and settings | Your weights, sample window, and repo allowlist | No |
| Last reported API quota | So you can see what the extension is spending | No |

**`storage.local`, never `storage.sync`.** This is deliberate. `storage.sync` would upload
your data — including your token — to Google's or Mozilla's servers and push it down to
every browser you are signed into. OctoScore does not use it for anything, at all.

## What is sent to GitHub

The extension queries GitHub's public GraphQL API for information about the author of the
pull request you are looking at, and about the repository you are looking at it on: their
public pull requests, the public timeline of those pull requests, their public account age
and activity, and the repository's `VOUCHED.td` file if it has one.

These requests go to GitHub, authenticated as you, and are subject to
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
They are ordinary API reads, indistinguishable from you browsing the same pages.

The extension is **strictly read-only**. It never writes to GitHub: no comments, no
reviews, no labels, no stars, nothing.

## What is not collected

- No telemetry, metrics, crash reports, or usage statistics.
- No advertising or tracking identifiers.
- No page content from sites other than the GitHub pull request pages the extension runs on.
- No sharing of anything with any third party, because nothing is transmitted anywhere
  except GitHub.

## Deleting your data

Removing the extension deletes everything it stored, including the token. You should also
revoke the token itself at
[github.com/settings/tokens](https://github.com/settings/tokens), which is the only copy
that exists outside your browser.

Settings offers a reset that clears cached data and your profile without uninstalling.

## Permissions, and why each one is needed

| Permission | Why |
|---|---|
| `storage` | To keep your token, settings, and cache on your machine |
| Access to `github.com/*` | To show the panel on pull request pages |
| Access to `api.github.com/*` | To read the public data the panel is made of |

There is no `tabs` permission, no `<all_urls>`, and no content script on any page that is
not a pull request.

## Data about other people

The extension displays public information about pull request authors — people who are not
the user of the extension and did not install it. That information is read live from
GitHub's public API, is shown only to you, is never aggregated across users, and is never
transmitted anywhere. It is the same data any visitor to those pages could read.

The extension does not attempt to identify anyone beyond the GitHub account they are
already contributing under, and ships with account-age, follower and profile-based signals
disabled by default, because those correlate with characteristics that have been shown to
bias review outcomes.

## Changes

Any change to this policy will be committed to this repository, so the history of what was
promised is public and dated.

## Contact

Open an issue on the repository.
