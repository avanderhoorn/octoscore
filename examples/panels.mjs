#!/usr/bin/env node
// OctoScore — every pane, tab and state the extension can render.
//
//   node examples/panels.mjs            all panes
//   node examples/panels.mjs overlay    just the PR overlay
//   node examples/panels.mjs options    just the options page
//
// This is the spec for content/panel.ts and options/options.html. Rendering is
// pure: it takes (person, signals, result) and returns a string. No network,
// no clock, no DOM. Swapping this text renderer for DOM nodes is the only work
// needed to make it real.

import { activeRules, byLogin, evaluate, profile, repoMirror } from './lib.mjs';

const W = 68;

const disp = (s) => [...String(s)].length;
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - disp(s)));
const cell = (s, n) =>
  disp(s) > n ? `${[...String(s)].slice(0, n - 1).join('')}…` : pad(s, n);
const padL = (s, n) => ' '.repeat(Math.max(0, n - disp(s))) + String(s);

const top = (t = '') => `┌─ ${t} ${'─'.repeat(Math.max(0, W - disp(t) - 3))}┐`;
const mid = () => `├${'─'.repeat(W)}┤`;
const bot = () => `└${'─'.repeat(W)}┘`;
const row = (s = '') => `│ ${cell(s, W - 2)} │`;
const gap = () => row('');
const rule = () => `│ ${'·'.repeat(W - 2)} │`;

const wrap = (s, n) => {
  const out = [''];
  for (const word of String(s).split(' ')) {
    if (disp(`${out.at(-1)} ${word}`.trim()) > n) out.push(word);
    else out[out.length - 1] = `${out.at(-1)} ${word}`.trim();
  }
  return out;
};
const para = (s, indent = 0) =>
  wrap(s, W - 2 - indent).map((l) => row(' '.repeat(indent) + l));

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const days = (h) =>
  h == null ? 'never' : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
const sgn = (n) => `${n >= 0 ? '+' : ''}${n}`;

// ── tab bar ───────────────────────────────────────────────────────────────
// Receipts is always the default tab. FR2 says the score is never rendered
// above the receipt list; a tab bar satisfies that as long as Receipts opens
// first and the score is never the landing view.
const tabs = (active, names = ['Receipts', 'Score', 'Project']) => {
  const left = names.map((n) => (n === active ? `[ ${n} ]` : `  ${n}  `)).join('');
  return `│ ${pad(left, W - 9)}↻  ⚙  ✕ │`;
};

const mark = (r) =>
  !(r.authorRepliedAfter || r.authorPushedAfter)
    ? '✗ no reply'
    : r.authorReplyWasProse
      ? '✓ replied '
      : '~ pushed  ';

// ══════════════════════════════════════════════════════════════════════════
// A. PR overlay
// ══════════════════════════════════════════════════════════════════════════

// A0 — collapsed. The whole tool in one line, for maintainers who don't want a panel.
export function collapsed(person) {
  const { evidence, result } = evaluate(person);
  const e = evidence.replyRate ?? [],
    a = evidence.proseReplyRate ?? [];
  const gist =
    e.length === 0
      ? 'no review history'
      : `answered ${a.filter((r) => r.authorReplyWasProse).length}/${a.length} questions`;
  const name = person.login;
  const s = e.length === 0 ? '' : `  ${sgn(result.total)}`;
  return (
    '┌' +
    '─'.repeat(W) +
    '┐\n' +
    '│ ' +
    cell(`◆ ${name} · ${gist}`, W - 20) +
    padL(s.trim(), 8) +
    '  expand ▾ │\n' +
    '└' +
    '─'.repeat(W) +
    '┘'
  );
}

// A1 — Receipts tab. The product.
export function tabReceipts(person) {
  const { evidence, result } = evaluate(person);
  const e = evidence.replyRate ?? [],
    a = evidence.proseReplyRate ?? [];
  const out = [top('OctoScore'), tabs('Receipts'), mid()];

  const vouch = result.lines.find((l) => l.group === 'vouch');
  if (vouch) {
    out.push(row(`★ ${vouch.label}`));
    out.push(gap());
  }

  out.push(
    ...para(
      a.length
        ? `Reviewers asked questions on ${a.length} recent PRs. ` +
            `${person.login} replied on ${a.filter((r) => r.authorReplyWasProse).length}.`
        : `${e.length} recent PRs got reviewer feedback.`,
    ),
  );
  out.push(gap());

  for (const r of e.slice(0, 6)) {
    out.push(
      '│ ' +
        cell(
          `${mark(r)}  ${pad(r.prTitle, 30)} ${r.repo}#${r.prUrl.split('/').pop()}`,
          W - 4,
        ) +
        ' ↗ │',
    );
    if (r.projectHoursToFirstReview != null && r.projectHoursToFirstReview > 168) {
      out.push(
        row(
          `            author ${days(r.hoursToAuthorResponse)} · ` +
            `project ${days(r.projectHoursToFirstReview)} to first review`,
        ),
      );
    }
  }

  out.push(gap(), rule());
  // The number of receipts we actually READ, not the window and not a PR count
  // from elsewhere. Saying "based on 15" while showing 6 rows is the kind of
  // small dishonesty this panel exists to avoid.
  out.push(row(`Based on ${person.receipts.length} PRs · Mar 2024 – Jul 2026`));
  out.push(`│ ${pad(`${result.band}`, W - 14)}${padL(`${sgn(result.total)} ▸`, 12)} │`);
  out.push(bot());
  return out.join('\n');
}

// A2 — Score tab. Every number that produced the total, and nothing hidden.
export function tabScore(person) {
  const { result } = evaluate(person);
  const out = [top('OctoScore'), tabs('Score'), mid()];

  out.push(
    row(
      `${sgn(result.total)} of ${result.maxAchievable} possible ` +
        `(${pct(result.ratio)}) — ${result.band}`,
    ),
  );
  out.push(gap());

  for (const g of profile.groups) {
    if (g.importance === 0) continue;
    const ls = result.lines.filter((l) => l.group === g.id);
    if (!ls.length) continue;
    const sub = ls.reduce((a, l) => a + l.points, 0);
    out.push(`│ ${pad(`${g.label}   ×${g.importance}`, W - 8)}${padL(sgn(sub), 6)} │`);
    for (const l of ls) {
      const raw =
        l.signal.endsWith('Rate') || l.signal.endsWith('Share')
          ? pct(l.raw)
          : l.signal === 'medianResponseHours'
            ? days(l.raw)
            : String(l.raw);
      out.push(
        '│   ' +
          cell(l.label, W - 20) +
          padL(cell(raw, 9).trimEnd(), 9) +
          padL(l.scored ? sgn(l.points) : 'info', 7) +
          ' │',
      );
      if (l.evidence === 'novel')
        out.push(row('     ⚠ novel signal — not validated, see §11'));
    }
    out.push(gap());
  }

  // Comes off the result, derived from active rules. The earlier hardcoded list
  // of four signal names was both a config-not-code violation and a leak of raw
  // camelCase identifiers into copy a maintainer has to read.
  const missing = result.unmeasured;
  if (missing.length) {
    out.push(rule());
    out.push(
      ...para(
        `Not enough data to judge: ${missing.join(', ')}. ` +
          `These contribute nothing rather than defaulting to a middle value.`,
      ),
    );
  }
  out.push(bot());
  return out.join('\n');
}

// A3 — Project tab. The mirror (§8). The only tab that is about the reader.
export function tabProject(person) {
  const { signals } = evaluate(person);
  const m = repoMirror;
  const noRespPct = m.firstTimerPrsNoResponse / m.firstTimerPrsTotal;
  const out = [top('OctoScore'), tabs('Project'), mid()];

  out.push(row(`${m.nameWithOwner} — your repo, last ${m.windowDays} days`));
  out.push(gap());
  out.push(
    '│ ' +
      pad('Median time to first review', W - 12) +
      padL(days(m.medianHoursToFirstReview), 10) +
      ' │',
  );
  out.push(
    '│ ' +
      pad('First-timer PRs with no human reply', W - 12) +
      padL(`${pct(noRespPct)}`, 10) +
      ' │',
  );
  out.push(row(`  (${m.firstTimerPrsNoResponse} of ${m.firstTimerPrsTotal})`));
  out.push(
    '│ ' +
      pad('Open PRs awaiting a maintainer', W - 12) +
      padL(String(m.openPrsAwaitingMaintainer), 10) +
      ' │',
  );
  out.push(gap(), rule());

  const med = signals.medianResponseHours;
  out.push(
    ...para(
      med != null && med < m.medianHoursToFirstReview
        ? `For comparison: this author replied in a median of ${days(med)}, ` +
            `while this project takes ${days(m.medianHoursToFirstReview)} to first review.`
        : `Li et al. 2021 found PR abandonment is primarily caused by maintainer ` +
            `unresponsiveness rather than author disengagement.`,
    ),
  );
  out.push(gap());
  out.push(
    ...para('Shown because the contributor is only half of whether a review converges.'),
  );
  out.push(bot());
  return out.join('\n');
}

// A4 — no-read. No score, no band, no implication of risk.
export function stateNoRead(person) {
  const { result } = evaluate(person);
  const vouch = result.lines.find((l) => l.group === 'vouch');
  const out = [top('OctoScore'), tabs('Receipts'), mid()];
  if (vouch) {
    out.push(row(`★ ${vouch.label}`));
    out.push(gap());
  }
  out.push(row('No review history to show.'));
  out.push(
    ...para(
      "Nobody has reviewed this author's recent PRs, so there is nothing to report. This is normal for new contributors.",
    ),
  );
  out.push(gap(), rule());
  out.push(row('Track record is on the Score tab.'));
  out.push(bot());
  return out.join('\n');
}

// A5 — error. Always names the cause and the fix.
export function stateError(kind) {
  const cases = {
    'no-token': [
      'No GitHub token configured.',
      'OctoScore needs a read-only token to query the API.',
      'Open settings →',
    ],
    expired: [
      'Token rejected (401).',
      'The token is expired or was revoked.',
      'Update it in settings →',
    ],
    scope: [
      'Token lacks access to acme/core.',
      'Fine-grained tokens are bound to one resource owner.',
      'See token setup →',
    ],
    rate: [
      'GitHub rate limit reached.',
      'Resets at 14:20. Cached results are still shown, marked stale.',
      'Retry ↻',
    ],
    network: ['Could not reach api.github.com.', 'Check your connection.', 'Retry ↻'],
  };
  const [head, detail, action] = cases[kind];
  const out = [top('OctoScore'), tabs('Receipts'), mid()];
  out.push(row(`⚠ ${head}`));
  out.push(gap());
  out.push(...para(detail));
  out.push(gap());
  out.push(row(action));
  out.push(bot());
  return out.join('\n');
}

// A6 — bot author. No panel, no score. FR7.
export function stateBot(login) {
  const out = [top('OctoScore'), mid()];
  out.push(row(`${login} is an automated account.`));
  out.push(
    ...para('Follow-through signals do not apply. Review the change on its own terms.'),
  );
  out.push(bot());
  return out.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// B. Options page
// ══════════════════════════════════════════════════════════════════════════

export function optionsToken() {
  const out = [top('OctoScore — Settings'), mid()];
  out.push(row('TOKEN'));
  out.push(gap());
  out.push(row('  ( • ) Public repositories only        recommended'));
  out.push(row('        Fine-grained PAT, "Public Repositories (read-only)".'));
  out.push(row('        Works on any public repo.'));
  out.push(gap());
  out.push(row('  (   ) Private or multiple orgs'));
  out.push(row('        Fine-grained tokens bind to ONE resource owner, so'));
  out.push(row('        this needs a classic PAT with repo:read.'));
  out.push(gap());
  out.push(row('  ┌────────────────────────────────────────────────┐'));
  out.push(row('  │ github_pat_••••••••••••••••••••••••••••        │'));
  out.push(row('  └────────────────────────────────────────────────┘'));
  out.push(row('  ✓ Valid — authenticated as @anthony      [ Validate ]'));
  out.push(gap());
  out.push(
    ...para(
      'Stored in storage.local. Never synced. Sent only to api.github.com, and never exposed to the content script or the page.',
    ),
  );
  out.push(bot());
  return out.join('\n');
}

export function optionsWeights() {
  const out = [top('OctoScore — Settings'), mid()];
  out.push(row('SIGNAL GROUPS'));
  out.push(
    ...para(
      'Importance multiplies every rule in the group. Set 0 to disable the group — its API calls are then skipped entirely.',
    ),
  );
  out.push(gap());
  for (const g of profile.groups) {
    const n = activeRules().filter((r) => r.group === g.id).length;
    const bar =
      '█'.repeat(Math.round(g.importance * 10)) +
      '░'.repeat(10 - Math.round(g.importance * 10));
    out.push(
      '│ ' +
        pad(`  ${g.label}`, 22) +
        pad(`${bar}`, 12) +
        pad(`×${g.importance.toFixed(1)}`, 7) +
        cell(
          `${n} rule${n === 1 ? '' : 's'}${g.aboveFold ? ' · above fold' : ''}`,
          W - 43,
        ) +
        ' │',
    );
  }
  out.push(gap(), rule());
  out.push(row('RULES — followThrough'));
  out.push(gap());
  for (const r of profile.rules.filter((x) => x.group === 'followThrough')) {
    const box = { off: '[ ]', info: '[i]', score: '[x]' }[r.mode];
    const range =
      r.scored === false
        ? 'info only'
        : `${sgn(Math.min(...r.tiers.map((t) => t.points)))} … ${sgn(Math.max(...r.tiers.map((t) => t.points)))}`;
    out.push(`│ ${pad(`  ${box} ${r.id}`, W - 14)}${padL(range, 12)} │`);
    if (r.evidence === 'novel')
      out.push(row('        ⚠ novel — not validated in the literature'));
  }
  out.push(gap());
  out.push(row('  [x] scored   [i] informational   [ ] off'));
  out.push(bot());
  return out.join('\n');
}

export function optionsData() {
  const out = [top('OctoScore — Settings'), mid()];
  out.push(row('DATA'));
  out.push(gap());
  out.push(
    '│ ' +
      pad('  Cache TTL', 30) +
      pad('6 hours', 14) +
      cell('◀ ─────●──── ▶', W - 46) +
      ' │',
  );
  out.push(
    '│ ' +
      pad('  PRs sampled per author', 30) +
      pad('15', 14) +
      cell('◀ ──●─────── ▶', W - 46) +
      ' │',
  );
  out.push(
    ...para(
      'At 15, an author needs 4 reviewed PRs before follow-through is scored at all. On a low-volume repo, raise this — otherwise good contributors show no score. Costs ~1 API point per 5 PRs.',
      2,
    ),
  );
  out.push(gap());
  out.push(`│ ${pad('  Cache size', 30)}${cell('412 KB · 96 authors', W - 32)} │`);
  out.push(gap());
  out.push(row('  [ Clear cache ]   [ Export profile ]   [ Import profile ]'));
  out.push(row('  [ Reset to defaults ]'));
  out.push(gap(), rule());
  out.push(row('PRIVACY'));
  out.push(
    ...para(
      'No telemetry. No backend. No data leaves this machine except requests to api.github.com. Read-only: the extension never writes to GitHub.',
    ),
  );
  out.push(bot());
  return out.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════

const H = (t) => `\n\n${'═'.repeat(W + 2)}\n  ${t}\n${'═'.repeat(W + 2)}\n`;
const L = (t) => `\n  ${t}\n`;

const which = process.argv[2] ?? 'all';
const show = (s) => which === 'all' || which === s;

if (show('overlay')) {
  console.log(H('A. PR OVERLAY — github.com/acme/core/pull/1042'));

  console.log(L('A0 · collapsed — the entire tool in one line'));
  console.log(collapsed(byLogin('sustained-maintainer')));
  console.log(collapsed(byLogin('looks-active-never-engages')));
  console.log(collapsed(byLogin('genuine-newcomer')));

  console.log(L('A1 · Receipts tab — the default view, and the product'));
  console.log(tabReceipts(byLogin('looks-active-never-engages')));

  console.log(L('A1b · Receipts — where the PROJECT is the problem'));
  console.log(tabReceipts(byLogin('stalled-by-the-project')));

  console.log(L('A1c · Receipts — vouched newcomer (vouch shows above the fold)'));
  console.log(
    tabReceipts(byLogin('vouched-newcomer')).split('\n').slice(0, 8).join('\n'),
  );

  console.log(L('A2 · Score tab — every number that produced the total'));
  console.log(tabScore(byLogin('pushes-but-never-explains')));

  console.log(L('A2b · Score — the inflation case, called out rather than penalised'));
  console.log(tabScore(byLogin('self-merge-inflated')));

  console.log(L('A3 · Project tab — the mirror. The only tab about the reader.'));
  console.log(tabProject(byLogin('stalled-by-the-project')));

  console.log(L('A4 · no-read state — no score, no band, no implication of risk'));
  console.log(stateNoRead(byLogin('genuine-newcomer')));

  console.log(L('A5 · error states — always name the cause and the fix'));
  for (const k of ['no-token', 'expired', 'scope', 'rate']) console.log(stateError(k));

  console.log(L('A6 · bot author'));
  console.log(stateBot('dependabot[bot]'));
}

if (show('options')) {
  console.log(H('B. OPTIONS PAGE'));
  console.log(L('B1 · Token'));
  console.log(optionsToken());
  console.log(L('B2 · Weights — config, not code'));
  console.log(optionsWeights());
  console.log(L('B3 · Data & privacy'));
  console.log(optionsData());
}

console.log();
