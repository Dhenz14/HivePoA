# SPK Network 2.0 (HivePoA)

Decentralized storage validation protocol built on the Hive L1 blockchain. Validators run Proof of Access (PoA) challenges against IPFS storage nodes, earn HBD micropayments for honest work, and broadcast results on-chain via `custom_json` operations.

## Architecture

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, TanStack Query, Wouter
- **Backend**: Express.js, PostgreSQL (Drizzle ORM), WebSocket (ws), pino structured logging
- **Blockchain**: Hive L1 via `@hiveio/dhive` — Keychain auth, HBD transfers, `custom_json` broadcasts
- **Storage**: IPFS (Kubo) — file pinning, CID refs sync, chunked uploads
- **Desktop Agent**: Electron with bundled Kubo IPFS node and auto-updates

## Key Features

| Feature | Description |
|---------|-------------|
| **Proof of Access (PoA)** | Refs-only verification with 25s anti-cheat timing, consecutive-fail banning, reputation scoring |
| **Web of Trust** | Witnesses vouch for non-witness validators — cascading trust with automatic revocation |
| **HBD Micropayments** | Contract-funded rewards with batched payouts (5 proofs per batch) via real Hive transfers |
| **Hive Keychain Auth** | Challenge-response signature verification for all users and validators |
| **3Speak Integration** | Browse, search, and pin 3Speak videos directly to your IPFS node |
| **Hybrid Encoding** | Local FFmpeg transcoding + remote encoding marketplace with agent API keys |
| **P2P CDN** | WebRTC peer-to-peer video delivery via p2p-media-loader with segment caching in IndexedDB |
| **Storage Contracts** | Uploader-funded storage with per-challenge rewards, budget tracking, and automatic expiry |
| **Validator Dashboard** | Real-time challenge monitoring, reputation history, blacklist management |

## Project Scale

- 140+ API endpoints across 25 services
- 43 database tables (Drizzle ORM schema)
- 24 client pages (including video watch page with P2P)
- 96 automated tests (vitest)
- Full Docker deployment stack

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 12+
- IPFS Kubo (optional — falls back to mock mode)

### Development

```bash
# Install dependencies
npm install

# Copy environment file and configure
cp .env.example .env

# Push database schema
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hivepoa npx drizzle-kit push

# Start development server (web + API)
npm run dev
```

### Desktop Agent

```bash
cd desktop-agent
npm install
npm run dev    # Development mode
npm run build  # Production build
```

### Docker

```bash
docker compose up
```

Starts PostgreSQL 15, Kubo IPFS, and the HivePoA server. App available on port 5000.

### Testing

```bash
npm test          # Run all tests
npm run test:watch # Watch mode
```

## Environment Variables

See [.env.example](.env.example) for all 15+ variables with documentation.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `HIVE_USERNAME` | No | Hive account for on-chain operations |
| `HIVE_POSTING_KEY` | No | Posting key for `custom_json` broadcasts |
| `HIVE_ACTIVE_KEY` | No | Active key for HBD transfers |
| `IPFS_API_URL` | No | IPFS API endpoint (default: `http://127.0.0.1:5001`) |
| `SPK_POA_URL` | No | SPK PoA WebSocket endpoint |
| `ENCODING_WEBHOOK_SECRET` | No | HMAC secret for encoding webhook verification |
| `PORT` | No | Server port (default: 5000) |

Services fall back to mock/simulation mode when keys are not configured.

## Authentication

Three auth schemes:

1. **Bearer Token** — Hive Keychain challenge-response login → session token for all user endpoints
2. **Agent API Key** — `POST /api/encoding/agent/register` → API key for encoding agent endpoints
3. **Webhook HMAC** — `X-Webhook-Signature` header verified against `ENCODING_WEBHOOK_SECRET`

## Web of Trust

Witnesses can vouch for one non-witness Hive user, granting them full validator access. Trust chain: if you trust the witness, you trust their pick.

**Rules:**
- Each witness can vouch for exactly **1** non-witness user (UNIQUE constraint)
- Vouched users get full validator access (dashboard, challenges, payouts)
- If the witness drops out of top 150, their vouched user **automatically loses access** (cascading revocation)
- Witnesses can revoke their vouch at any time
- Vouched users **cannot** vouch for others (no transitive trust chains)
- All vouches are public — anyone can see the web of trust

**API Endpoints:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/wot` | Public | List all active vouches |
| GET | `/api/wot/:username` | Public | Check vouch status for a user |
| POST | `/api/wot/vouch` | Witness | Vouch for a non-witness user |
| DELETE | `/api/wot/vouch` | Witness | Revoke your vouch |

## Storage Economics

Uploaders fund storage contracts with HBD. PoA challenges verify that nodes actually store the data, and successful proofs are rewarded from the contract budget.

**How it works:**

1. Uploader creates a storage contract: `POST /api/contracts/create` with CID, budget, duration, replicas
2. Uploader sends HBD to the system account on Hive with the provided `depositMemo`
3. Uploader verifies the deposit: `POST /api/contracts/:id/fund` with the Hive tx hash
4. Contract activates — PoA engine begins challenging nodes that store this CID
5. Each successful proof deducts `rewardPerChallenge` from the contract budget
6. Contract completes when budget is exhausted or duration expires

**Example — $4/year for 1 video:**

| Parameter | Value |
|-----------|-------|
| Budget | 4.000 HBD |
| Duration | 365 days |
| Replicas | 3 |
| Est. challenges/year | ~109 |
| Reward per challenge | ~0.037 HBD |
| Earnings per storer/year | ~$1.33 |

Challenge frequency is low by design (every 4 hours, 5 per round) to minimize Hive API load. Rewards are higher per challenge to compensate. Rarity multiplier (`1/replicaCount`) and streak bonuses (up to 1.5x) still apply.

**Contract API:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/contracts/create` | Bearer | Create storage contract |
| POST | `/api/contracts/:id/fund` | Bearer | Verify Hive deposit, activate |
| POST | `/api/contracts/:id/cancel` | Bearer | Cancel (owner only) |
| GET | `/api/contracts` | Public | List all contracts with budget info |
| GET | `/api/contracts/active` | Public | List active contracts |
| GET | `/api/contracts/:id` | Public | Contract details with spending rate |

## P2P CDN (Viewers as CDN)

Every viewer watching a video automatically redistributes content to other viewers via WebRTC peer swarm, reducing origin server load by up to 70-80%.

**Architecture:**
- `p2p-media-loader-hlsjs` creates a WebRTC swarm per video (keyed by CID)
- HLS segments are shared peer-to-peer via WebTorrent trackers
- Segments are cached in IndexedDB (500MB budget, 7-day TTL) so returning viewers seed from cache
- Desktop agents auto-pin popular content (`/api/p2p/popular`) for 24/7 seeding
- Stats reported via `navigator.sendBeacon` on session end → `POST /api/p2p/report`

**P2P API:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/p2p/stats` | Network-wide P2P statistics |
| GET | `/api/p2p/rooms` | Active video swarm rooms |
| GET | `/api/p2p/popular` | Trending CIDs by active peers |
| GET | `/api/p2p/contributors` | Top P2P bandwidth contributors |
| POST | `/api/p2p/report` | Report session P2P stats |

## Security

- Helmet security headers (CSP, HSTS, X-Frame-Options)
- CORS with configurable origins
- Rate limiting (100 req/min per IP, stricter on auth endpoints)
- Zod input validation on all mutation endpoints
- WebSocket heartbeats with connection limits
- Non-root Docker user

## Build

```bash
npm run build  # Vite (client) + esbuild (server) → dist/
npm start      # Production: node dist/index.cjs
```

## License

MIT
