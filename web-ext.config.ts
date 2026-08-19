import { mkdirSync } from 'node:fs';
import { defineWebExtConfig } from 'wxt';

// Both overridable so a second browser can be launched (a debugging session,
// a clean-profile repro) without disturbing the one already running: Chrome
// locks a profile directory, and two instances on one port cannot coexist.
const PROFILE = process.env.OCTOSCORE_PROFILE ?? '.chrome-profile';

/**
 * Opt-in DevTools Protocol port, for driving the dev browser from a script —
 * checking that the panel really mounted against GitHub as it is today, rather
 * than against captured markup.
 *
 * Off by default: an open debugging port lets any local process drive the
 * browser, and this profile is signed in to GitHub.
 */
const DEBUG_PORT = process.env.OCTOSCORE_DEBUG_PORT;

// chrome-launcher writes its log INTO the profile directory but never creates
// it, so a missing directory fails the launch with a bare ENOENT on
// `chrome-out.log`. Create it here rather than in a predev script, so it also
// works when wxt is invoked directly.
mkdirSync(PROFILE, { recursive: true });

/**
 * Dev browser launch options. `npm run dev` uses these; production builds ignore
 * them entirely.
 *
 * Requires the `web-ext` dev dependency. WXT treats it as optional and silently
 * degrades to "load the folder yourself" if it is absent, which reads like the
 * dev server is broken when it isn't.
 */
export default defineWebExtConfig({
  /**
   * Chrome normally gets a blank temporary profile every launch, so you would
   * sign in to GitHub again on each restart — and a signed-out GitHub renders
   * different markup, so the panel would not mount and it would look like a bug.
   * Keep one profile in the project (gitignored) and sign in once.
   */
  chromiumProfile: PROFILE,
  keepProfileChanges: true,

  /**
   * Open on a real external-contributor PR rather than a blank tab: this is the
   * exact case the extension exists for, so the mount path is exercised the
   * moment the browser appears.
   */
  startUrls: ['https://github.com/advplyr/audiobookshelf/pull/5401'],

  ...(DEBUG_PORT ? { chromiumArgs: [`--remote-debugging-port=${DEBUG_PORT}`] } : {}),
});
