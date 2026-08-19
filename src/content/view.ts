import type { Receipt, SignalsResponse } from '../shared/types';

// ---------------------------------------------------------------------------
// Everything the panel needs to say, derived from one `SignalsResponse`.
//
// Pure and DOM-free so it can be tested without a browser, and so the
// components stay a rendering of this rather than a place where prose gets
// invented. The honesty rules in §11 are enforceable because every claim the
// UI makes is written here, once.
// ---------------------------------------------------------------------------

export type Mark = 'replied' | 'pushed' | 'silent' | 'unreviewed' | 'unknown';

export interface ReceiptRow {
  receipt: Receipt;
  mark: Mark;
  /** Short, literal statement of what the mark means. Never an inference. */
  markLabel: string;
}

/**
 * What we saw, in the order we trust it.
 *
 * `unknown` exists because a truncated timeline cannot prove absence: the reply
 * may be in the events we never fetched. Rendering that as "no reply" is a
 * false accusation, and it is the one mistake this panel must not make. §10.3
 */
export function markOf(r: Receipt): Mark {
  if (!r.reviewerEngaged) return 'unreviewed';
  if (r.authorRepliedAfter) return 'replied';
  if (r.authorPushedAfter) return 'pushed';
  return r.truncated ? 'unknown' : 'silent';
}

const MARK_LABEL: Record<Mark, string> = {
  replied: 'replied',
  pushed: 'pushed',
  silent: 'no reply',
  unreviewed: 'no review',
  unknown: 'not shown',
};

const MARK_TITLE: Record<Mark, string> = {
  replied: 'The author posted a comment after a reviewer engaged.',
  pushed: 'The author pushed commits after review, but posted no comment.',
  silent: 'A reviewer engaged and the author neither replied nor pushed.',
  unreviewed: 'Nobody reviewed this PR, so it says nothing about the author.',
  unknown: 'This PR has more activity than we fetched, so we cannot say.',
};

export interface PanelView {
  headline: string;
  /** null when there is nothing honest to summarise. */
  subhead: string | null;
  rows: ReceiptRow[];
  sampled: number;
  range: string | null;
  /** The project's own latency, shown only when it is the better explanation. */
  projectIsSlow: boolean;
  /** null when nothing was withheld. Never silently omitted. */
  incomplete: string | null;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

export function buildView(data: SignalsResponse): PanelView {
  const receipts = data.evidence.replyRate ?? data.evidence.proseReplyRate ?? [];
  const all = receipts.length ? receipts : [];
  const rows: ReceiptRow[] = all.map((receipt) => {
    const mark = markOf(receipt);
    return { receipt, mark, markLabel: MARK_LABEL[mark] };
  });

  const asked = all.filter((r) => r.reviewerAskedQuestion);
  const answered = asked.filter((r) => r.authorRepliedAfter);

  // Every sentence below states a count we actually observed. No sentence
  // characterises the person, and none may be added that does. §11
  const headline = all.length
    ? `Reviewers engaged on ${all.length} recent ${all.length === 1 ? 'PR' : 'PRs'}.`
    : 'No reviewed PRs found in the window we can see.';

  const subhead = asked.length
    ? `Questions were asked on ${asked.length}; ${data.login} replied on ${answered.length}.`
    : null;

  const dates = all.map((r) => r.createdAt).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const range = first && last ? `${fmt(first)} – ${fmt(last)}` : null;

  // "Slow to reply" and "waited two months for a review" look identical in the
  // author column and mean opposite things (Li et al. 2021). §8
  const projectLatencies = all
    .map((r) => r.projectHoursToFirstReview)
    .filter((h): h is number => h != null);
  const medianProject = median(projectLatencies);

  return {
    headline,
    subhead,
    rows,
    sampled: data.sampled,
    range,
    projectIsSlow: medianProject != null && medianProject > 14 * 24,
    incomplete: incompleteNote(data.withheld),
  };
}

/**
 * Says the sample is short and why. Without this a SAML-restricted org makes a
 * prolific contributor look quiet, and the panel has no way to tell you it is
 * looking at less than it asked for.
 */
function incompleteNote(w: SignalsResponse['withheld']): string | null {
  if (!w || w.count < 1) return null;
  const n = `${w.count} ${w.count === 1 ? 'result' : 'results'}`;
  return w.reason === 'saml'
    ? `${n} hidden: your token is not authorised for a single-sign-on org this ` +
        `author has contributed to. Their record is larger than what is shown.`
    : `${n} hidden: your token cannot read them. Their record is larger than ` +
        `what is shown.`;
}

export function markTitle(m: Mark): string {
  return MARK_TITLE[m];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function humanHours(h: number | null): string {
  if (h == null) return 'never';
  if (h < 1) return '<1h';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
