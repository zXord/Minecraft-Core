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
    rollupOptions: {
      input: {
        main: 'src/main.js',
        logger: 'src/logger.js'
      },
      output: {
        format: 'es'
      }
    }
  }
})
