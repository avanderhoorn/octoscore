# The panel — React rules

**These rules apply to `src/options/` as well.** Read them there too.

The panel is small: four tabs, a list of rows, an expand toggle. Almost every
React mistake made in a codebase this size comes from reaching for a hook that
was not needed. Start from the position that **you do not need a hook**, and make
each one argue for itself.

## The one idea

> **The UI is a pure function of one `SignalsResponse`.**

The background does the work. It returns an object that already contains the
state (`'evidence' | 'no-read' | 'error' | 'bot'`), the error code, the staleness
flag, and the finished `ScoreResult`. The panel's entire job is to render it.

So the component tree has exactly **one** piece of async state:

```ts
type View =
  | { status: 'loading' }
  | { status: 'ready'; data: SignalsResponse };
```

There is no separate `loading`, `error`, `data` triple. There is no `isEmpty`. A
`useState` holding a boolean that could have been read off `data.state` is a bug
waiting for the two to disagree.

## Hook rules

**1. One effect in the whole content script.** It lives in `useSignals()` and it
does one thing: ask the background for data. If you are writing a second
`useEffect`, stop and explain why in the PR.

**2. Never use an effect to compute.** If a value can be derived from props or
state, derive it during render. No exceptions at this size.

```tsx
// NO — a second source of truth, one render stale, and a wasted pass
const [visible, setVisible] = useState<ScoreLine[]>([]);
useEffect(() => {
  setVisible(data.result.lines.filter((l) => l.scored));
}, [data]);

// YES
const visible = data.result.lines.filter((l) => l.scored);
```

**3. No effect may `setState` from another state value.** That is an effect
chain: state → effect → state → effect. Collapse it into one derivation or one
event handler.

**4. `useState` is for state the user creates by clicking.** Which tab is open,
which row is expanded, whether the panel is collapsed. That is the complete list.
Anything arriving from the background is not this.

**5. No `useMemo` or `useCallback` without a measurement.** Preact re-renders ~40
nodes in well under a frame. Both hooks cost a dependency array that can go
stale, and both are load-bearing only under `memo()`, which we do not use. If you
think you need one, put the number in the comment.

**6. Effects must be idempotent and cancellable.** See below — this is the one
that will actually bite.

**7. Custom hooks are for I/O and subscriptions, not for tidiness.** Moving pure
derivation into `useSomething()` makes it look stateful. Use a plain function.

## The bug this codebase will actually hit

GitHub navigates with Turbo. Moving from one PR to another **does not reload the
page and does not remount the panel**. Two things follow:

- An in-flight response for the *previous* author will land in the *current*
  render unless you guard it. The panel then shows one person's receipts under
  another person's name. This is the worst failure this tool can have, and it is
  silent.
- Dev builds double-invoke effects (StrictMode). If your effect is not
  idempotent you will see it here first, which is a gift.

So the fetch effect always looks like this:

```tsx
function useSignals(ctx: PrContext, nonce: number) {
  // Destructure first. A dependency array of primitives is stable; depending on
  // `ctx` refetches whenever the parent hands down a new object with identical
  // contents, which is every Turbo render.
  const { author, repo, prNumber } = ctx;
  const [view, setView] = useState<View>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    setView({ status: 'loading' });

    sendSignalsRequest({ login: author, repo, prNumber }).then((data) => {
      // Two guards, not one: the effect may have been torn down, and the
      // response may be for whoever we were looking at a moment ago.
      if (!live || data.login !== author) return;
      setView({ status: 'ready', data });
    });

    return () => {
      live = false;
    };
  }, [author, repo, prNumber, nonce]);

  return view;
}
```

Note `data.login !== author`. `SignalsResponse` echoes the login back precisely
so the UI can check it. Use it. The `live` flag alone is not enough, because the
component is never unmounted across a Turbo navigation.

`nonce` is how the refresh button works: a counter the user increments, which
re-runs the effect. That is what a dependency array is for — an event that should
cause I/O, expressed as a value. It is not a second effect.

## Shadow DOM

The panel mounts in a shadow root (WXT's `createShadowRootUi`). This is not
optional: Primer would style us and we would style Primer.

- **No portals to `document.body`.** A tooltip or dropdown rendered there escapes
  the shadow root and inherits GitHub's CSS. Render it inside the panel.
- **No global stylesheets, no `:root` variables.** Styles are injected into the
  shadow root. A selector that reaches outside it is a bug.
- **No `document.querySelector` from a component.** The content script finds the
  mount point once, before React exists. React owns what is inside the root and
  nothing else.
- **Measuring layout** (`getBoundingClientRect`) is the one legitimate ref use.
  Reading GitHub's DOM for *data* is not — the background already has it.

## Things this layer must never do

- Import from `src/background/`. Talk to it by message. The request helper
  (`sendSignalsRequest`) belongs in `src/shared/messaging.ts` — both sides need
  it, and putting it in `background/` is how `content/` ends up importing the
  API client by accident.
- Touch the token. It does not exist here and must not start existing.
- Call `fetch`. There is no case where the panel needs the network.
- Import `scoring/`. The score arrives finished. (`options/` may import it — it
  needs to preview what a config change does.)
- Write to `storage`. Reading UI preferences is fine; config lives in options.

## Options page

The rules above hold. Two more, because it is a form:

**One `Profile` in state, not one `useState` per field.** Edits produce a new
Profile object. Twenty pieces of field state cannot be validated as a unit and
cannot be reset in one action.

**Saving is an event handler, never an effect.** A `useEffect` that persists on
every change writes to storage on every keystroke, then races the read that
follows. Save on blur or on an explicit button.

```tsx
// NO — write storm, and it fires on the initial mount too
useEffect(() => { saveProfile(profile); }, [profile]);

// YES
<input onBlur={() => saveProfile(profile)} />
```

Validate imported profiles with valibot at the boundary — on load and on import,
where the data is untrusted. Not per keystroke.

## Before you commit

- Count the `useEffect`s you added. Justify each one in the PR body.
- Ask whether any `useState` could be a derivation. Usually one can.
- Navigate PR → PR without reloading and confirm the author name and receipts
  change together, never separately.
