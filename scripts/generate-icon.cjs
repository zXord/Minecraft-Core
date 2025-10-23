#!/usr/bin/env node
const path = require('path');
const fs = require('fs/promises');
const sharp = require('sharp');

const TARGET_SIZES = [256, 128, 64, 48, 32, 24, 16];

// Dynamic import for ESM module
let pngToIco;
async function getPngToIco() {
  if (!pngToIco) {
    const pngToIcoModule = await import('png-to-ico');
    pngToIco = typeof pngToIcoModule === 'function' 
      ? pngToIcoModule 
      : pngToIcoModule.default;
  }
  return pngToIco;
}

async function createPngBuffers(sourcePath) {
  const sourceBuffer = await fs.readFile(sourcePath);
  const metadata = await sharp(sourceBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Unable to determine dimensions for icon.png');
  }

  const maxDimension = Math.min(metadata.width, metadata.height);
  const effectiveSizes = TARGET_SIZES.filter((size) => size <= maxDimension);

  // Ensure we always include at least one rendition.
  const sizesToRender = effectiveSizes.length > 0 ? effectiveSizes : [Math.min(256, maxDimension)];

  const buffers = [];
  for (const size of sizesToRender) {
    const buffer = await sharp(sourceBuffer)
      .resize(size, size, {
        fit: 'cover',
        withoutEnlargement: true,
      })
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        palette: true,
      })
      .toBuffer();
    buffers.push(buffer);
  }

  return buffers;
}

async function ensureIcon() {
  const sourcePath = path.resolve('icon.png');
  const targetDir = path.resolve('build-resources');
  const targetPath = path.join(targetDir, 'icon.ico');

  try {
    await fs.access(sourcePath);
  } catch (error) {
    console.error(`Source icon not found at ${sourcePath}`);
    console.error(error);
    process.exit(1);
  }

  await fs.mkdir(targetDir, { recursive: true });

  try {
    const pngBuffers = await createPngBuffers(sourcePath);
    const pngToIcoFn = await getPngToIco();
    const icoBuffer = await pngToIcoFn(pngBuffers);
    await fs.writeFile(targetPath, icoBuffer);
    const fileStats = await fs.stat(targetPath);
    const kib = (fileStats.size / 1024).toFixed(1);
    console.log(`Generated Windows icon: ${targetPath} (${kib} KiB)`);
  } catch (error) {
    console.error('Failed to generate icon.ico from icon.png');
    console.error(error);
    process.exit(1);
  }
}

ensureIcon();
