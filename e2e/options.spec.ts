import { expect, test } from './fixtures';

const token = process.env.GITHUB_TOKEN ?? '';

const options = (id: string) => `chrome-extension://${id}/options.html`;

test.describe('setting up the extension', () => {
  test('puts settings behind the toolbar icon, not only chrome://extensions', async ({
    context,
  }) => {
    // The toolbar icon is the one route a maintainer can find without being
    // told. Playwright cannot click browser chrome, so this asserts the next
    // best thing: the click handler is registered at all. Losing it would be
    // silent — the icon stays, and clicking it just does nothing.
    const sw =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const wired = await sw.evaluate(() => chrome.action.onClicked.hasListeners());
    expect(wired).toBe(true);
  });

  test('asks for a token and says the panel cannot see it', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(options(extensionId));

    await expect(page.getByLabel(/GitHub token/i)).toHaveAttribute('type', 'password');
    await expect(page.locator('body')).toContainText(/never synced/i);
  });

  test('rejects a token GitHub does not recognise, and says so', async ({
    context,
    extensionId,
  }) => {
    // FR3. A silent failure here is the worst case: the user believes they are
    // configured, and every panel afterwards looks like a GitHub problem.
    const page = await context.newPage();
    await page.goto(options(extensionId));

    await page
      .getByLabel(/GitHub token/i)
      .fill('ghp_definitelynotarealtoken00000000000000');
    await page.getByRole('button', { name: /validate/i }).click();

    await expect(page.locator('body')).toContainText(/rejected|invalid|failed/i, {
      timeout: 30_000,
    });
    // A rejected token must not be left behind as if it had worked.
    const stored = await page.evaluate(() => chrome.storage.local.get('tokenLogin'));
    expect(stored.tokenLogin ?? '').toBe('');
  });

  test.describe('with a real token', () => {
    test.skip(!token, 'set GITHUB_TOKEN to run the tests that call GitHub');

    test('accepts it and names who it belongs to', async ({ context, extensionId }) => {
      const page = await context.newPage();
      await page.goto(options(extensionId));

      await page.getByLabel(/GitHub token/i).fill(token);
      await page.getByRole('button', { name: /validate/i }).click();

      await expect(page.locator('body')).toContainText(/signed in as/i, {
        timeout: 30_000,
      });
      const stored = await page.evaluate(() => chrome.storage.local.get('tokenLogin'));
      expect(stored.tokenLogin).toBeTruthy();
    });
  });
});
