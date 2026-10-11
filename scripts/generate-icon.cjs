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

function compressLargeIconFrames(bitmapIcon, pngBuffers) {
  // The bundled rcedit writes the low 16 bits of each resource's byte length.
  // Retain small BMP frames, but use the already-rendered PNG for larger ones.
  // Windows supports PNG-compressed ICO frames without changing their pixels.
  const count = bitmapIcon.readUInt16LE(4);
  const directory = Buffer.from(bitmapIcon.subarray(0, 6 + count * 16));
  const frames = [];
  let offset = directory.length;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = bitmapIcon.readUInt32LE(entry + 8);
    const oldOffset = bitmapIcon.readUInt32LE(entry + 12);
    const image = size > 65535 ? pngBuffers[index] : bitmapIcon.subarray(oldOffset, oldOffset + size);
    if (!image || image.length > 65535) {
      throw new Error('Icon image is too large for the Windows resource editor');
    }
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    frames.push(image);
    offset += image.length;
  }
  return Buffer.concat([directory, ...frames]);
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
    const icoBuffer = compressLargeIconFrames(await pngToIcoFn(pngBuffers), pngBuffers);
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
