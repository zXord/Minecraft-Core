import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import sveltePlugin from "eslint-plugin-svelte";
import tsParser from "@typescript-eslint/parser";


export default defineConfig([
  {
    ignores: ["node_modules/**", "dist/**", "dist-ssr/**"]
  },
  // JavaScript files
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  // Svelte files
  ...sveltePlugin.configs["flat/recommended"],
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parser: sveltePlugin.parser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: [".svelte"]
      },
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      // Disable some strict Svelte rules that might be too noisy
      "svelte/require-each-key": "warn", // Make this a warning instead of error
      "svelte/no-reactive-literals": "warn",
      "svelte/no-immutable-reactive-statements": "warn",
      "svelte/infinite-reactive-loop": "warn"
    }
  }
]);
