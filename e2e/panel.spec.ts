import { expect, seedToken, settledPanel, test } from './fixtures';

// A real, permanently merged PR on a large public repo. Chosen because it is
// the exact page that exposed the worst bug this project has had: GitHub's
// header reads "Youssef1313 merged 6 commits into dotnet:main from
// snemeckayova:…", so anything reading the author out of the DOM profiles the
// maintainer who pressed the button instead of the contributor. FR8a
const MERGED_PR = 'https://github.com/dotnet/aspnetcore/pull/68116';
const AUTHOR = 'snemeckayova';
const MERGER = 'Youssef1313';

/** A second PR on the same repo, by someone else. */
const OTHER_PR_NUMBER = 68139;

/** Opened by dotnet-maestro, an app rather than a person. */
const BOT_PR = 'https://github.com/dotnet/aspnetcore/pull/68164';

const token = process.env.GITHUB_TOKEN ?? '';

test.describe('a maintainer opening a pull request', () => {
  test('sees the panel mount on a page GitHub renders in React', async ({
    context,
    extensionId,
  }) => {
    // No token seeded. The panel must still appear — a tool that stays
    // invisible until configured gives a new user nothing to configure.
    const page = await context.newPage();
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });

    const p = await settledPanel(page);
    await expect(p).toContainText('OctoScore');
    void extensionId;
  });

  test('is told to add a token, and is not told the network is down', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });

    const p = await settledPanel(page);
    await expect(p).toContainText('Add a GitHub token');
    // The regression that sent a user to check their wifi over a missing
    // token. Any internal fault reaching the panel as a network error is a
    // bug in its own right. FR8c
    await expect(p).not.toContainText('Could not reach');
  });

  test('can reach settings from the panel, without hunting for chrome://extensions', async ({
    context,
    extensionId,
  }) => {
    // The panel used to say "add a token in the extension's settings" and then
    // offer no way to get there — the only route was chrome://extensions →
    // Details → Extension options, which a maintainer has no reason to guess.
    // A content script cannot call openOptionsPage itself, so this proves the
    // whole round trip: button → background → options tab. FR1
    const page = await context.newPage();
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });
    const p = await settledPanel(page);

    // First run already opened settings once. Close it: the case that matters
    // is the maintainer who dismissed that tab and now needs to get back.
    const url = `chrome-extension://${extensionId}/options.html`;
    await Promise.all(
      context
        .pages()
        .filter((t) => t.url() === url)
        .map((t) => t.close()),
    );

    const opened = context.waitForEvent('page');
    await p.getByRole('button', { name: 'Open settings' }).click();
    const settings = await opened;
    await settings.waitForLoadState('domcontentloaded');

    expect(settings.url()).toBe(url);
    await expect(settings.getByLabel('GitHub token')).toBeVisible();
  });

  test('sees the panel below the PR header, not floating over the page', async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });
    await settledPanel(page);

    const stuck = await page.evaluate(() => {
      const host = document.querySelector('octoscore-panel');
      if (!host) return 'missing';
      const style = getComputedStyle(host);
      return style.position === 'fixed' || style.position === 'absolute'
        ? 'floating'
        : 'in-flow';
    });
    expect(stuck).toBe('in-flow');
  });

  test('reads as an extension of the tab strip, not a second box', async ({
    context,
  }) => {
    // The panel is meant to hang off the PR tabs: the strip's bottom border is
    // its top edge. That only holds if the two are flush and the same width,
    // and both are easy to break from CSS without noticing — the panel still
    // looks fine on its own, just detached.
    const page = await context.newPage();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });
    await settledPanel(page);

    const fit = await page.evaluate(() => {
      const host = document.querySelector('octoscore-panel');
      const tabs = document.querySelector('nav[class*="TabNav"]');
      if (!host || !tabs) return null;
      const h = host.getBoundingClientRect();
      const t = tabs.getBoundingClientRect();
      const border = getComputedStyle(
        (host as HTMLElement).shadowRoot?.querySelector('.os') as Element,
      ).borderTopWidth;
      return {
        gap: Math.round(h.top - t.bottom),
        dx: Math.round(h.left - t.left),
        dw: Math.round(h.width - t.width),
        border,
      };
    });

    expect(fit, 'no tab strip found — GitHub may have renamed it').not.toBeNull();
    expect(fit?.gap).toBe(0);
    expect(fit?.dx).toBe(0);
    expect(fit?.dw).toBe(0);
    expect(fit?.border).toBe('0px');
  });
});

test.describe('with a working token', () => {
  test.skip(!token, 'set GITHUB_TOKEN to run the tests that call GitHub');

  test('reads the contributor, never the person who merged', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await seedToken(page, extensionId, token);
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });

    const p = await settledPanel(page);
    await expect(p).toContainText(AUTHOR);
    await expect(p).not.toContainText(MERGER);
  });

  test('shows receipts that link to the pull requests they describe', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await seedToken(page, extensionId, token);
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });
    await settledPanel(page);

    const links = await page.evaluate(() =>
      [
        ...(document
          .querySelector('octoscore-panel')
          ?.shadowRoot?.querySelectorAll('a') ?? []),
      ]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.includes('/pull/')),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const href of links)
      expect(href).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
  });

  test('does not describe the PR being reviewed as part of its own history', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await seedToken(page, extensionId, token);
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });
    await settledPanel(page);

    const links = await page.evaluate(() =>
      [
        ...(document
          .querySelector('octoscore-panel')
          ?.shadowRoot?.querySelectorAll('a') ?? []),
      ].map((a) => a.getAttribute('href') ?? ''),
    );
    expect(links).not.toContain(MERGED_PR);
  });

  test('follows a Turbo navigation to a different author', async ({
    context,
    extensionId,
  }) => {
    // GitHub swaps the DOM without a page load. A panel that mounts once on
    // DOMContentLoaded silently stops updating from the second PR onward,
    // which means showing one contributor's record under another's name. FR8b
    const page = await context.newPage();
    await seedToken(page, extensionId, token);
    await page.goto(MERGED_PR, { waitUntil: 'domcontentloaded' });
    const before = (await settledPanel(page)).first();
    const firstAuthorsPanel = (await before.textContent()) ?? '';
    expect(firstAuthorsPanel).toContain(AUTHOR);

    // A sentinel that a full page load would wipe. Without it this test passes
    // on a hard navigation, which is precisely the case it exists to rule out.
    await page.evaluate(() => {
      (window as unknown as { __octoscoreSoft?: boolean }).__octoscoreSoft = true;
    });

    // The link is injected rather than found on the page: which PRs GitHub
    // cross-links to changes constantly, and Turbo's click handler is on the
    // document, so an injected anchor exercises the same path.
    await page.evaluate((n) => {
      const link = document.createElement('a');
      link.href = `/dotnet/aspnetcore/pull/${n}`;
      link.textContent = 'go';
      document.body.append(link);
      link.click();
    }, OTHER_PR_NUMBER);
    await expect(page).toHaveURL(new RegExp(`pull/${OTHER_PR_NUMBER}`));

    const survived = await page.evaluate(
      () => (window as unknown as { __octoscoreSoft?: boolean }).__octoscoreSoft === true,
    );
    expect(survived, 'GitHub did a full page load, so this proved nothing').toBe(true);

    // Not "shows the new author's name": the panel only names someone when it
    // has something to say about them. What must be true is that the previous
    // contributor's record is gone — leaving it up is the failure this guards.
    const p = await settledPanel(page);
    await expect(p).not.toContainText(AUTHOR, { timeout: 45_000 });
    expect(await p.textContent()).not.toBe(firstAuthorsPanel);
  });

  test('says a bot is a bot instead of judging it', async ({ context, extensionId }) => {
    // Dependency bots open thousands of PRs and none of the receipts mean
    // anything about a person. FR7
    const page = await context.newPage();
    await seedToken(page, extensionId, token);
    await page.goto(BOT_PR, { waitUntil: 'domcontentloaded' });

    const p = await settledPanel(page);
    await expect(p).toContainText(/automated account/i);
  });
});
