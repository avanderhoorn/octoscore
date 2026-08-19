import { describe, expect, it } from 'vitest';
import { channelErrorCode } from './messaging';

// The exact strings the browsers produce. They are quoted verbatim because the
// classifier is a regex over vendor prose: if a vendor rewords one of these,
// the panel silently goes back to blaming GitHub for a stale tab, and only a
// test holding the real wording will notice.
const CHROME_UPDATED = 'Extension context invalidated.';
const CHROME_NO_LISTENER =
  'Could not establish connection. Receiving end does not exist.';
const CHROME_DANGLING =
  'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';
const FIREFOX_UPDATED =
  'Error: Could not establish connection. Receiving end does not exist.';

describe('telling a dead extension apart from a dead network', () => {
  it.each([CHROME_UPDATED, CHROME_NO_LISTENER, CHROME_DANGLING, FIREFOX_UPDATED])(
    'reads %s as a disconnected extension',
    (message) => {
      expect(channelErrorCode(new Error(message))).toBe('disconnected');
    },
  );

  it('still calls a genuine transport failure a network error', () => {
    expect(channelErrorCode(new Error('Failed to fetch'))).toBe('network');
  });

  it('does not choke on a rejection that is not an Error', () => {
    expect(channelErrorCode('something odd')).toBe('network');
  });
});
