# SPK Desktop Agent

24/7 IPFS node for earning HBD rewards on the SPK Network.

Built with **Electron** for reliable cross-platform support.

## Quick Start (Users)

### Windows
1. Download `SPK-Desktop-Agent-Setup-x.x.x.exe`
2. Run the installer - it creates a desktop shortcut
3. Click the **SPK Desktop Agent** icon to launch
4. The app runs in your system tray (look for the SPK icon near your clock)

### macOS
1. Download `SPK-Desktop-Agent-x.x.x.dmg`
2. Open the DMG and drag the app to Applications
3. Launch **SPK Desktop Agent** from Applications
4. The app runs in your menu bar

### Linux
1. Download `SPK-Desktop-Agent-x.x.x.AppImage`
2. Make it executable: `chmod +x SPK-Desktop-Agent-*.AppImage`
3. Double-click to run, or run from terminal
4. The app runs in your system tray

## Features

- **One-Click Install**: Download, run, done. IPFS auto-initializes via bundled `go-ipfs`.
- **System Tray**: Runs in background, minimizes to tray.
- **Auto-Start**: Launches with your computer (optional).
- **Web App Integration**: Detected automatically by the SPK web app on port 5111.
- **PoA Challenges**: Responds to Proof-of-Access challenges from validators.
- **Earnings Tracking**: Track your HBD earnings and challenge streak.
- **Treasury Auto-Signer**: Automatically co-signs multisig treasury transactions within policy limits (active key required).
- **Encrypted Wallet**: Private keys stored with AES-256-GCM encryption (PBKDF2 key derivation). Keys never persisted in plaintext.
- **Headless CLI Mode**: Run on Linux servers without Electron — same agent, no GUI.

## Architecture

```
+-------------------------------------+
|  SPK Desktop (Electron)             |
|                                     |
|  +------------------------------+  |
|  |  Dashboard UI (HTML/JS)      |  |
|  |  - Status display            |  |
|  |  - Earnings stats            |  |
|  |  - Hive account linking      |  |
|  |  - Treasury signer config    |  |
|  +------------------------------+  |
|               |                     |
|  +------------------------------+  |
|  |  Main Process (Node.js)      |  |
|  |  - Kubo Manager              |  |
|  |  - HTTP API (port 5111)      |  |
|  |  - System Tray               |  |
|  |  - Config Store              |  |
|  |  - Treasury Signer           |  |
|  +------------------------------+  |
+-------------------------------------+
            |
    +---------------+
    | Kubo Daemon   |
    | (go-ipfs)     |
    | (Bundled)     |
    +---------------+
```

## Treasury Auto-Signing

If you're a top-150 Hive witness (or have 3+ treasury vouches), you can enable treasury signing:

1. Configure your Hive **active key** in the agent config
2. Enable `treasurySignerEnabled` in your config
3. The agent auto-signs treasury transactions within policy limits

**Policy defaults:**
- Per-transaction cap: 1.0 HBD
- Daily cap: 50.0 HBD
- Rate limit: 100 signing requests/hour
- Op type whitelist: `transfer`, `account_update` only

**Security:** The agent independently verifies every transaction digest before signing. It computes `cryptoUtils.transactionDigest(tx, HIVE_CHAIN_ID)` locally and rejects if the server-provided digest doesn't match.

## Encrypted Wallet

Private keys are stored encrypted on disk using AES-256-GCM with PBKDF2 key derivation (600,000 iterations, SHA-512). Keys are decrypted once on startup and held in memory for the session — never written to disk in plaintext.

**Wallet file:** `~/.spk-ipfs/wallet/wallet.json`

```json
{
  "version": 1,
  "salt": "<hex>",
  "keys": {
    "active":  { "encrypted": "<hex>", "iv": "<hex>", "tag": "<hex>", "publicKey": "STMxxx..." },
    "posting": { "encrypted": "<hex>", "iv": "<hex>", "tag": "<hex>", "publicKey": "STMxxx..." }
  }
}
```

**Electron mode:** Wallet password is stored in the OS keychain via `electron.safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux). The wallet auto-unlocks on app start.

**CLI mode:** Wallet password is provided via `SPK_WALLET_PASSWORD` environment variable each startup. Never persisted to disk.

**Key import flow:**
1. Initialize wallet: `POST /api/wallet/init` with `{ password: "..." }` (min 8 characters)
2. Import active key: `POST /api/hive/active-key` with `{ key: "5K..." }`
3. Key is encrypted and stored — the raw key is garbage-collected
4. On restart, wallet auto-unlocks and keys are available for signing

**If password is lost:** There is no recovery. You'll need to delete `~/.spk-ipfs/wallet/wallet.json` and re-import your keys with a new password.

## Headless CLI Mode (Linux Servers)

Run the full agent on Ubuntu/Debian servers without Electron:

```bash
cd desktop-agent
npm install
npm run build:cli

# Start the agent
SPK_WALLET_PASSWORD=mypassword SPK_HIVE_USERNAME=myuser node dist-cli/cli.js
```

**Environment variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `SPK_WALLET_PASSWORD` | For signing | Unlocks the encrypted wallet |
| `SPK_HIVE_USERNAME` | For P2P/treasury | Hive username |
| `SPK_API_PORT` | No | API port (default: 5111) |
| `SPK_SERVER_URL` | No | Central server URL |

**systemd service example:**

```ini
[Unit]
Description=SPK Desktop Agent (Headless)
After=network.target

[Service]
Type=simple
User=spk
WorkingDirectory=/opt/spk-agent/desktop-agent
Environment=SPK_WALLET_PASSWORD=mypassword
Environment=SPK_HIVE_USERNAME=myuser
ExecStart=/usr/bin/node dist-cli/cli.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**What's included in CLI mode:**
- IPFS daemon management (bundled Kubo or external daemon on port 5001)
- HTTP API on port 5111
- P2P peer discovery, challenge handler, validator
- Treasury auto-signer
- Full server backend (SQLite, 154+ endpoints)

**What's NOT included:**
- System tray / GUI
- Auto-updates (use your package manager)
- OS keychain integration (use env var for wallet password)

## Development

### Prerequisites

- Node.js 18+

### Setup

```bash
cd desktop-agent

# Install dependencies (includes go-ipfs)
npm install

# Development mode
npm run dev

# Build for production
npm run build

# Package for current platform
npm run package
```

## API Endpoints (Port 5111)

The desktop agent exposes an HTTP API for the web app:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Agent status, peer ID, stats, earnings |
| `/api/config` | GET/POST | Get or update configuration |
| `/api/pin` | POST | Pin a CID `{ cid: "..." }` |
| `/api/unpin` | POST | Unpin a CID `{ cid: "..." }` |
| `/api/pins` | GET | List all pinned CIDs |
| `/api/challenge` | POST | PoA challenge response endpoint |
| `/api/earnings` | GET | Get earnings data |
| `/api/autostart` | GET/POST | Manage auto-start setting |
| `/api/wallet/init` | POST | Initialize encrypted wallet `{ password }` |
| `/api/hive/active-key` | POST/DELETE | Import or remove active key |
| `/api/hive/posting-key` | POST/DELETE | Import or remove posting key |
| `/api/treasury/signer-status` | GET | Treasury signer status |
| `/api/treasury/toggle` | POST | Enable/disable treasury signing |

## PoA Challenge Flow

1. Validator sends POST to `/api/challenge` with `{ cid, blockIndex, salt }`
2. Agent fetches the block from IPFS
3. Agent computes `SHA256(salt + blockData)` as proof
4. Agent returns `{ proof, responseTime }` within 2 second timeout

## Building for Distribution

```bash
# Build for specific platform
npm run package:win    # Windows (.exe)
npm run package:mac    # macOS (.dmg)
npm run package:linux  # Linux (.AppImage, .deb)

# Output in build/ directory
```

## Configuration

User data stored in `~/.spk-ipfs/`:
- `repo/` - IPFS repository
- `agent-config.json` - Agent configuration
- `earnings.json` - Earnings tracking
- `wallet/wallet.json` - Encrypted wallet (AES-256-GCM)
- `hivepoa.db` - SQLite database (CLI mode)

## Code Origins

This desktop agent follows patterns from:
- SPK Network's 3Speak-app (Electron desktop app)
- `server/services/ipfs-manager.ts` - IPFS daemon management
- `client/src/lib/desktop-agent.ts` - API protocol
