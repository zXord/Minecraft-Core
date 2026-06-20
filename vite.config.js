import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  base: './', // Important for Electron
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    manifest: true, // Generate manifest.json
    // Set warning limit to 500 KB to verify optimization success
    // Build will warn if any chunk exceeds this threshold
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      input: {
        main: 'index.html',
        logger: 'src/logger.js'
      },
      output: {
        format: 'es',
        // Manual chunk configuration for code splitting optimization.
        // Keep shared state/helpers together because stores and utils reference each other.
        manualChunks: (id) => {
          const normalizedId = id.replace(/\\/g, '/');

          if (normalizedId.includes('node_modules')) {
            return 'vendor';
          }

          if (normalizedId.includes('/src/logger.js') || normalizedId.includes('/src/components/logger/')) {
            return 'logger-window';
          }

          if (normalizedId.includes('/src/components/client/')) {
            return 'feature-client';
          }
          if (normalizedId.includes('/src/components/backup/') || normalizedId.endsWith('/src/components/Backups.svelte') || normalizedId.includes('/src/utils/backup/')) {
            return 'feature-backups';
          }
          if (normalizedId.includes('/src/components/mods/') || normalizedId.endsWith('/src/components/server/ServerModManager.svelte') || normalizedId.includes('/src/utils/mods/')) {
            return 'feature-mods';
          }
          if (normalizedId.includes('/src/components/settings/')) {
            return 'feature-settings';
          }
          if (normalizedId.includes('/src/components/server/')) {
            return 'feature-server';
          }
          if (normalizedId.includes('/src/components/setup/')) {
            return 'feature-setup';
          }
          if (normalizedId.includes('/src/components/players/')) {
            return 'feature-players';
          }
          if (normalizedId.includes('/src/components/common/')) {
            return 'app-common';
          }

          if (
            normalizedId.includes('/src/stores/') ||
            normalizedId.includes('/src/utils/') ||
            normalizedId.includes('/src/modules/') ||
            normalizedId.endsWith('/src/router.js')
          ) {
            return 'app-core';
          }
        }
      }
    }
  }
})
