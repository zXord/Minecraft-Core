# Project Structure

This document explains the organization of the Minecraft Core project and the purpose of each directory.

## Overview

Minecraft Core is an Electron-based application built with Svelte for the frontend. The project follows a clear separation of concerns with dedicated directories for different types of files.

## Directory Structure

```
minecraft-core/
├── .github/              # GitHub Actions workflows and CI/CD
├── .kiro/                # Kiro IDE settings (gitignored)
├── build-resources/      # Source files for building installers
├── config/               # Configuration files
├── docs/                 # Project documentation
├── electron/             # Electron main process code
├── public/               # Static assets served by Vite
├── scripts/              # Build and utility scripts
├── shared/               # Code shared between renderer and main process
├── src/                  # Frontend source code (Svelte)
├── tests/                # Test files
├── dist/                 # Build output (gitignored)
└── node_modules/         # Dependencies (gitignored)
```

## Directory Details

### `.github/`
Contains GitHub Actions workflow files for automated releases and CI/CD pipelines. These workflows handle building and publishing releases when tags are pushed.

### `build-resources/`
Source files required for building the application installer:
- `icon.ico` - Application icon (generated from root `icon.png`)
- `uninstaller.nsh` - NSIS script for custom uninstaller behavior

**Note:** This directory contains source files that should be committed to version control, not generated build artifacts.

### `config/`
Configuration files for the development environment:
- `dev-config.cjs` - Development-specific configuration used by the Electron main process

### `docs/`
Project documentation including this file and IDE setup instructions.

### `electron/`
Electron main process code:
- `main.cjs` - Main entry point for Electron
- `preload.cjs` - Preload script for secure IPC
- `ipc/` - IPC handlers for communication between renderer and main
- `services/` - Backend services (server management, mod handling, etc.)
- `utils/` - Utility functions for the main process
- `watchdog/` - Process monitoring and crash detection

### `public/`
Static assets that are served directly by Vite without processing:
- `icon.png` - Application icon
- `vite.svg` - Vite logo
- `logger-window.html` - Standalone logger window

### `scripts/`
Build automation and utility scripts:
- `afterPack.cjs` - Post-packaging script for electron-builder
- `generate-icon.cjs` - Generates `.ico` file from `icon.png`
- `post-build.mjs` - Post-build processing for Vite output
- `clear-store.cjs` - Utility to clear electron-store data

### `shared/`
Code that is used by both the renderer process (frontend) and main process (backend):
- `utils/` - Shared utility functions
  - `retention-optimization.js` - Backup retention logic

### `src/`
Frontend source code (Svelte application):
- `App.svelte` - Root Svelte component
- `main.js` - Frontend entry point
- `router.js` - Client-side routing
- `components/` - Reusable Svelte components
- `routes/` - Page components for different routes
- `stores/` - Svelte stores for state management
- `utils/` - Frontend utility functions
- `assets/` - Images, fonts, and other assets
- `types/` - TypeScript type definitions

### `tests/`
Test files for the application. Tests use Node.js built-in test runner.

### Root Configuration Files

Files that must remain at the project root for tooling to discover them:
- `package.json` - Project metadata and dependencies
- `vite.config.js` - Vite bundler configuration
- `svelte.config.js` - Svelte compiler configuration
- `eslint.config.js` - ESLint linting rules
- `jsconfig.json` - JavaScript/TypeScript configuration for IDEs
- `index.html` - HTML entry point for Vite

## Build Artifacts (Gitignored)

These directories contain generated files and should not be committed:
- `dist/` - Production build output from Vite and electron-builder
- `node_modules/` - Installed npm dependencies
- `.vscode/` - Personal IDE settings (use `.vscode.example/` for shared configs)

## File Naming Conventions

- **Kebab-case** for most files: `retention-optimization.js`, `post-build.mjs`
- **PascalCase** for Svelte components: `App.svelte`, `ServerManager.svelte`
- **camelCase** for JavaScript modules: `router.js`, `logger.js`
- **UPPERCASE** for documentation: `README.md`, `PROJECT_STRUCTURE.md`

## Import Paths

When importing files, use relative paths from your current location:

```javascript
// From electron/main.cjs
import config from '../config/dev-config.cjs';

// From src/components/
import { someUtil } from '../../shared/utils/retention-optimization.js';

// From tests/
import { retentionOptimization } from '../shared/utils/retention-optimization.js';
```

## Adding New Files

When adding new files to the project:

1. **Scripts** → Place in `scripts/` directory
2. **Configuration** → Place in `config/` directory (if used by main process)
3. **Shared utilities** → Place in `shared/utils/` directory
4. **Frontend code** → Place in appropriate `src/` subdirectory
5. **Backend code** → Place in appropriate `electron/` subdirectory
6. **Tests** → Place in `tests/` directory
7. **Documentation** → Place in `docs/` directory

## Questions?

If you have questions about where a file should go or how the project is organized, refer to this document or open an issue for clarification.
