#!/usr/bin/env node
// OctoScore — scoring fixtures, compact view.
//
//   node examples/score-demo.mjs
//
// Regression set for the scoring model. Every fixture exists to defeat a
// specific failure mode; see REQUIREMENTS.md §13. For the full UI, including
// every tab and state, run:  node examples/panels.mjs
//
// Scoring logic lives in lib.mjs and is not duplicated here.

import { activeRules, evaluate, people, plan, profile } from './lib.mjs';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const cell = (s, n) =>
  String(s).length > n ? `${String(s).slice(0, n - 1)}…` : pad(s, n);
const sgn = (n) => `${n >= 0 ? '+' : ''}${n}`;

const active = activeRules().length;
console.log(
  `\nprofile: ${profile.name}   ${active}/${profile.rules.length} rules active`,
);
console.log(`fetches:  ${[...plan().sources].join(', ')}\n`);

const table = [];

for (const p of people) {
  const { signals, evidence, result } = evaluate(p);
  const engaged = (evidence.replyRate ?? []).length;

  console.log(`${p.login}  ${p.blurb}`);
  console.log(
    `  ${sgn(result.total)} of ${result.maxAchievable} (${pct(result.ratio)})  ·  ${result.band}`,
  );

  for (const g of profile.groups) {
    if (g.importance === 0) continue;
    const ls = result.lines.filter((l) => l.group === g.id);
    if (!ls.length) continue;
    console.log(
      `    ${pad(g.label, 16)} ${padL(sgn(ls.reduce((a, l) => a + l.points, 0)), 5)}`,
    );
    for (const l of ls) {
      const raw =
        l.signal.endsWith('Rate') || l.signal.endsWith('Share')
          ? pct(l.raw)
          : String(l.raw);
      const pts = l.scored ? sgn(l.points) : 'info';
      const ev = l.evidence === 'novel' ? '  ⚠' : '';
      console.log(`      ${padL(pts, 5)}  ${cell(l.label, 46)} ${padL(raw, 8)}${ev}`);
    }
  }

  const missing = ['replyRate', 'proseReplyRate', 'mergeRate', 'linkedIssueRate'].filter(
    (k) => signals[k] == null,
  );
  if (missing.length) console.log(`      insufficient data: ${missing.join(', ')}`);
  console.log();

  table.push({ login: p.login, engaged, total: result.total, band: result.band });
}

console.log('─'.repeat(78));
console.log(`${pad('fixture', 30)}${padL('receipts', 9)}${padL('score', 7)}  band`);
console.log('─'.repeat(78));
for (const r of table) {
  console.log(
    `${pad(r.login, 30)}${padL(r.engaged, 9)}${padL(sgn(r.total), 7)}  ${r.band}`,
  );
}
console.log('─'.repeat(78));
console.log(
  '⚠ = novel signal, not validated in the literature. See REQUIREMENTS.md §11.\n',
);
