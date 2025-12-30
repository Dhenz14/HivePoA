# SPK Desktop Agent

24/7 IPFS node for earning HBD rewards on the SPK Network.

Built with **Electron** for reliable cross-platform support.

## Features

- **One-Click Install**: Download, run, done. IPFS auto-initializes via bundled `go-ipfs`.
- **System Tray**: Runs in background, minimizes to tray.
- **Auto-Start**: Launches with your computer (optional).
- **Web App Integration**: Detected automatically by the SPK web app on port 5111.
- **PoA Challenges**: Responds to Proof-of-Access challenges from validators.
- **Earnings Tracking**: Track your HBD earnings and challenge streak.

## Architecture

```
┌─────────────────────────────────────┐
│  SPK Desktop (Electron)             │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  Dashboard UI (HTML/JS)      │  │
│  │  - Status display            │  │
│  │  - Earnings stats            │  │
│  │  - Hive account linking      │  │
│  └──────────────────────────────┘  │
│               ↕                     │
│  ┌──────────────────────────────┐  │
│  │  Main Process (Node.js)      │  │
│  │  - Kubo Manager              │  │
│  │  - HTTP API (port 5111)      │  │
│  │  - System Tray               │  │
│  │  - Config Store              │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
            ↕
    ┌───────────────┐
    │ Kubo Daemon   │
    │ (go-ipfs)     │
    │ (Bundled)     │
    └───────────────┘
```

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

## Code Origins

This desktop agent follows patterns from:
- SPK Network's 3Speak-app (Electron desktop app)
- `server/services/ipfs-manager.ts` - IPFS daemon management
- `client/src/lib/desktop-agent.ts` - API protocol
