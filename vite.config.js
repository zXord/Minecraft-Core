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
        // Manual chunk configuration for code splitting optimization
        // Strategy: Separate large dependencies, stores, and utilities into logical chunks
        // This reduces initial bundle size and improves caching
        manualChunks: (id) => {
          // Vendor chunk: Extract large third-party dependencies
          // These rarely change, so they benefit from long-term caching
          if (id.includes('node_modules')) {
            // Group heavy packages that are used across multiple routes
            if (id.includes('minecraft-data') || 
                id.includes('@xmcl') || 
                id.includes('axios') ||
                id.includes('lucide-svelte')) {
              return 'vendor';
            }
          }
          
          // Store modules: Separate Svelte stores for better caching
          // Stores are shared across routes but change independently
          if (id.includes('/stores/')) {
            return 'stores';
          }
          
          // Utility modules: Group by functional category
          // This allows route-specific utilities to load with their routes
          if (id.includes('/utils/mods/')) {
            return 'utils-mods';
          }
          if (id.includes('/utils/backup/')) {
            return 'utils-backup';
          }
          if (id.includes('/utils/metrics/')) {
            return 'utils-metrics';
          }
          if (id.includes('/utils/')) {
            return 'utils';
          }
        }
      }
    }
  }
})
