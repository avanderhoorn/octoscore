import {
  DEFAULT_SETTINGS,
  getProfile,
  quotaItem,
  resetProfile,
  type Settings,
  setProfile,
  settingsItem,
  tokenLoginItem,
} from '../background/storage';
import type { Profile } from '../shared/types';

// ---------------------------------------------------------------------------
// The options page's I/O, in one file, away from the component.
//
// This is the one place outside background/ that imports background/storage,
// and it is allowed to because the options page runs in the extension's own
// context, not in github.com's. It still never reads the TOKEN — only the login
// the token proved, which is not a secret. §9
// ---------------------------------------------------------------------------

export interface OptionsState {
  profile: Profile;
  settings: Settings;
  tokenLogin: string;
  /** The stored profile failed validation and the default was used instead. */
  profileFellBack: boolean;
  /** Last quota GitHub reported, for display only. */
  quota: { remaining: number; limit: number; at: number } | null;
}

export async function loadOptions(opts?: {
  resetProfile: boolean;
}): Promise<OptionsState> {
  if (opts?.resetProfile) await resetProfile();
  const [{ profile, fellBack }, settings, tokenLogin, quota] = await Promise.all([
    getProfile(),
    settingsItem.getValue(),
    tokenLoginItem.getValue(),
    quotaItem.getValue(),
  ]);
  return {
    profile,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    tokenLogin,
    profileFellBack: fellBack,
    quota,
  };
}

export const saveProfile = (p: Profile) => setProfile(p);
export const saveSettings = (s: Settings) => settingsItem.setValue(s);
