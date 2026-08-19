import { createRoot, type Root } from 'react-dom/client';
import { createShadowRootUi, defineContentScript } from '#imports';
import { findMount, onPrChange, type PrContext, waitForContext } from '../content/mount';
import { Panel } from '../content/Panel';
import '../content/panel.css';

export default defineContentScript({
  matches: ['https://github.com/*/*/pull/*'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  async main(ctx) {
    // The panel is mounted once and re-rendered on Turbo navigation. It is NOT
    // torn down and rebuilt on every navigation: GitHub keeps the document
    // alive between PRs, and remounting needlessly would restart the shadow
    // root, lose the open tab, and flash. The component handles the identity
    // change instead — see the two guards in useSignals. src/content/AGENTS.md
    let root: Root | null = null;
    let mounted: Awaited<ReturnType<typeof createShadowRootUi>> | null = null;

    /**
     * Turbo does not merely swap the header's contents — it replaces the
     * subtree, and the panel is a *sibling* of the header, so it is carried out
     * with it. `mounted` stays truthy while its host is no longer in the
     * document, so "mount once" quietly became "mount once, then never again":
     * the panel vanished from the second PR onward and nothing reported it.
     *
     * Asking the host whether it is still in the document is the only reliable
     * test. WXT does not fire `onRemove` when the anchor disappears.
     */
    const attached = () => mounted?.shadowHost.isConnected === true;

    const render = async () => {
      const pr = await waitForContext();
      if (!pr) {
        mounted?.remove();
        mounted = null;
        root = null;
        return;
      }
      if (!attached()) {
        mounted?.remove();
        root = null;
        mounted = await createShadowRootUi(ctx, {
          name: 'octoscore-panel',
          position: 'inline',
          append: 'after',
          // Re-resolved by WXT after GitHub replaces the header, which Turbo
          // does routinely. A function rather than a selector string so
          // mount.ts stays the only place that knows GitHub's DOM: this used
          // to be a duplicated selector list, which drifted out of sync with
          // findMount and then broke on the Primer React rewrite while
          // findMount sat here unused.
          anchor: () => findMount(),
          onMount: (container) => {
            const r = createRoot(container);
            root = r;
            return r;
          },
          onRemove: (r) => {
            r?.unmount();
            root = null;
          },
        });
        mounted.mount();
      }
      paint(pr);
    };

    const paint = (pr: PrContext) => root?.render(<Panel ctx={pr} />);

    await render();
    const stop = onPrChange(() => void render());
    ctx.onInvalidated(stop);
  },
});
