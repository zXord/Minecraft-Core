import fs from 'fs/promises';
import path from 'path';

const manifestPath = path.resolve('dist/.vite/manifest.json');
const loggerTemplatePath = path.resolve('electron/logger-window.html');

async function injectBuildAssets() {
  console.log('Injecting build assets into logger-window.html...');

  try {
    // Read the manifest file
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // Find the logger's assets
    const loggerJS = manifest['src/logger.js']?.file;
    const loggerCSS = manifest['src/logger.js']?.css?.[0];

    if (!loggerJS) {
      throw new Error("Could not find logger's JavaScript file in manifest.json");
    }

    // Read the HTML template
    let htmlContent = await fs.readFile(loggerTemplatePath, 'utf-8');

    // Replace placeholders with actual asset paths
    if (loggerCSS) {
        htmlContent = htmlContent.replace(
            /<link rel="stylesheet" href="[^"]*">/,
            `<link rel="stylesheet" href="../dist/${loggerCSS}">`
        );
    } else {
         htmlContent = htmlContent.replace(/<link rel="stylesheet" href="[^"]*">/, '');
    }

    htmlContent = htmlContent.replace(
        /<script type="module" src="[^"]*"><\/script>/,
        `<script type="module" src="../dist/${loggerJS}"></script>`
    );

    // Write the updated HTML back to the file
    await fs.writeFile(loggerTemplatePath, htmlContent, 'utf-8');

    console.log('Successfully injected assets into logger-window.html.');
  } catch (err) {
    console.error('Error injecting build assets:', err);
    process.exit(1);
  }
}

injectBuildAssets(); 