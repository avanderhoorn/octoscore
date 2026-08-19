import { defineConfig } from 'wxt';

// Write React, ship Preact. ~5KB instead of ~45KB injected into every PR page,
// with no code change. Remove the alias if compat ever bites.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  // WXT defaults Firefox to MV2. There is no reason to ship MV2 anywhere. §12.1
  manifestVersion: 3,
  manifest: {
    name: 'OctoScore',
    description:
      "See what happened the last few times someone reviewed this contributor's work.",
    permissions: ['storage'],
    // No popup. Clicking the toolbar icon opens settings, because settings is
    // the only thing this extension has that isn't already on the PR page.
    action: {},
    host_permissions: ['https://github.com/*', 'https://api.github.com/*'],
    browser_specific_settings: {
      gecko: {
        id: 'octoscore@example.com',
        // Not 115. Firefox only began granting MV3 `host_permissions` at
        // install in 127; below that the extension installs and then silently
        // does nothing until the user finds about:addons. 128 is the nearest
        // ESR above that line. §12.1
        strict_min_version: '128.0',
        // AMO requires an explicit declaration. There is no backend, no
        // telemetry and no analytics, so the honest answer is 'none'. §12.1
        data_collection_permissions: { required: ['none'] },
      },
    },
  },
  vite: () => ({
    resolve: {
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
      },
    },
  }),
});
