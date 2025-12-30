# SPK Desktop Agent

24/7 IPFS node for earning HBD rewards on the SPK Network.

## Features

- **One-Click Install**: Download, run, done. IPFS auto-initializes.
- **System Tray**: Runs in background, minimizes to tray.
- **Auto-Start**: Launches with your computer (optional).
- **Web App Integration**: Detected automatically by the SPK web app on port 5111.

## Architecture

```
┌─────────────────────────────────────┐
│  SPK Desktop (Tauri)               │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  Dashboard UI (HTML/JS)      │  │
│  │  - Status display            │  │
│  │  - Storage stats             │  │
│  └──────────────────────────────┘  │
│               ↕                     │
│  ┌──────────────────────────────┐  │
│  │  Rust Backend                │  │
│  │  - Kubo Manager              │  │
│  │  - HTTP API (port 5111)      │  │
│  │  - System Tray               │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
            ↕
    ┌───────────────┐
    │ Kubo Daemon   │
    │ (Bundled)     │
    └───────────────┘
```

## Development

### Prerequisites

- Rust (latest stable)
- Node.js 18+
- Tauri CLI: `cargo install tauri-cli`

### Setup

```bash
cd desktop-agent

# Install dependencies
npm install

# Download Kubo binary for your platform
npm run download-kubo

# Development mode
npm run dev

# Build for production
npm run build
```

## API Endpoints (Port 5111)

The desktop agent exposes an HTTP API for the web app:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Agent status, peer ID, stats |
| `/api/config` | GET | Current configuration |
| `/api/pin` | POST | Pin a CID |
| `/api/unpin` | POST | Unpin a CID |
| `/api/pins` | GET | List all pinned CIDs |

## Building for Distribution

```bash
# Build for current platform
npm run build

# Output in:
# - Windows: src-tauri/target/release/bundle/msi/
# - macOS: src-tauri/target/release/bundle/dmg/
# - Linux: src-tauri/target/release/bundle/deb/
```

## Code Origins

This desktop agent repurposes patterns from:
- `server/services/ipfs-manager.ts` - IPFS daemon management
- `client/src/lib/desktop-agent.ts` - API protocol
- SPK Network's oratr - Upload/pin workflows
- SPK Network's trole - Health scoring
