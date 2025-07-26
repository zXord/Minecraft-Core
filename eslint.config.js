import js from "@eslint/js";
import globals from "globals";
import sveltePlugin from "eslint-plugin-svelte";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "dist-ssr/**", "build/**"]
  },
  // JavaScript/CommonJS files
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "warn",
      "no-console": "off"
    }
  },
  // TypeScript files
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "no-unused-vars": "warn",
      "no-console": "off"
    }
  },
  // TypeScript definition files - allow unused parameters in interfaces
  {
    files: ["**/*.d.ts"],
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.browser, ...globals.node },
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "no-unused-vars": "off",
      "no-console": "off"
    }
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
      "svelte/require-each-key": "warn",
      "svelte/no-reactive-literals": "warn",
      "svelte/no-immutable-reactive-statements": "warn",
      "svelte/infinite-reactive-loop": "warn",
      "svelte/prefer-svelte-reactivity": "warn" // Downgrade to warning instead of error
    }
  }
];
