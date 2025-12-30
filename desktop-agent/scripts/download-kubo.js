/**
 * Download Kubo Binaries
 * Downloads and extracts Kubo (go-ipfs) binaries for bundling with Tauri
 * 
 * Binary naming follows Tauri's external binary convention:
 * - The binary is named "kubo" (or "kubo.exe" on Windows)
 * - Tauri automatically appends the target triple suffix
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const KUBO_VERSION = 'v0.27.0';
const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

const PLATFORMS = {
  'darwin-x64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_darwin-amd64.tar.gz`,
    suffix: '-x86_64-apple-darwin',
    archive: 'tar.gz'
  },
  'darwin-arm64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_darwin-arm64.tar.gz`,
    suffix: '-aarch64-apple-darwin',
    archive: 'tar.gz'
  },
  'linux-x64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_linux-amd64.tar.gz`,
    suffix: '-x86_64-unknown-linux-gnu',
    archive: 'tar.gz'
  },
  'win32-x64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_windows-amd64.zip`,
    suffix: '-x86_64-pc-windows-msvc.exe',
    archive: 'zip'
  }
};

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        download(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  const platform = process.argv[2] || `${process.platform}-${process.arch}`;
  
  if (!PLATFORMS[platform]) {
    console.log(`Available platforms: ${Object.keys(PLATFORMS).join(', ')}`);
    console.log(`Usage: node download-kubo.js [platform]`);
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  const config = PLATFORMS[platform];
  console.log(`Downloading Kubo ${KUBO_VERSION} for ${platform}...`);

  fs.mkdirSync(BINARIES_DIR, { recursive: true });

  const archivePath = path.join(BINARIES_DIR, `kubo.${config.archive}`);
  const binaryDest = path.join(BINARIES_DIR, `kubo${config.suffix}`);

  await download(config.url, archivePath);
  console.log('Download complete. Extracting...');

  if (config.archive === 'tar.gz') {
    execSync(`tar -xzf "${archivePath}" -C "${BINARIES_DIR}"`);
    const ipfsBinary = path.join(BINARIES_DIR, 'kubo', 'ipfs');
    fs.renameSync(ipfsBinary, binaryDest);
    fs.rmSync(path.join(BINARIES_DIR, 'kubo'), { recursive: true });
  } else {
    execSync(`unzip -o "${archivePath}" -d "${BINARIES_DIR}"`);
    const ipfsBinary = path.join(BINARIES_DIR, 'kubo', 'ipfs.exe');
    fs.renameSync(ipfsBinary, binaryDest);
    fs.rmSync(path.join(BINARIES_DIR, 'kubo'), { recursive: true });
  }

  fs.unlinkSync(archivePath);

  if (process.platform !== 'win32') {
    fs.chmodSync(binaryDest, 0o755);
  }

  console.log(`Kubo binary saved to: ${binaryDest}`);
  console.log('');
  console.log('Binary naming follows Tauri convention:');
  console.log(`  Base name in tauri.conf.json: "binaries/kubo"`);
  console.log(`  Actual file name: kubo${config.suffix}`);
  console.log('');
  console.log('Done!');
}

main().catch(console.error);
