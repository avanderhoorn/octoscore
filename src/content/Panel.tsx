import { useEffect, useState } from 'react';
import { channelErrorCode, openOptions, sendSignalsRequest } from '../shared/messaging';
import type { ErrorCode, ScoreLine, SignalsResponse } from '../shared/types';
import type { PrContext } from './mount';
import { buildView, humanHours, markTitle } from './view';

// ---------------------------------------------------------------------------
// The panel. Read src/content/AGENTS.md before changing this file.
//
// One effect, and it does I/O. Everything else is derived during render.
// ---------------------------------------------------------------------------

type View = { status: 'loading' } | { status: 'ready'; data: SignalsResponse };

/**
 * The only effect in the content script.
 *
 * The two guards are not belt-and-braces. GitHub navigates with Turbo, so the
 * panel is NOT remounted between PRs: without the identity check an in-flight
 * response for the previous PR lands under the current one, attributing one
 * contributor's record to another. That is the worst failure this tool can
 * have, and it is silent.
 */
function useSignals(ctx: PrContext, nonce: number): View {
  // Destructured so the dependency array holds primitives. Depending on `ctx`
  // itself would refetch whenever the parent handed us a new object with the
  // same contents, which is every Turbo render.
  const { repo, prNumber } = ctx;
  const [view, setView] = useState<View>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setView({ status: 'loading' });

    sendSignalsRequest({ repo, prNumber, refresh: nonce > 0 })
      .then((data) => {
        if (!live || data.repo !== repo || data.prNumber !== prNumber) return;
        setView({ status: 'ready', data });
      })
      .catch((e: unknown) => {
        if (!live) return;
        const code = channelErrorCode(e);
        setView({
          status: 'ready',
          // The browser's own text is dropped for `disconnected`: it describes
          // a message channel, which is not something the reader can act on.
          data: errorView(
            { repo, prNumber },
            code,
            code === 'network' ? (e instanceof Error ? e.message : String(e)) : undefined,
          ),
        });
      });

    return () => {
      live = false;
    };
  }, [repo, prNumber, nonce]);

  return view;
}

const errorView = (
  ctx: PrContext,
  code: ErrorCode,
  detail?: string,
): SignalsResponse => ({
  state: 'error',
  login: '',
  repo: ctx.repo,
  prNumber: ctx.prNumber,
  signals: {},
  evidence: {},
  result: null,
  sampled: 0,
  fetchedAt: Date.now(),
  stale: false,
  withheld: null,
  error: detail === undefined ? { code } : { code, detail },
});

type Tab = 'receipts' | 'score' | 'project';

export function Panel({ ctx }: { ctx: PrContext }) {
  // State the USER creates, and nothing else.
  const [tab, setTab] = useState<Tab>('receipts');
  const [open, setOpen] = useState(true);
  const [nonce, setNonce] = useState(0);

  const view = useSignals(ctx, nonce);

  if (!open) {
    return (
      <div className="os-bar">
        <button type="button" className="os-link" onClick={() => setOpen(true)}>
          Show OctoScore
        </button>
      </div>
    );
  }

  return (
    <section className="os" aria-label="OctoScore contributor evidence">
      <header className="os-head">
        <strong className="os-title">OctoScore</strong>
        <div className="os-tabs" role="tablist" aria-label="OctoScore views">
          {(['receipts', 'score', 'project'] as const).map((t) => (
            <button
              type="button"
              key={t}
              role="tab"
              aria-selected={t === tab}
              className={t === tab ? 'os-tab os-tab-on' : 'os-tab'}
              onClick={() => setTab(t)}
            >
              {t === 'receipts' ? 'Receipts' : t === 'score' ? 'Score' : 'Project'}
            </button>
          ))}
        </div>
        <div className="os-actions">
          {/*
            The glyph is the accessible name unless something overrides it, and
            "clockwise open circle arrow" is what a screen reader would read
            out. `title` does not help: visible text wins over it. So the label
            is explicit and the decoration is hidden.
          */}
          <button
            type="button"
            className="os-icon"
            aria-label="Refresh"
            title="Refetch, ignoring the cache"
            onClick={() => setNonce((n) => n + 1)}
          >
            <span aria-hidden="true">↻</span>
          </button>
          <button
            type="button"
            className="os-icon"
            aria-label="Hide panel"
            title="Hide until the next page load"
            onClick={() => setOpen(false)}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      </header>

      {view.status === 'loading' ? (
        <p className="os-note">Reading this author’s recent review history…</p>
      ) : (
        <Body data={view.data} tab={tab} />
      )}
    </section>
  );
}

function Body({ data, tab }: { data: SignalsResponse; tab: Tab }) {
  if (data.state === 'bot') {
    // Not "looks like a bot": that hedge was honest when this was a guess from
    // the login, and dishonest now that GitHub reports the account type. The
    // second sentence says why there is nothing here rather than leaving an
    // empty panel that reads as "no track record". FR7
    return (
      <p className="os-note">
        {data.login} is an automated account. Receipts describe how a person responds to
        review, which does not apply here.
      </p>
    );
  }
  if (data.state === 'no-read') {
    return <p className="os-note">This repo is not in your allowlist.</p>;
  }
  if (data.state === 'error') {
    return <ErrorNote data={data} />;
  }

  return (
    <>
      {data.stale ? (
        <p className="os-stale">
          Showing cached evidence from {new Date(data.fetchedAt).toLocaleString()} — the
          latest fetch did not succeed.
        </p>
      ) : null}
      {tab === 'receipts' ? <Receipts data={data} /> : null}
      {tab === 'score' ? <Score data={data} /> : null}
      {tab === 'project' ? <Project data={data} /> : null}
    </>
  );
}

const ERROR_HELP: Record<ErrorCode, string> = {
  'no-token': 'Add a GitHub token to see this contributor’s record.',
  'no-author':
    'GitHub reports no author for this pull request — the account may have been deleted.',
  'token-invalid': 'GitHub rejected the token. Replace it in settings.',
  'token-scope':
    'The token cannot read this resource owner. Fine-grained tokens are scoped to one owner.',
  'rate-limited': 'GitHub rate limit reached. This resolves on its own.',
  network: 'Could not reach api.github.com.',
  disconnected: 'OctoScore was updated or reloaded. Refresh this page to reconnect it.',
  crashed:
    'OctoScore itself failed here — this is a bug in the extension, not a problem with GitHub or this contributor.',
};

// The errors a maintainer fixes in settings. Telling someone to add a token
// and then leaving them to find chrome://extensions on their own is a dead end.
const FIXED_IN_SETTINGS = new Set<ErrorCode>([
  'no-token',
  'token-invalid',
  'token-scope',
]);

/**
 * One sentence saying what to do, and GitHub's own words underneath only when
 * they add something. `ERROR_HELP` is keyed by `ErrorCode`, so adding a code
 * without copy for it is a type error rather than a blank panel.
 */
function ErrorNote({ data }: { data: SignalsResponse }) {
  const code = data.error?.code ?? 'network';
  const help = ERROR_HELP[code];
  const detail = data.error?.detail?.trim();

  return (
    <div className="os-error">
      <p>{help}</p>
      {detail && detail !== help ? <p className="os-dim">{detail}</p> : null}
      {FIXED_IN_SETTINGS.has(code) ? (
        <button type="button" className="os-btn" onClick={() => void openOptions()}>
          Open settings
        </button>
      ) : null}
    </div>
  );
}

function Receipts({ data }: { data: SignalsResponse }) {
  const v = buildView(data);

  if (v.rows.length === 0) {
    return (
      <div className="os-body">
        <p className="os-note">{v.headline}</p>
        {v.incomplete ? <p className="os-warn">{v.incomplete}</p> : null}
        <p className="os-dim">
          That is an absence of evidence, not evidence of a problem.
        </p>
      </div>
    );
  }

  return (
    <div className="os-body">
      <p className="os-lede">
        {v.headline}
        {v.subhead ? ` ${v.subhead}` : ''}
      </p>
      {v.incomplete ? <p className="os-warn">{v.incomplete}</p> : null}

      <ul className="os-list">
        {v.rows.map((row) => (
          <li key={row.receipt.prUrl} className="os-row">
            <span className={`os-mark os-mark-${row.mark}`} title={markTitle(row.mark)}>
              {row.markLabel}
            </span>
            <a
              className="os-prtitle"
              href={row.receipt.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              {row.receipt.prTitle}
            </a>
            <span className="os-repo">
              {row.receipt.repo}#{row.receipt.number}
            </span>
            {v.projectIsSlow ? (
              <span className="os-timing">
                author {humanHours(row.receipt.hoursToAuthorResponse)} · project{' '}
                {humanHours(row.receipt.projectHoursToFirstReview)} to first review
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <footer className="os-foot">
        Based on {v.sampled} PRs{v.range ? ` · ${v.range}` : ''}
      </footer>
    </div>
  );
}

function Score({ data }: { data: SignalsResponse }) {
  const result = data.result;
  if (!result) return <p className="os-note">No score — no data was fetched.</p>;

  // Two different things that both look like "no points", and calling them the
  // same was a bug: an INFORMATIONAL rule was measured and deliberately not
  // scored; an UNMEASURED signal is one we could not read at all. Merging them
  // tells a maintainer we know something we don't. §7.1
  const scored = result.lines.filter((l) => l.scored);
  const informational = result.lines.filter((l) => !l.scored);

  return (
    <div className="os-body">
      <p className="os-lede">
        <strong>{result.band}</strong>
        <span className="os-dim">
          {' '}
          {result.total >= 0 ? '+' : ''}
          {result.total} of {result.maxAchievable} possible
        </span>
      </p>
      <ul className="os-lines">
        {scored.map((l) => (
          <Line key={l.rule} line={l} />
        ))}
      </ul>
      {informational.length ? (
        <details className="os-unknown">
          <summary>
            {informational.length} shown for context — not scored, by choice
          </summary>
          <ul className="os-lines">
            {informational.map((l) => (
              <li key={l.rule} className="os-line os-dim">
                <span className="os-line-label">{l.label}</span>
                <span className="os-pts">info</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {result.unmeasured.length ? (
        <p className="os-note">
          Not enough data to judge: {result.unmeasured.join(', ')}. These contribute
          nothing rather than defaulting to a middle value.
        </p>
      ) : null}
    </div>
  );
}

function Line({ line }: { line: ScoreLine }) {
  return (
    <li className="os-line">
      <span className="os-line-label">
        {line.label}
        {line.evidence === 'novel' || line.evidence === 'contested' ? (
          <span className="os-caveat" title={`Evidence: ${line.evidence}`}>
            {' '}
            ⚠
          </span>
        ) : null}
      </span>
      <span className={line.points < 0 ? 'os-pts os-neg' : 'os-pts'}>
        {line.points > 0 ? '+' : ''}
        {line.points}
      </span>
    </li>
  );
}

function Project({ data }: { data: SignalsResponse }) {
  const v = buildView(data);
  const withTiming = v.rows.filter((r) => r.receipt.projectHoursToFirstReview != null);

  if (!withTiming.length) {
    return <p className="os-note">No reviewed PRs to compare against.</p>;
  }

  return (
    <div className="os-body">
      <p className="os-lede">
        How long this author waited for a first review, next to how long they took to
        respond.
      </p>
      <ul className="os-list">
        {withTiming.map(({ receipt }) => (
          <li key={receipt.prUrl} className="os-row">
            <a
              className="os-prtitle"
              href={receipt.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              {receipt.prTitle}
            </a>
            <span className="os-timing">
              project {humanHours(receipt.projectHoursToFirstReview)} · author{' '}
              {humanHours(receipt.hoursToAuthorResponse)}
            </span>
          </li>
        ))}
      </ul>
      <footer className="os-foot">
        A long project column means the wait was not the author’s doing.
      </footer>
    </div>
  );
}
