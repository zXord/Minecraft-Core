import fs from 'fs/promises';
import path from 'path';

const manifestPath = path.resolve('dist/.vite/manifest.json');
const loggerTemplatePath = path.resolve('electron/logger-window.html');
const loggerTemplateSource = path.resolve('public/logger-window.html');

async function injectBuildAssets() {
  console.log('Injecting build assets into logger-window.html...');

  try {
    // Always start from the template in /public to avoid stale asset references
    let htmlContent = await fs.readFile(loggerTemplateSource, 'utf-8');

    // Read the manifest file
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // Find the logger's assets
    const loggerJS = manifest['src/logger.js']?.file;
    const loggerCSS = manifest['src/logger.js']?.css?.[0];

    if (!loggerJS) {
      throw new Error("Could not find logger's JavaScript file in manifest.json");
    }

    // Ensure the stylesheet tag exists and points to the built asset
    if (loggerCSS) {
      if (/<link rel="stylesheet" href="[^"]*">/.test(htmlContent)) {
        htmlContent = htmlContent.replace(
          /<link rel="stylesheet" href="[^"]*">/,
          `<link rel="stylesheet" href="../dist/${loggerCSS}">`
        );
      } else {
        htmlContent = htmlContent.replace(
          '</head>',
          `  <link rel="stylesheet" href="../dist/${loggerCSS}">\n</head>`
        );
      }
    } else {
      // Remove any lingering stylesheet tag if present
      htmlContent = htmlContent.replace(/<link rel="stylesheet" href="[^"]*">/, '');
    }

    // Ensure the script tag exists and points to the built asset
    if (/<script type="module" src="[^"]*"><\/script>/.test(htmlContent)) {
      htmlContent = htmlContent.replace(
        /<script type="module" src="[^"]*"><\/script>/,
        `<script type="module" src="../dist/${loggerJS}"></script>`
      );
    } else {
      htmlContent = htmlContent.replace(
        '</body>',
        `  <script type="module" src="../dist/${loggerJS}"></script>\n</body>`
      );
    }

    // Write the updated HTML back to the file
    await fs.writeFile(loggerTemplatePath, htmlContent, 'utf-8');

    console.log('Successfully injected assets into logger-window.html.');
  } catch (err) {
    console.error('Error injecting build assets:', err);
    process.exit(1);
  }
}

injectBuildAssets(); 
