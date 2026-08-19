import { expect, test } from './fixtures';

// A canary aimed at GitHub, not at us.
//
// `onPrChange` listens for specific events, and if GitHub renames or drops them
// the panel keeps showing the previous contributor's record under the next
// contributor's name — silently, which is the worst way for this tool to fail.
// Guessing at these names is how that bug got in, so they are checked against
// the live site rather than assumed.
test('GitHub still fires the navigation events the panel listens for', async ({
  context,
}) => {
  const page = await context.newPage();
  await page.goto('https://github.com/dotnet/aspnetcore/pull/68116', {
    waitUntil: 'domcontentloaded',
  });

  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    for (const n of ['turbo:load', 'turbo:render', 'soft-nav:end']) {
      document.addEventListener(n, () => seen.push(n));
    }
  });

  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/dotnet/aspnetcore/pull/68139';
    document.body.append(link);
    link.click();
  });
  await expect(page).toHaveURL(/68139/);
  await page.waitForTimeout(4000);

  const seen = await page.evaluate(
    () => (window as unknown as { __seen: string[] }).__seen,
  );
  expect(seen, `GitHub fired: ${JSON.stringify(seen)}`).toContain('turbo:load');
});
