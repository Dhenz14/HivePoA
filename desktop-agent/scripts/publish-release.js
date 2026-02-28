#!/usr/bin/env node
/**
 * Publish a GitHub Release with electron-builder artifacts.
 *
 * Usage:  npm run release          (builds + publishes)
 *    or:  node scripts/publish-release.js   (publish only, after npm run package:win)
 *
 * Requires: gh CLI authenticated (run `gh auth login` once)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const version = pkg.version;
const tag = `v${version}`;
const buildDir = path.join(__dirname, '..', 'build');

// Files electron-updater needs: installer + latest.yml
const artifacts = [];
const patterns = [
  /\.exe$/i,
  /latest\.yml$/i,
  /\.blockmap$/i,
];

if (!fs.existsSync(buildDir)) {
  console.error('No build/ directory found. Run "npm run package:win" first.');
  process.exit(1);
}

for (const file of fs.readdirSync(buildDir)) {
  if (patterns.some(p => p.test(file))) {
    artifacts.push(path.join(buildDir, file));
  }
}

if (artifacts.length === 0) {
  console.error('No release artifacts found in build/. Run "npm run package:win" first.');
  process.exit(1);
}

console.log(`Publishing ${tag} with ${artifacts.length} artifacts:`);
artifacts.forEach(f => console.log(`  ${path.basename(f)}`));

// Check if release already exists
try {
  execSync(`gh release view ${tag}`, { stdio: 'pipe' });
  console.log(`Release ${tag} already exists — uploading new assets...`);
  const fileArgs = artifacts.map(f => `"${f}"`).join(' ');
  execSync(`gh release upload ${tag} ${fileArgs} --clobber`, { stdio: 'inherit' });
} catch {
  // Release doesn't exist, create it
  const fileArgs = artifacts.map(f => `"${f}"`).join(' ');
  const cmd = `gh release create ${tag} ${fileArgs} --title "SPK Desktop Agent ${tag}" --notes "## SPK Desktop Agent ${tag}\n\n- Download the installer (.exe) or portable version\n- Auto-updates enabled for future releases\n\nSee [full changelog](https://github.com/Dhenz14/HivePoA/commits/${tag})" --latest`;
  execSync(cmd, { stdio: 'inherit' });
}

console.log(`\nDone! Release ${tag} published.`);
console.log(`https://github.com/Dhenz14/HivePoA/releases/tag/${tag}`);
