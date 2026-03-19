# SPK Network 2.0 (HivePoA)

Decentralized storage validation protocol built on the Hive L1 blockchain. Validators run Proof of Access (PoA) challenges against IPFS storage nodes, earn HBD micropayments for honest work, and broadcast results on-chain via `custom_json` operations. A shared **multisig treasury** (`@hivepoa-treasury`) distributes rewards without any single point of failure.

**Live Demo:** [dhenz14.github.io/HivePoA](https://dhenz14.github.io/HivePoA/) (static site — browse the UI without a backend)

## Architecture

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, shadcn/ui, TanStack Query, Wouter
- **Backend**: Express.js, PostgreSQL (Drizzle ORM), WebSocket (ws), pino structured logging
- **Blockchain**: Hive L1 via `@hiveio/dhive` — Keychain auth, HBD transfers, `custom_json` broadcasts, **native L1 multisig** (weighted `account_auths`)
- **Storage**: IPFS (Kubo) — file pinning, CID refs sync, chunked uploads
- **Desktop Agent**: Electron with bundled Kubo IPFS node, auto-updates, and **treasury auto-signer**

## Key Features

| Feature | Description |
|---------|-------------|
| **Multisig Treasury** | Hive L1 native multisig on `@hivepoa-treasury` — tiered quorum (60%/80%), fluid authority rotation, auto-signing, self-healing, emergency freeze, time-delay veto, anomaly detection |
| **Proof of Access (PoA)** | Refs-only verification with 25s anti-cheat timing, consecutive-fail banning, reputation scoring |
| **Web of Trust** | Witnesses vouch for non-witness validators — cascading trust with automatic revocation. Extended for treasury signer eligibility |
| **HBD Micropayments** | Contract-funded rewards with batched payouts via multisig treasury (fallback: direct validator transfer) |
| **Hive Keychain Auth** | Challenge-response signature verification for all users and validators |
| **3Speak Integration** | Browse, search, and pin 3Speak videos directly to your IPFS node |
| **Hybrid Encoding** | Local FFmpeg transcoding + remote encoding marketplace with agent API keys |
| **P2P CDN** | WebRTC peer-to-peer video delivery via p2p-media-loader with segment caching in IndexedDB |
| **Storage Contracts** | Uploader-funded storage with per-challenge rewards, budget tracking, and automatic expiry |
| **Validator Dashboard** | Real-time challenge monitoring, reputation history, blacklist management |
| **Treasury Dashboard** | Authority ring visualization, signer status, WoT vouching, signature progress, transaction history, audit log viewer |
| **Governance** | Live validator rankings by reputation, network health stats, treasury status sidebar |
| **GPU Compute Marketplace** | Typed workload execution (eval sweeps, benchmarks, LoRA training, data generation) with lease-based job assignment, three-stage payouts, warm-up reputation via directed protocol-conformance challenges, and content-addressed artifacts |
| **Spirit Bomb Community Cloud** | Permissionless GPU pooling — community members share GPUs to create a collective AI brain. Elastic tiers (14B→32B→80B), geo-aware clustering, MoE expert distribution, EAGLE-3 speculative decoding, HBD rewards for contributors. See [How GPU Sharing Works](https://github.com/Dhenz14/Hive-AI/blob/main/docs/HOW_GPU_SHARING_WORKS.md) |
| **Dual-Mode AI Inference** | Local mode (Ollama, free, private, offline) + Cluster mode (community GPUs via vLLM pipeline parallel). Automatic fallback. `/inference` chat UI with mode selector |
| **VRAM Class Certification** | Phase 2B hardware verification — VRAM evidence table, CERTIFIED/REVOKED/UNCERTIFIED derivation, calibrated profiles for gpu-small-v2 and gpu-medium-v2 |
| **Hive Blockchain Publishing** | Tier manifests published on-chain via `custom_json` (`spiritbomb_manifest`), IPFS expert weight sharding with SHA-256 verification |
| **Validator Opt-In/Out** | Eligible users choose whether to activate as a validator — resign any time from the dashboard |
| **Content Moderation** | Community flagging, uploader bans, auto-blocklist for confirmed threats |
| **Dark / Light Theme** | Toggle in the sidebar footer, persisted to localStorage |

## Project Scale

- 210+ API endpoints across 30+ services
- 60 database tables (Drizzle ORM, dual PostgreSQL + SQLite dialect)
- 31 client pages including Spirit Bomb AI Inference, Community Cloud Dashboard, Quick Start wizard
- 567+ automated tests across 26 test suites (vitest) + 51 Python Spirit Bomb tests
- Full Docker deployment stack (vLLM multi-machine via Ray, coordinator, ping server)
- Companion project: [Hive-AI](https://github.com/Dhenz14/Hive-AI) — 21 Python modules for distributed inference, training, and GPU cluster management
- GitHub Pages static site with auto-deploy

## Multisig Treasury

The treasury system eliminates single points of failure for HBD reward distribution. Instead of each validator paying storage nodes from their own wallet, rewards flow through a shared multisig account controlled by multiple Hive witnesses.

### How It Works

1. **PoA engine** determines a storage node earned a reward (e.g., `0.150 HBD`)
2. **Treasury coordinator** builds an unsigned Hive transaction and computes its canonical digest
3. **Signing request** is sent to all connected signer agents over the existing `/ws/agent` WebSocket
4. **Desktop agents** verify the digest independently, check local policy (op type whitelist, per-tx cap, daily cap), and auto-sign
5. Once **60% of signers** have signed, the transaction broadcasts to Hive L1
6. **Instant, free** — Hive transactions have 3-second block times and zero fees

### Fluid Authority Rotation

When signers join or leave, the on-chain authority updates automatically:

```
4 signers → threshold = 3 (ceil(4 * 0.6))
5th joins → threshold = 3 (ceil(5 * 0.6))  — authority update co-signed by existing 4
10 signers → threshold = 6 (ceil(10 * 0.6))
4 leave → threshold = 4 (ceil(6 * 0.6))  — authority update co-signed by remaining
```

Every authority change is an L1 `account_update` transaction, co-signed by the current authority holders. No manual key management.

### Self-Healing

Every 10 minutes, the coordinator compares on-chain authority with the database signer set. If a signer was deranked from top-150 witnesses (or lost WoT vouches), they're auto-removed and a corrective authority update broadcasts.

### Security

- **Agent-side digest verification**: Agents independently compute `cryptoUtils.transactionDigest(tx, chainId)` and reject mismatches — prevents a compromised server from submitting tampered transactions
- **Operations cross-verification**: Agent verifies `request.operations` matches `request.tx.operations` exactly — prevents policy-bypass attacks where benign ops pass policy but tx contains different operations
- **Nonce replay protection**: Both server and agent track seen nonces with LRU eviction — duplicate signing requests are rejected
- **Protocol version validation**: Agent rejects requests with unexpected protocol version, enabling safe upgrades
- **Cryptographic signature verification**: Server verifies each signature via `dhive Signature.recover()` against the signer's on-chain active key before accepting
- **Server-side spending caps**: $5/tx and $200/day server-side limits mirror agent policy as defense-in-depth
- **Signer re-validation at broadcast**: Before broadcasting, server re-checks every signer is still active/eligible — late removals invalidate their signatures
- **Treasury audit log**: Every signing event (request, sign, reject, broadcast, expire) is recorded in `treasury_audit_log` for forensic analysis
- **Persistent daily spend**: Agent persists daily spend state to disk — restarts don't reset the daily cap
- **Local-only policy**: Agent policy configuration cannot be overridden remotely by the server
- **Broadcast race guard**: `broadcastingTxIds` Set prevents concurrent broadcast attempts when signatures arrive simultaneously
- **Churn protection**: 7-day cooldown after opting out, escalating to 30 days for frequent churners (3+ opt-outs in 90 days)
- **Genesis bootstrap**: `TREASURY_GENESIS_KEY` env var for initial authority setup, removed after first multisig update

### Eligibility

- **Top-150 Hive witnesses**: Opt in directly — they ARE the trust layer
- **WoT-vouched users**: Non-witnesses need 3+ vouches from top-150 witnesses via the treasury vouch system

### Treasury API

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/treasury/status` | Public | Signer count, threshold, balance, operational status |
| GET | `/api/treasury/signers` | Public | Active signers with online status |
| POST | `/api/treasury/join` | Top-150 witness | Opt in as signer |
| POST | `/api/treasury/leave` | Active signer | Opt out with cooldown |
| GET | `/api/treasury/transactions` | Signer | Recent treasury transactions |
| GET | `/api/treasury/transactions/:id` | Signer | Single tx with signature progress |
| POST | `/api/treasury/freeze` | Active signer | Emergency freeze — halts all operations |
| POST | `/api/treasury/unfreeze` | Active signer | Vote to unfreeze (80% supermajority) |
| POST | `/api/treasury/transactions/:id/veto` | Active signer | Veto a delayed transaction |
| GET | `/api/treasury/audit-log` | Signer | Recent audit log entries (limit, max 200) |
| POST | `/api/wot/treasury-vouch` | Witness | Vouch for a treasury signer candidate |
| DELETE | `/api/wot/treasury-vouch` | Witness | Revoke treasury vouch |
| GET | `/api/wot/treasury-vouches` | Public | All active treasury vouches |

## Content Moderation

Community-driven content flagging and uploader ban system to protect storage nodes from harmful content.

### Community Flagging

Any authenticated user can flag content by CID. Flags accumulate — when multiple users flag the same content, the count increases signaling urgency. Validators review flags and confirm or dismiss them.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/flags` | Bearer | Flag content (reason: illegal, copyright, malware, spam, harassment) |
| GET | `/api/flags` | Public | List all flags (filter by `?status=pending`) |
| GET | `/api/flags/summary` | Public | Aggregated flagged content dashboard |
| GET | `/api/flags/cid/:cid` | Public | Flags for a specific CID |
| PATCH | `/api/flags/:id/review` | Bearer | Confirm or dismiss a flag |

Critical confirmed flags are **auto-added to the network blocklist** — storage nodes will refuse to pin that CID.

### Uploader Bans

Node operators can ban uploaders by Hive username. Bans have two scopes:

- **Local**: Applies to your node only
- **Network**: Broadcast as recommendation to other validators

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/bans` | Bearer | Ban an uploader |
| GET | `/api/bans` | Public | List active bans |
| GET | `/api/bans/check/:username` | Public | Check if user is banned |
| DELETE | `/api/bans/:id` | Bearer | Remove a ban |

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

### Desktop Agent (Electron)

```bash
cd desktop-agent
npm install
npm run dev    # Development mode
npm run build  # Production build
```

### Desktop Agent (Headless CLI — Linux Servers)

Run the agent without Electron on Ubuntu/Debian servers:

```bash
cd desktop-agent
npm install
npm run build:cli

# Start with wallet password and Hive username
SPK_WALLET_PASSWORD=mypassword SPK_HIVE_USERNAME=myuser node dist-cli/cli.js
```

Environment variables for CLI mode:

| Variable | Required | Description |
|----------|----------|-------------|
| `SPK_WALLET_PASSWORD` | For signing | Unlocks the encrypted wallet on startup |
| `SPK_HIVE_USERNAME` | For P2P/treasury | Hive username (overrides saved config) |
| `SPK_API_PORT` | No | API port (default: 5111) |
| `SPK_SERVER_URL` | No | Central server URL (default: `http://localhost:5000`) |

Keys are stored in `~/.spk-ipfs/wallet/wallet.json` encrypted with AES-256-GCM. The password is never persisted in CLI mode — provide it via env var each startup.

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

### GitHub Pages (Static Site)

The app auto-deploys to [dhenz14.github.io/HivePoA](https://dhenz14.github.io/HivePoA/) on every push to `main`. In static mode:

- **Works without a backend**: Browse the UI, view pages, toggle dark/light theme
- **Login requires a backend**: Either run the full server locally or run the Desktop Agent (port 5111) — the app auto-detects which is available
- **No validator ops**: Challenge queue, fraud detection, and payouts need the Express server + PostgreSQL

### Windows Development Notes

```bash
# Port 5000 may conflict on Windows — use PORT=3000
export PORT=3000

# If IPFS Kubo is installed separately (not bundled), the server auto-detects
# an external daemon on port 5001 before trying to start its own

# pgcrypto extension is required
psql -U postgres -d hivepoa -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# Start the dev server
export NODE_ENV=development DATABASE_URL=postgresql://postgres@localhost:5432/hivepoa IPFS_API_URL=http://127.0.0.1:5001 PORT=3000
npx tsx server/index.ts
```

## Environment Variables

See [.env.example](.env.example) for all variables with documentation.

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
| `TREASURY_ENABLED` | No | Enable multisig treasury mode (default: disabled) |
| `TREASURY_GENESIS_KEY` | No | One-time private key for bootstrapping initial authority |

Services fall back to mock/simulation mode when keys are not configured. Treasury falls back to direct validator-to-node transfers when disabled or not operational.

## Authentication

Three auth schemes:

1. **Bearer Token** — Hive Keychain challenge-response login -> session token for all user endpoints
2. **Agent API Key** — `POST /api/encoding/agent/register` -> API key for encoding agent endpoints
3. **Webhook HMAC** — `X-Webhook-Signature` header verified against `ENCODING_WEBHOOK_SECRET`

## Web of Trust

Witnesses can vouch for non-witness Hive users, granting them validator access. The WoT extends to treasury signer eligibility via a separate vouch system.

### Validator WoT (1:1)

- Each witness can vouch for exactly **1** non-witness user (UNIQUE constraint)
- Vouched users get full validator access (dashboard, challenges, payouts)
- If the witness drops out of top 150, their vouched user **automatically loses access** (cascading revocation)
- Vouched users **cannot** vouch for others (no transitive trust chains)

### Treasury WoT (1:N)

- Each witness can vouch for **multiple** treasury signer candidates
- A candidate needs **3+** vouches from top-150 witnesses to qualify
- If a voucher drops from top-150, their vouch is **automatically revoked**
- If a candidate drops below 3 vouches, they're **removed from the signer set**

**WoT API Endpoints:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/wot` | Public | List all active validator vouches |
| GET | `/api/wot/:username` | Public | Check vouch status for a user |
| POST | `/api/wot/vouch` | Witness | Vouch for a non-witness validator |
| DELETE | `/api/wot/vouch` | Witness | Revoke your validator vouch |
| POST | `/api/wot/treasury-vouch` | Witness | Vouch for a treasury signer candidate |
| DELETE | `/api/wot/treasury-vouch` | Witness | Revoke treasury vouch |
| GET | `/api/wot/treasury-vouches` | Public | All active treasury vouches grouped by candidate |

## Validator Opt-In / Opt-Out

Eligible users (top-150 witnesses or vouched by a witness) are **not** auto-assigned as validators. On first login, an opt-in dialog asks whether they want to activate validator duties.

- **Opt in**: Click "Activate Validator" in the dialog or sidebar
- **Resign**: Click "Resign" on the Validator Dashboard header — confirmation required
- **Re-activate**: Click "Activate Validator" in the sidebar at any time

**API Endpoints:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/validator/opt-in` | Bearer | Activate validator role |
| POST | `/api/validator/resign` | Bearer | Deactivate validator role |

## Storage Economics

Uploaders fund storage contracts with HBD. PoA challenges verify that nodes actually store the data, and successful proofs are rewarded from the contract budget. When the multisig treasury is operational, rewards are paid from `@hivepoa-treasury` via co-signed transactions. Otherwise, validators pay directly from their own wallets as a fallback.

**How it works:**

1. Uploader creates a storage contract: `POST /api/contracts/create` with CID, budget, duration, replicas
2. Uploader sends HBD to the system account on Hive with the provided `depositMemo`
3. Uploader verifies the deposit: `POST /api/contracts/:id/fund` with the Hive tx hash
4. Contract activates — PoA engine begins challenging nodes that store this CID
5. Each successful proof deducts `rewardPerChallenge` from the contract budget
6. Contract completes when budget is exhausted or duration expires

**Contract API:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/contracts/create` | Bearer | Create storage contract |
| POST | `/api/contracts/:id/fund` | Bearer | Verify Hive deposit, activate |
| POST | `/api/contracts/:id/cancel` | Bearer | Cancel (owner only) |
| GET | `/api/contracts` | Public | List all contracts with budget info |
| GET | `/api/contracts/active` | Public | List active contracts |
| GET | `/api/contracts/:id` | Public | Contract details with spending rate |

### Storage Tiers (v1.1)

Fixed annual plans priced in HBD (HBD ≈ $1 USD peg, no oracle needed):

| Tier | Storage | Price | Duration |
|------|---------|-------|----------|
| Starter | 5 GB | 3.999 HBD | 365 days |
| Standard | 10 GB | 6.999 HBD | 365 days |
| Creator | 20 GB | 11.999 HBD | 365 days |

Tier contracts cover **all** of a user's uploaded files (not per-CID). The PoA engine distributes rewards from the tier budget to storage nodes that prove they hold any of the user's files. Users can overpay to increase reward density (higher economic incentive for nodes), though overpay is an incentive mechanism, not a guaranteed redundancy SLA.

**Tier API:**

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/storage/tiers` | Public | List available tiers with prices |
| GET | `/api/storage/usage` | Bearer | Current usage, active tier, remaining capacity |
| POST | `/api/storage/subscribe` | Bearer | Create tier-backed annual contract (tierId only) |
| POST | `/api/storage/topup` | Bearer | Add HBD to existing contract |

Upload cap enforcement: `POST /api/upload/simple` returns `413` if `usedBytes + fileSize` would exceed the active tier's storage limit. Concurrent uploads are serialized per-user to prevent TOCTOU quota bypass.

## P2P CDN (Viewers as CDN)

Every viewer watching a video automatically redistributes content to other viewers via WebRTC peer swarm, reducing origin server load by up to 70-80%.

**Architecture:**
- `p2p-media-loader-hlsjs` creates a WebRTC swarm per video (keyed by CID)
- HLS segments are shared peer-to-peer via WebTorrent trackers
- Segments are cached in IndexedDB (500MB budget, 7-day TTL) so returning viewers seed from cache
- Desktop agents auto-pin popular content (`/api/p2p/popular`) for 24/7 seeding
- Stats reported via `navigator.sendBeacon` on session end -> `POST /api/p2p/report`

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
- **Encrypted Wallet**: Private keys stored with AES-256-GCM encryption, PBKDF2 key derivation (600K iterations, SHA-512). Keys decrypted only at startup, never persisted in plaintext
- **Treasury**: Agent-side digest + operations verification, nonce replay protection, cryptographic signature verification, server-side spending caps, signer re-validation at broadcast, persistent audit log, local-only policy config
- **Treasury Hardening (6 layers)**: Batch limits (10 ops/tx, $10 HBD/batch), tiered quorum (80% for authority updates vs 60% for transfers), recipient allowlist (active storage nodes only), emergency freeze (any signer triggers, 80% supermajority to unfreeze), time-delay with veto (1hr for >$1 transfers, 6hr for authority updates), anomaly detection with auto-freeze (burst, amount spike, rapid succession, new-recipient alerts)
- **Content Moderation**: Community flagging with severity levels, auto-blocklist for confirmed critical threats, uploader bans by Hive username (local/network scope)
- **API Auth Enforcement**: All mutation endpoints enforce ownership checks — users cannot modify another user's settings, blacklists, beneficiaries, encryption keys, or encoding offers
- **PoA Safety**: Proof accumulator auto-purges stale entries (24h TTL), block selection loop guaranteed to terminate, session maps capped to prevent memory exhaustion

## Security Audit (March 2026)

Deep 6-agent audit across the full codebase — 25 fixes applied, 168 tests pass, zero TypeScript errors.

### Phase 1 — Security (5 fixes)

- **SQL injection**: Replaced `sql.raw()` with parameterized `ANY()` arrays in `claimComputeJobAtomic`
- **Code injection**: Replaced `eval(videoStream.r_frame_rate)` with safe fraction parsing
- **Authorization bypass**: Added ownership check on `PATCH /api/validator/payout/reports/:id`
- **Session hijack**: Replaced singleton challenge with concurrent-safe Map in desktop agent auth
- **Replay attack**: Record PubSub challenge nonce before rate-limit check to prevent replay after window expires

### Phase 2 — Correctness (4 fixes)

- **PoA cooldown bypass**: Skip challenge entirely when node-file combo still on cooldown after max retries
- **Unhandled rejection**: Per-item error handling in beneficiary node enrichment
- **TOCTOU race**: Atomic SQL `GREATEST(jobs_in_progress - 1, 0)` for compute node job counter
- **React infinite loop**: Removed `connectedPeers.length` from P2PVideoPlayer useEffect deps, used ref instead

### Phase 3 — Performance (5 fixes)

- **Memory leak**: Periodic purge of `p2pReportLimiter` Map (was growing unbounded per IP)
- **N+1 query**: Single SQL query with `OR` conditions for `getEffectiveBlocklist` (was loop of queries)
- **Client-side filtering**: Pushed compute node workload filtering to SQL `LIKE` clause
- **Full table scan**: Replaced JS grouping in `getFlaggedContentSummary` with SQL `GROUP BY` / `STRING_AGG`
- **Redundant crypto**: Compute `sig.recover()` once outside loop in Hive signature verification

### Phase 4 — Hardening (8 fixes)

- Trust registry logs error detail on witness check failure (was silent catch)
- Block hash refresh has concurrency guard (prevents overlapping Hive API calls)
- `ipfsOnline` in PoA status now reflects real IPFS status (was hardcoded `false`)
- Treasury daily cap boundary uses `>=` (was `>`, off-by-one on exact reset second)
- IPFS commitment verification logs error on catch
- Validator `start()` calls `stop()` first to prevent timer leaks on restart
- `pendingChallenges` map capped at 100 entries (prevents unbounded memory growth)
- Peer stale detection uses local time (prevents TTL manipulation via clock skew)

## Build

```bash
npm run build  # Vite (client) + esbuild (server) -> dist/
npm start      # Production: node dist/index.cjs
```

## License

MIT
