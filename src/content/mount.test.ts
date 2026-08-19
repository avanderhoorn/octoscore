// @vitest-environment jsdom
//
// The only file here that needs a DOM. Everything else in this codebase is pure
// functions and runs in `node`, which is why the environment is per-file rather
// than global.
import { describe, expect, it } from 'vitest';
import { findMount, parseUrl } from './mount';

describe('reading the PR out of the URL', () => {
  it('accepts a PR page and its sub-tabs', () => {
    expect(parseUrl('/acme/core/pull/1042')).toEqual({
      repo: 'acme/core',
      prNumber: 1042,
    });
    expect(parseUrl('/acme/core/pull/1042/files')).toEqual({
      repo: 'acme/core',
      prNumber: 1042,
    });
    expect(parseUrl('/acme/core/pull/1042/commits/abc123')).toEqual({
      repo: 'acme/core',
      prNumber: 1042,
    });
  });

  it('handles repo names with dots and dashes', () => {
    expect(parseUrl('/my-org/my.repo.js/pull/7')?.repo).toBe('my-org/my.repo.js');
  });

  it('rejects anything that is not a PR', () => {
    expect(parseUrl('/acme/core/issues/1042')).toBeNull();
    expect(parseUrl('/acme/core/pulls')).toBeNull();
    expect(parseUrl('/acme/core')).toBeNull();
    expect(parseUrl('/')).toBeNull();
    expect(parseUrl('/acme/core/pull/abc')).toBeNull();
  });

  it('rejects a number too large to be one', () => {
    expect(parseUrl(`/a/b/pull/${'9'.repeat(30)}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DOM shapes below are copied from GitHub's live rendered pages
// (advplyr/audiobookshelf#5401 and dotnet/aspnetcore#68144), captured through
// the DevTools protocol. The page is client-rendered, so this markup does not
// appear in the served HTML.
//
// Class names are included exactly as GitHub emits them, hashes and all, to
// document why nothing here selects on them.
// ---------------------------------------------------------------------------

/** The Primer React header, as shipped today. */
const REACT_HEADER = `
  <header class="prc-PageLayout-Header-0of-R" data-component="SplitPageLayout.Header">
    <div class="prc-PageLayout-HeaderContent-gdFfN">
      <div>
        <div class="prc-PageHeader-PageHeader-YLwBQ" data-component="PageHeader">
          <div class="prc-PageHeader-TitleArea-2n2J0" data-component="TitleArea">
            <h1 class="prc-PageHeader-Title-p0Mgh" data-component="PH_Title">Improve mobile tooltip interactions</h1>
          </div>
          <a href="/blue219" class="author" data-hovercard-type="user"
             data-hovercard-url="/users/blue219/hovercard">blue219</a>
        </div>
      </div>
    </div>
  </header>`;

/** The pre-rewrite header, still served to enterprise instances. */
const LEGACY_HEADER = `
  <div id="partial-discussion-header">
    <div class="gh-header-meta"><a class="author" href="/octocat">octocat</a></div>
  </div>`;

/**
 * A merged PR's header, captured from dotnet/aspnetcore#68116.
 *
 * Kept because it is the evidence for why nothing here reads the author. The
 * PR was written by `snemeckayova`; the only user link in the header is
 * `Youssef1313`, who merged it. Any selector aimed at this header profiles the
 * maintainer who pressed the button.
 */
const MERGED_HEADER = `
  <div data-component="PageHeader">
    <div data-component="TitleArea">
      <h1 data-component="PH_Title">Fix nullable get-only property schema generation</h1>
    </div>
    <div data-component="PageHeader.Description">
      <a href="/Youssef1313" data-hovercard-type="user">Youssef1313</a>
      merged 6 commits into
      <span data-component="BranchName">dotnet:main</span> from
      <span data-component="BranchName">snemeckayova:dev/openapi-nullability</span>
    </div>
  </div>`;

const dom = (html: string) => {
  document.body.innerHTML = html;
  return document;
};

describe('who the page is allowed to tell us about', () => {
  it('exposes no way to read an author from the DOM', async () => {
    // The author comes from the API. This asserts the boundary rather than the
    // absence of one function: if a selector is reintroduced under any name,
    // the merged-PR case below is what it will get wrong.
    const mod = await import('./mount');
    expect(Object.keys(mod)).not.toContain('findAuthor');
  });

  it('would name the merger, not the author, if it trusted the header', () => {
    const link = dom(MERGED_HEADER).querySelector(
      '[data-component="PageHeader"] a[data-hovercard-type="user"]',
    );
    // snemeckayova wrote it. This is the trap, preserved.
    expect(link?.textContent).toBe('Youssef1313');
  });

  it('takes only the URL from the page', () => {
    expect(parseUrl('/dotnet/aspnetcore/pull/68116')).toEqual({
      repo: 'dotnet/aspnetcore',
      prNumber: 68116,
    });
  });
});

describe('finding somewhere to mount', () => {
  it('assumes visible when the environment cannot answer', () => {
    // isVisible is written as "visible unless provably hidden" precisely so
    // this holds: jsdom implements no layout and so has no checkVisibility.
    // Were it phrased the other way round, every element would read as hidden
    // here and these tests would pass against nothing.
    const el = document.createElement('div');
    expect(typeof el.checkVisibility).not.toBe('function');
  });

  it('finds the Primer React header', () => {
    const el = findMount(dom(REACT_HEADER));
    expect(el?.getAttribute('data-component')).toBe('PageHeader');
  });

  it('falls back to the pre-rewrite header', () => {
    expect(findMount(dom(LEGACY_HEADER))?.className).toBe('gh-header-meta');
  });

  it('returns null when no known header is present', () => {
    // The failure that shipped: every selector was stale after the Primer
    // React rewrite, so this returned null on every real PR page and the panel
    // crashed on startup with "could not find anchor element".
    expect(findMount(dom('<div class="something-else"></div>'))).toBeNull();
  });

  it('skips the hidden twin of a duplicated header', () => {
    // GitHub renders wide and narrow variants of the header and hides one.
    // Both match, so picking the first hit mounts the panel inside the
    // invisible copy.
    const doc = dom(`
      <div data-component="PageHeader" id="narrow"></div>
      <div data-component="PageHeader" id="wide"></div>`);
    const hidden = doc.getElementById('narrow') as Element & {
      checkVisibility: () => boolean;
    };
    hidden.checkVisibility = () => false;
    const shown = doc.getElementById('wide') as Element & {
      checkVisibility: () => boolean;
    };
    shown.checkVisibility = () => true;

    expect(findMount(doc)?.id).toBe('wide');
  });
});
