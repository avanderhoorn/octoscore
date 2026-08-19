import { browser } from '#imports';
import type { ErrorCode, SignalsRequest, SignalsResponse } from './types';

// ---------------------------------------------------------------------------
// The only channel between the content script and the background.
//
// It lives in shared/ deliberately. If `sendSignalsRequest` lived in
// background/, the content script would `import` from background/ to call it —
// and the bundler would pull the token, the API client and the cache into a
// script that runs in the page's process. The isolation would be gone on day
// one, and nothing would have visibly broken. §9
//
// Nothing below this line knows what a token is.
// ---------------------------------------------------------------------------

export type Message =
  | SignalsRequest
  | { kind: 'validate-token'; token: string }
  | { kind: 'open-options' }
  | { kind: 'ping' };

export async function sendSignalsRequest(
  req: Omit<SignalsRequest, 'kind'>,
): Promise<SignalsResponse> {
  return (await browser.runtime.sendMessage({
    kind: 'signals',
    ...req,
  } satisfies SignalsRequest)) as SignalsResponse;
}

export async function sendValidateToken(
  token: string,
): Promise<{ ok: true; login: string } | { ok: false; code: string; message: string }> {
  return (await browser.runtime.sendMessage({ kind: 'validate-token', token })) as never;
}

// A content script has no `openOptionsPage`, so "Open settings" is a message
// like everything else. Failure is not worth surfacing: the worst case is a
// click that does nothing, and the panel already tells you where settings are.
export async function openOptions(): Promise<void> {
  try {
    await browser.runtime.sendMessage({ kind: 'open-options' });
  } catch {
    /* the extension was reloaded; the panel reports that separately */
  }
}

// The browser's wording for "the extension you are talking to is not the
// extension that injected you". Chrome and Firefox each phrase it differently,
// and Chrome uses a third phrasing when the background never answered at all.
const DISCONNECTED =
  /context invalidated|receiving end does not exist|message channel closed/i;

/**
 * Why a `sendMessage` rejection is not automatically a network error.
 *
 * When the extension is updated, reloaded, or rebuilt by the dev server, every
 * already-open GitHub tab keeps running the OLD content script against a
 * background that no longer exists. `sendMessage` then rejects — and the panel
 * used to report "Could not reach api.github.com", sending the maintainer off
 * to check their wifi over a stale tab that a reload fixes in a second.
 *
 * This is not a dev-only edge case: it happens to every open tab on every
 * extension update. The transport is the only layer that can tell the two
 * apart, so it does, and hands the panel a code rather than a guess.
 */
export function channelErrorCode(e: unknown): ErrorCode {
  const text = e instanceof Error ? e.message : String(e);
  return DISCONNECTED.test(text) ? 'disconnected' : 'network';
}
