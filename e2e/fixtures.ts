import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, test as base, chromium, type Page } from '@playwright/test';

const EXTENSION = fileURLToPath(new URL('../.output/chrome-mv3', import.meta.url));

// ---------------------------------------------------------------------------
// Why these tests exist.
//
// Every serious bug this project has shipped was invisible to unit tests and
// obvious within seconds of loading the extension in a browser: selectors
// pointing at a page GitHub had rewritten, the merger's name where the author's
// belonged, a message channel that closed without answering. All three passed
// `vitest`, and all three were caught by a human opening a PR page.
//
// So this file loads the real built extension into a real Chrome against the
// real github.com. It is slow, it needs the network, and it is the only thing
// here that can fail the way users fail.
// ---------------------------------------------------------------------------

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  profileDir: string;
}>({
  profileDir: async (
    // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture API requires the deps argument.
    {},
    use,
  ) => {
    // A fresh profile per worker: no GitHub session, no leftover token, no
    // cache. Logged out is what a new user hits first, so it is the default
    // here rather than a special case.
    const dir = mkdtempSync(join(tmpdir(), 'octoscore-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  context: async ({ profileDir }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // The MV3 service worker is the only place the generated ID is visible.
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker.url().split('/')[2]);
  },
});

export const expect = test.expect;

/**
 * Write a token the way the background stores it.
 *
 * `options.spec.ts` proves the real form writes this key correctly. Every other
 * test needs a token but is not testing token entry, so it takes the short
 * path — driving the settings form before each panel assertion would add a page
 * load and a live API call to every test for no extra coverage.
 */
export async function seedToken(page: Page, extensionId: string, token: string) {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate((t) => chrome.storage.local.set({ token: t }), token);
}

/** The panel lives in a shadow root; Playwright's selectors pierce it. */
export function panel(page: Page) {
  return page.locator('octoscore-panel .os');
}

/**
 * Resolves once the panel has stopped saying it is loading.
 *
 * The timeout is generous because these lookups go to GitHub's search API,
 * which takes 7–25s depending on how much history the author has. On failure it
 * reports what the panel actually said, so a slow run is distinguishable from a
 * stuck one without re-running under a debugger.
 */
export async function settledPanel(page: Page) {
  const p = panel(page);
  try {
    await p.waitFor({ state: 'attached', timeout: 30_000 });
    await expect(p).not.toContainText('Reading this author', { timeout: 45_000 });
  } catch (e) {
    const said = await p
      .textContent()
      .catch(() => null)
      .then((t) => t ?? '(no panel in the DOM)');
    throw new Error(`Panel never settled. It said: ${said.slice(0, 300)}`, { cause: e });
  }
  return p;
}
