# Options page

**React and hook rules live in [`../content/AGENTS.md`](../content/AGENTS.md).**
Read that first — all of it applies here, including the two options-specific
rules at the end (one `Profile` in state; saving is an event handler, never an
effect).

## What this page is

The only place a `Profile` is edited. A Profile is **data** — groups, rules,
tiers, bands. Editing it must never require a code change, and this page must
never encode knowledge that belongs in the profile.

## The test for whether a change belongs here

> Could a user achieve this by editing `profile.default.json` by hand?

If yes, this page renders it generically and stays ignorant of it. If no, it
probably should be possible, and the fix is in the schema rather than here.

Concretely: **no signal is named in this file.** No `if (rule.signal === 'replyRate')`.
The page walks `profile.rules`, looks each signal's label up in `SIGNALS`, and
renders the same control for all 21. A signal added tomorrow appears here on its
own. §9.2

## What it may and may not do

| May | May not |
|---|---|
| Import `scoring/` to preview a config change | Import `background/api` |
| Read and write the profile in storage | Fetch signals |
| Validate an imported profile (valibot) | Hold or display the raw token |
| Send the token to background for validation | Call `api.github.com` directly |

The token is entered here and handed straight to the background, which owns the
`viewer { login }` check and the storage write. This page shows the *result* of
validation — never the value, and never a second copy of it.

## Live preview

Changing a weight recomputes from cached payloads with no network call. That is
the whole reward for caching `SourceData` rather than scores, so make sure the
preview actually exercises it: `score(profile, cachedSignals)` and render.

If a preview ever triggers a fetch, the cache layering has broken.

## Resetting

"Reset to defaults" reloads `profile.default.json`. It is one import and one
storage write. Do not hand-maintain a second copy of the defaults in this file.
