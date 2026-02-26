# SPK Network 2.0 (HivePoA)

Decentralized storage validation system with Proof of Access (PoA) and HBD payments.

## Features
- **Proof of Access (PoA)**: Cryptographic validation of file storage.
- **Desktop Agent**: Electron-based agent with integrated Kubo IPFS node and auto-updates.
- **3Speak Integration**: Browse and pin videos from 3Speak.
- **P2P CDN**: Peer-to-peer video delivery using WebRTC.
- **Hybrid Encoding**: Local (FFmpeg) and remote encoding marketplace.

## Development

### Web App & Server
1. Install dependencies: `npm install`
2. Start development server: `npm run dev`

### Desktop Agent
1. Navigate to `desktop-agent`
2. Install dependencies: `npm install`
3. Run in dev mode: `npm run dev`
4. Build: `npm run build`

## Environment Variables
- `DATABASE_URL`: PostgreSQL connection string
- `GITHUB_TOKEN`: For desktop agent releases/updates
- `IPFS_API_URL`: Local or remote IPFS API endpoint (default: http://127.0.0.1:5001)
