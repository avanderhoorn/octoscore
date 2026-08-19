import { useEffect, useState } from 'react';
import { sendValidateToken } from '../shared/messaging';
import type { Profile, Rule } from '../shared/types';
import { loadOptions, type OptionsState, saveProfile, saveSettings } from './state';

// ---------------------------------------------------------------------------
// Settings. Read src/content/AGENTS.md — the same React rules apply here.
//
// One Profile in state, not one useState per field. Saving is an event
// handler, never an effect. Two effects total: initial load, and nothing else.
// ---------------------------------------------------------------------------

type Load = { status: 'loading' } | { status: 'ready'; state: OptionsState };

type TokenState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; login: string }
  | { status: 'bad'; message: string };

export function Options() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    loadOptions().then((state) => {
      if (live) setLoad({ status: 'ready', state });
    });
    return () => {
      live = false;
    };
  }, []);

  if (load.status === 'loading') return <p className="dim">Loading…</p>;
  return (
    <Form initial={load.state} onState={(state) => setLoad({ status: 'ready', state })} />
  );
}

/**
 * The hourly budget is invisible from inside an extension, and "it stopped
 * working" is a terrible way to discover you spent it. Says when it was read,
 * because a stale number presented as current is its own kind of lie.
 */
function quotaLine(quota: OptionsState['quota']): string {
  if (!quota) return 'API quota: not measured yet — it is read on the first lookup.';
  const mins = Math.round((Date.now() - quota.at) / 60_000);
  const when =
    mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  const of = quota.limit ? ` of ${quota.limit.toLocaleString()}/hr` : '';
  return `API quota: ${quota.remaining.toLocaleString()} points left${of}, as of ${when}.`;
}

function Form({
  initial,
  onState,
}: {
  initial: OptionsState;
  onState: (s: OptionsState) => void;
}) {
  const [profile, setProfile] = useState<Profile>(initial.profile);
  const [settings, setSettings] = useState(initial.settings);
  const [token, setToken] = useState('');
  const [tokenState, setTokenState] = useState<TokenState>(
    initial.tokenLogin ? { status: 'ok', login: initial.tokenLogin } : { status: 'idle' },
  );

  const check = async () => {
    setTokenState({ status: 'checking' });
    const r = await sendValidateToken(token.trim());
    setTokenState(
      r.ok ? { status: 'ok', login: r.login } : { status: 'bad', message: r.message },
    );
    if (r.ok) setToken('');
  };

  const commitProfile = (next: Profile) => {
    setProfile(next);
    void saveProfile(next);
  };

  return (
    <main>
      <h1>OctoScore</h1>

      <section>
        <h2>GitHub token</h2>
        <p className="dim">
          A fine-grained personal access token with <strong>read-only</strong> access. It
          is stored in this browser only, never synced, and is sent nowhere but
          api.github.com. The panel cannot see it.
        </p>
        <div className="row">
          {/*
            An explicit label rather than a placeholder. A placeholder is not an
            accessible name, and it disappears the moment you type — on the one
            field where getting the wrong value in silently breaks everything
            downstream. Every other input on this page is wrapped in a <label>;
            this one is not, because the button has to sit beside it.
          */}
          <label className="sr-only" htmlFor="octoscore-token">
            GitHub token
          </label>
          <input
            id="octoscore-token"
            type="password"
            value={token}
            placeholder={tokenState.status === 'ok' ? 'A token is saved' : 'github_pat_…'}
            onChange={(e) => setToken(e.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void check()}
            disabled={!token.trim() || tokenState.status === 'checking'}
          >
            {tokenState.status === 'checking' ? 'Checking…' : 'Validate & save'}
          </button>
        </div>
        <TokenNote state={tokenState} />
      </section>

      <section>
        <h2>Data</h2>
        <label>
          Receipts to read per author
          <input
            type="number"
            min={5}
            max={50}
            value={settings.window}
            onChange={(e) =>
              setSettings({ ...settings, window: Number(e.currentTarget.value) })
            }
            onBlur={() => void saveSettings(settings)}
          />
        </label>
        <label>
          Cache lifetime multiplier
          <input
            type="number"
            min={0}
            max={10}
            step={0.5}
            value={settings.cacheMultiplier}
            onChange={(e) =>
              setSettings({
                ...settings,
                cacheMultiplier: Number(e.currentTarget.value),
              })
            }
            onBlur={() => void saveSettings(settings)}
          />
        </label>
        <p className="dim">
          Cache lifetime scales with how established the account is: about a week for
          long-standing contributors, hours for brand-new ones. 0 disables caching.
        </p>
        <p className="dim">{quotaLine(initial.quota)}</p>
        <label>
          Only run on these repos (one per line, <code>owner/*</code> allowed; empty means
          everywhere)
          <textarea
            rows={4}
            value={settings.allowlist.join('\n')}
            onChange={(e) =>
              setSettings({
                ...settings,
                allowlist: e.currentTarget.value.split('\n').filter(Boolean),
              })
            }
            onBlur={() => void saveSettings(settings)}
          />
        </label>
      </section>

      <section>
        <h2>Scoring</h2>
        <p className="dim">
          Receipts always show. These weights only affect the Score tab. Groups scale
          every rule inside them; 0 turns the group off and stops fetching anything only
          it needed.
        </p>

        {profile.groups.map((g) => (
          <fieldset key={g.id}>
            <legend>
              {g.label}
              <input
                type="range"
                min={0}
                max={200}
                value={g.importance * 100}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    groups: profile.groups.map((x) =>
                      x.id === g.id
                        ? { ...x, importance: Number(e.currentTarget.value) / 100 }
                        : x,
                    ),
                  })
                }
                onMouseUp={() => commitProfile(profile)}
                onTouchEnd={() => commitProfile(profile)}
              />
              <output>{Math.round(g.importance * 100)}%</output>
            </legend>
            {profile.rules
              .filter((r) => r.group === g.id)
              .map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  onMode={(mode) =>
                    commitProfile({
                      ...profile,
                      rules: profile.rules.map((x) =>
                        x.id === r.id ? { ...x, mode } : x,
                      ),
                    })
                  }
                />
              ))}
          </fieldset>
        ))}

        <button
          type="button"
          onClick={() => {
            void loadOptions({ resetProfile: true }).then((s) => {
              setProfile(s.profile);
              onState(s);
            });
          }}
        >
          Reset scoring to defaults
        </button>
      </section>
    </main>
  );
}

function RuleRow({ rule, onMode }: { rule: Rule; onMode: (m: Rule['mode']) => void }) {
  return (
    <div className="rule">
      <select
        value={rule.mode}
        onChange={(e) => onMode(e.currentTarget.value as Rule['mode'])}
      >
        <option value="score">Score</option>
        <option value="info">Show only</option>
        <option value="off">Off</option>
      </select>
      <span className="rule-name">
        {rule.signal}
        {rule.evidence ? (
          <em className={`ev ev-${rule.evidence}`}>{rule.evidence}</em>
        ) : null}
      </span>
      {rule.note ? <p className="dim note">{rule.note}</p> : null}
    </div>
  );
}

function TokenNote({ state }: { state: TokenState }) {
  switch (state.status) {
    case 'ok':
      return <p className="ok">Token works. Signed in as {state.login}.</p>;
    case 'bad':
      return <p className="bad">{state.message}</p>;
    default:
      return (
        <p className="dim">
          Without a token the panel cannot read anything and will say so.
        </p>
      );
  }
}
