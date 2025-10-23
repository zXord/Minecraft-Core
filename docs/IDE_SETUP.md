# IDE Setup Guide

This guide helps you configure your IDE for developing Minecraft Core.

## Philosophy

Minecraft Core does not commit IDE-specific configurations to the repository. This allows each developer to use their preferred editor and settings without conflicts. However, we provide recommended configurations that improve the development experience.

## Recommended Extensions

### Visual Studio Code

If you're using VS Code, we recommend installing the following extension:

- **Svelte for VS Code** (`svelte.svelte-vscode`) - Provides syntax highlighting, IntelliSense, and diagnostics for Svelte files

You can install it by:
1. Opening VS Code
2. Going to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Searching for "Svelte for VS Code"
4. Clicking Install

Or via command line:
```bash
code --install-extension svelte.svelte-vscode
```

### Other IDEs

- **WebStorm/IntelliJ IDEA** - Built-in Svelte support, enable the Svelte plugin
- **Sublime Text** - Install "Svelte" package via Package Control
- **Vim/Neovim** - Use `leafOfTree/vim-svelte-plugin` or `evanleck/vim-svelte`

## Recommended Settings

### Visual Studio Code

Create a `.vscode/settings.json` file in your local workspace (this file is gitignored) with these recommended settings:

```json
{
  "editor.formatOnSave": false,
  "editor.tabSize": 2,
  "editor.insertSpaces": true,
  "files.eol": "\n",
  "files.trimTrailingWhitespace": true,
  "files.insertFinalNewline": true,
  
  "svelte.enable-ts-plugin": true,
  "svelte.plugin.svelte.compilerWarnings": {
    "a11y-click-events-have-key-events": "ignore",
    "a11y-no-static-element-interactions": "ignore"
  },
  
  "javascript.preferences.importModuleSpecifier": "relative",
  "typescript.preferences.importModuleSpecifier": "relative",
  
  "search.exclude": {
    "**/node_modules": true,
    "**/dist": true,
    "**/.git": true
  },
  
  "files.watcherExclude": {
    "**/node_modules/**": true,
    "**/dist/**": true
  }
}
```

### WebStorm/IntelliJ IDEA

1. **Enable Svelte Support:**
   - Go to Settings → Languages & Frameworks → JavaScript → Svelte
   - Enable Svelte support

2. **Configure Node.js:**
   - Go to Settings → Languages & Frameworks → Node.js
   - Set Node interpreter to your local Node.js installation

3. **Code Style:**
   - Go to Settings → Editor → Code Style → JavaScript
   - Set tab size to 2
   - Enable "Use tab character" = false

## Project-Specific Configuration

### ESLint

The project uses ESLint for code quality. Your IDE should automatically detect the `eslint.config.js` file at the root.

To enable ESLint in VS Code:
1. Install the ESLint extension (`dbaeumer.vscode-eslint`)
2. ESLint will automatically use the project's configuration

### TypeScript

The project includes `jsconfig.json` for JavaScript IntelliSense and type checking. Your IDE should automatically use this configuration.

## Running the Project

### Development Mode

Start the development server with hot reload:
```bash
npm run dev
```

This runs both Vite dev server and Electron concurrently.

### Running Tests

Run the test suite:
```bash
npm test
```

### Building

Build the application for production:
```bash
npm run build
```

Create a distributable installer:
```bash
npm run dist
```

## Debugging

### VS Code Debugging

Create a `.vscode/launch.json` file for debugging:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Main Process",
      "type": "node",
      "request": "launch",
      "cwd": "${workspaceFolder}",
      "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron",
      "windows": {
        "runtimeExecutable": "${workspaceFolder}/node_modules/.bin/electron.cmd"
      },
      "args": ["."],
      "outputCapture": "std",
      "sourceMaps": true,
      "resolveSourceMapLocations": [
        "${workspaceFolder}/**",
        "!**/node_modules/**"
      ]
    },
    {
      "name": "Debug Renderer Process",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:5173",
      "webRoot": "${workspaceFolder}/src",
      "sourceMaps": true
    }
  ]
}
```

### Chrome DevTools

The Electron app has DevTools enabled in development mode. Press `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (Mac) to open DevTools.

## Common Issues

### Port Already in Use

If you see "Port 5173 is already in use":
1. Kill the process using that port
2. Or change the port in `vite.config.js`

### Module Not Found Errors

If you see module resolution errors:
1. Delete `node_modules/` and `package-lock.json`
2. Run `npm install` again
3. Restart your IDE

### Svelte Syntax Not Highlighted

If Svelte files aren't highlighted:
1. Ensure you have the Svelte extension installed
2. Restart your IDE
3. Check that `.svelte` files are associated with the Svelte language mode

## Git Configuration

### Recommended .gitignore Additions

Your personal `.vscode/` directory is already gitignored. If you create other IDE-specific files, ensure they're not committed:

```gitignore
# IDE
.vscode/
.idea/
*.swp
*.swo
*~
.DS_Store

# Build
dist/
node_modules/
build-resources/*.ico
```

## Contributing

When contributing to the project:
1. Follow the existing code style
2. Run `npm test` before committing
3. Ensure `npm run build` succeeds
4. Don't commit IDE-specific configurations (they're gitignored)

## Questions?

If you have questions about IDE setup or encounter issues, please open an issue on GitHub with:
- Your IDE and version
- Operating system
- Description of the problem
- Any error messages

Happy coding! 🚀
