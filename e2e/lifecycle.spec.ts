import { expect, panel, seedToken, settledPanel, test } from './fixtures';

const PR = 'https://github.com/dotnet/aspnetcore/pull/68116';
const token = process.env.GITHUB_TOKEN ?? '';

test.describe('when the extension is reloaded under an open tab', () => {
  test.skip(!token, 'set GITHUB_TOKEN to run the tests that call GitHub');

  test('says to reload the page, and does not blame GitHub', async ({
    context,
    extensionId,
  }) => {
    // This is the failure a user actually reported, and the reason it was worth
    // a code of its own: the panel said "Could not reach api.github.com", which
    // sends someone to check their network over a stale tab. It is not a
    // dev-only case — it happens to every open GitHub tab on every extension
    // update. FR8c
    const page = await context.newPage();
    await seedToken(page, extensionId, token);
    await page.goto(PR, { waitUntil: 'domcontentloaded' });
    await settledPanel(page);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => chrome.runtime.reload());
    await page.waitForTimeout(2000);

    // The panel only discovers it is orphaned when it next speaks to the
    // background, which is what the refresh control does.
    await panel(page)
      .getByRole('button', { name: /refresh/i })
      .click();

    const p = panel(page);
    await expect(p).toContainText(/updated or reloaded/i, { timeout: 30_000 });
    await expect(p).not.toContainText('Could not reach');
  });
});
