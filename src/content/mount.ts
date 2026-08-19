// ---------------------------------------------------------------------------
// Everything that touches GitHub's DOM lives here, and it does exactly two
// things: work out who and where we are, and find somewhere to hang the panel.
//
// No component may do either. GitHub redesigns its PR page regularly; when it
// does, this file breaks and nothing else does. §9
// ---------------------------------------------------------------------------

export interface PrContext {
  repo: string;
  prNumber: number;
}

/** `/owner/name/pull/123` — anything else is not a PR page. */
export function parseUrl(pathname: string): { repo: string; prNumber: number } | null {
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(pathname);
  if (!m) return null;
  const n = Number(m[3]);
  return Number.isSafeInteger(n) ? { repo: `${m[1]}/${m[2]}`, prNumber: n } : null;
}

/**
 * ## Which attributes are safe to select on
 *
 * GitHub's PR page is now Primer React, and its class names carry per-build
 * content hashes — `prc-PageHeader-Title-p0Mgh`, `PullRequestHeader-module__
 * titleWithAction__ODY5f`. **Never select on those.** They change whenever the
 * component is recompiled, so a selector built from one is broken by a deploy
 * that changed nothing visible.
 *
 * `data-component` is Primer's own marker for what a node *is*, survives
 * recompilation, and is what everything below uses. Legacy `.gh-header-*`
 * selectors are kept underneath because GitHub rolls this out gradually and
 * enterprise instances lag well behind github.com.
 *
 * Verified against the live rendered DOM of two repositories, not guessed from
 * server HTML — the page is client-rendered, so `curl` shows almost none of it.
 */

/**
 * ## Why there is no author selector here
 *
 * There was one, and it was wrong twice. Scoped to the page header it matched
 * the repository owner in the breadcrumb, crediting every PR on
 * `advplyr/audiobookshelf` to `advplyr`. Scoped more tightly it then matched
 * the *merger* on any merged PR — GitHub's header reads "Youssef1313 merged 6
 * commits into dotnet:main from snemeckayova:…", so the maintainer who pressed
 * the button was profiled instead of the contributor who wrote the code.
 *
 * Both bugs share a cause: the header is prose about the pull request, and
 * which person it names depends on state this file cannot see. So the page is
 * now trusted for exactly one thing — the URL, which cannot be re-labelled by a
 * redesign. Who the author is comes from the API, where the field is called
 * `author` and means it. See `fetchPrAuthor`.
 */

/**
 * Is this node actually on screen?
 *
 * GitHub renders the PR header **twice** — a wide and a narrow variant — and
 * hides one with CSS. Both match every selector, and which comes first in the
 * document is not ours to rely on, so taking `querySelector`'s first hit is a
 * coin flip on mounting the panel inside the invisible copy.
 *
 * Phrased as "visible unless provably hidden" so it degrades safely: jsdom
 * implements no layout, so `checkVisibility` is absent there and every node is
 * treated as visible rather than every node vanishing from the tests.
 */
function isVisible(el: Element): boolean {
  return typeof el.checkVisibility !== 'function' || el.checkVisibility();
}

/** Where the panel goes: under the PR title block, above the conversation. */
const MOUNT_SELECTORS = [
  // Inside the header, so the panel inherits the page's gutters instead of
  // going edge-to-edge.
  '[data-component="PageHeader"]',
  '[data-component="SplitPageLayout.Header"]',
  '.gh-header-meta',
  '[data-testid="issue-metadata-fixed"]',
  '.gh-header-show',
  '#partial-discussion-header',
];

export function findMount(root: ParentNode = document): Element | null {
  for (const sel of MOUNT_SELECTORS) {
    for (const el of root.querySelectorAll(sel)) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

/**
 * Resolve the context, waiting for the header if the page is still hydrating.
 *
 * The whole page is client-rendered, so at `document_idle` the header may not
 * exist yet. Resolving before it does left `createShadowRootUi` to throw "could
 * not find anchor element" against a header that was still on its way, which is
 * why this waits for the anchor rather than just the URL.
 */
export async function waitForContext(timeoutMs = 8000): Promise<PrContext | null> {
  const loc = parseUrl(location.pathname);
  if (!loc) return null;

  const read = (): PrContext | null => {
    // Re-read the URL: Turbo may have moved us again while we waited.
    const l = parseUrl(location.pathname);
    return l && findMount() ? l : null;
  };

  const now = read();
  if (now) return now;

  return new Promise((resolve) => {
    const done = (v: PrContext | null) => {
      clearTimeout(timer);
      obs.disconnect();
      resolve(v);
    };
    const obs = new MutationObserver(() => {
      const ctx = read();
      if (ctx) done(ctx);
    });
    const timer = setTimeout(() => done(null), timeoutMs);
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Call `onChange` whenever Turbo navigates to a different PR.
 *
 * GitHub does not reload between PRs, so without this the panel would keep
 * showing the first author it ever saw. `turbo:load` is GitHub's own event;
 * the popstate listener covers back/forward, which does not always fire it.
 */
export function onPrChange(onChange: () => void): () => void {
  let last = location.pathname;
  const check = () => {
    if (location.pathname === last) return;
    last = location.pathname;
    onChange();
  };
  document.addEventListener('turbo:load', check);
  document.addEventListener('turbo:render', check);
  window.addEventListener('popstate', check);
  return () => {
    document.removeEventListener('turbo:load', check);
    document.removeEventListener('turbo:render', check);
    window.removeEventListener('popstate', check);
  };
}
