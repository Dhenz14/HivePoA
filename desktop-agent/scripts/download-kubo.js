#!/usr/bin/env node
/**
 * Download Kubo Binaries for Electron
 * Downloads and extracts Kubo binaries for bundling with electron-builder
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const KUBO_VERSION = 'v0.24.0';
const BINARIES_DIR = path.join(__dirname, '..', 'kubo-bin');

const PLATFORMS = {
  'darwin-x64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_darwin-amd64.tar.gz`,
    binary: 'ipfs',
    archive: 'tar.gz'
  },
  'darwin-arm64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_darwin-arm64.tar.gz`,
    binary: 'ipfs',
    archive: 'tar.gz'
  },
  'linux-x64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_linux-amd64.tar.gz`,
    binary: 'ipfs',
    archive: 'tar.gz'
  },
  'win32-x64': {
    url: `https://dist.ipfs.tech/kubo/${KUBO_VERSION}/kubo_${KUBO_VERSION}_windows-amd64.zip`,
    binary: 'ipfs.exe',
    archive: 'zip'
  }
};

async function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
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
  const binaryDest = path.join(BINARIES_DIR, config.binary);

  await download(config.url, archivePath);
  console.log('Download complete. Extracting...');

  if (config.archive === 'tar.gz') {
    execSync(`tar -xzf "${archivePath}" -C "${BINARIES_DIR}"`, { stdio: 'inherit' });
  } else {
    // Windows - use PowerShell
    try {
      execSync(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${BINARIES_DIR}' -Force"`, { stdio: 'inherit' });
    } catch {
      execSync(`unzip -o "${archivePath}" -d "${BINARIES_DIR}"`, { stdio: 'inherit' });
    }
  }

  // Move binary from kubo subfolder to bin directory
  const extractedBinary = path.join(BINARIES_DIR, 'kubo', config.binary);
  if (fs.existsSync(extractedBinary)) {
    fs.copyFileSync(extractedBinary, binaryDest);
    fs.rmSync(path.join(BINARIES_DIR, 'kubo'), { recursive: true, force: true });
  }

  fs.unlinkSync(archivePath);

  if (process.platform !== 'win32' && !platform.includes('win32')) {
    fs.chmodSync(binaryDest, 0o755);
  }

  console.log(`Kubo binary saved to: ${binaryDest}`);
  console.log('Done!');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
