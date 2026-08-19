import { browser, defineBackground } from '#imports';
import { crashedResponse, handleSignals, validateToken } from '../background';
import { tokenItem } from '../background/storage';
import type { Message } from '../shared/messaging';

export default defineBackground(() => {
  // First run: a maintainer who installs this and opens a PR would otherwise
  // meet an error panel as their introduction to the tool. Opening settings on
  // install makes the token step the first thing they see rather than the first
  // thing that fails. Only on a genuine install, and only with no token — an
  // update or a browser restart must never steal a tab. FR1
  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason !== 'install') return;
    if (await tokenItem.getValue()) return;
    await browser.runtime.openOptionsPage();
  });

  // A content script cannot open the options page itself — `openOptionsPage` is
  // not exposed to it — so the panel's "Open settings" button routes through
  // here. Without this the panel could tell a maintainer to add a token and
  // then offer no way to do it, which is exactly the dead end it used to be.
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });

  // The router, and nothing else. All the work is in src/background/, which is
  // testable without a browser; this file only bridges it to the runtime.
  //
  // Returning `true` promises a reply. If one never arrives — an unhandled
  // rejection, a worker torn down mid-flight — the content script waits until
  // the browser closes the channel and reports "the message channel closed
  // before a response was received", which the panel showed as a network error
  // that had not happened. So every branch that returns `true` routes both
  // outcomes of its promise to `sendResponse`.
  browser.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
    const answer = <T>(work: Promise<T>, onFailure: (reason: string) => T) => {
      work.then(sendResponse, (e: unknown) =>
        sendResponse(onFailure(e instanceof Error ? e.message : String(e))),
      );
      return true; // keeps the channel open for the async reply
    };

    switch (msg.kind) {
      case 'signals':
        return answer(handleSignals(msg), (message) => crashedResponse(msg, message));
      case 'validate-token':
        return answer(validateToken(msg.token), (message) => ({
          ok: false as const,
          code: 'crashed' as const,
          message,
        }));
      case 'ping':
        sendResponse({ ok: true });
        return false;
      case 'open-options':
        return answer<{ ok: boolean }>(
          browser.runtime.openOptionsPage().then(() => ({ ok: true })),
          () => ({ ok: false }),
        );
      default:
        return false;
    }
  });
});
