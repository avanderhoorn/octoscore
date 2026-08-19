import type { Profile } from '../shared/types';
import raw from './profile.default.json';
import { parseProfile } from './profile.schema';

/**
 * The default profile ships as data, not code. It is the same file the
 * prototype in examples/ reads, so the two cannot drift. §7
 *
 * Validated rather than cast: `as unknown as Profile` compiled happily while
 * the file used seven `evidence` values the type declared three of. If this
 * throws, the shipped default is broken and no amount of runtime tolerance
 * would have made it right.
 */
export const DEFAULT_PROFILE: Profile = parseProfile(raw);
