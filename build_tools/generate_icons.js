const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const icongen = require('icon-gen');
const sharp = require('sharp');

const rootDir = path.resolve(__dirname, '..');
const assetsDir = path.join(rootDir, 'assets');
const svgPath = path.join(assetsDir, 'icon.svg');
const iconPngPath = path.join(assetsDir, 'icon.png');
const iconsDir = path.join(assetsDir, 'icons');

const pngSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icnsSizes = [16, 32, 64, 128, 256, 512, 1024];

const ensureFile = async (filePath) => {
  await fsp.access(filePath, fs.constants.R_OK);
};

const renderPng = async (inputPath, size, outputPath) => {
  await sharp(inputPath)
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);
};

const main = async () => {
  await ensureFile(svgPath);
  await fsp.mkdir(iconsDir, { recursive: true });

  for (const size of pngSizes) {
    const outputPath = path.join(iconsDir, `${size}x${size}.png`);
    await renderPng(svgPath, size, outputPath);
    console.log(`generated ${path.relative(rootDir, outputPath)}`);
  }

  await fsp.copyFile(path.join(iconsDir, '512x512.png'), iconPngPath);
  console.log(`generated ${path.relative(rootDir, iconPngPath)}`);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wtb-icons-'));

  try {
    const requiredSizes = [...new Set([...icoSizes, ...icnsSizes])].sort((left, right) => left - right);

    for (const size of requiredSizes) {
      const outputPath = path.join(tempDir, `${size}.png`);
      await renderPng(svgPath, size, outputPath);
    }

    await icongen(tempDir, assetsDir, {
      report: true,
      ico: {
        name: 'icon',
        sizes: icoSizes,
      },
      icns: {
        name: 'icon',
        sizes: icnsSizes,
      },
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});