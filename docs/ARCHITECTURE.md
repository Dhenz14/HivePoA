# SPK Network 2.0 - Architecture Documentation

## System Overview

SPK Network 2.0 is a decentralized storage validation system that combines:
- **IPFS** for content-addressed storage
- **Hive blockchain** for payments, reputation, and **native L1 multisig treasury**
- **Proof of Access (PoA)** for storage verification
- **Web of Trust (WoT)** extending DPoS for validator and treasury signer eligibility

## Design Philosophy

### What We Simplified

| Original SPK | SPK 2.0 | Rationale |
|--------------|---------|-----------|
| Honeycomb smart contract layer | Direct Hive integration | Reduces complexity, fewer failure points |
| LARYNX + BROCA + SPK tokens | HBD only | Simpler economics, less speculation |
| Custom consensus | Hive DPoS (witnesses) | Leverages existing trusted validator set |
| libp2p PubSub messaging | WebSocket + REST | Easier to integrate, debug, and scale |
| Heavy Go binary | Lightweight Node.js | Faster iteration, web-native |
| Individual validator wallets | **Shared multisig treasury** | No single point of failure for fund management |

### Core Principles

1. **Stateless Validators** - No local storage required, just IPFS access
2. **Multisig Payments** - HBD flows through co-signed treasury transactions
3. **Federated Trust** - Hive Witnesses as validators and treasury signers (already trusted)
4. **Self-Healing** - Authority auto-corrects when signers join, leave, or lose eligibility
5. **Minimal Dependencies** - Only IPFS and Hive blockchain needed

---

## Component Architecture

```
+-----------------------------------------------------------------------------+
|                              SPK NETWORK 2.0                                |
+-----------------------------------------------------------------------------+
|                                                                             |
|   FRONTEND (React + Vite)                                                   |
|   +---------------------------------------------------------------------+   |
|   | Dashboard | Storage | Validators | Treasury | Wallet | Node Status  |   |
|   +---------------------------------------------------------------------+   |
|                                    |                                        |
|                                    | HTTP/WebSocket                         |
|                                    v                                        |
|   BACKEND (Express.js)                                                      |
|   +---------------------------------------------------------------------+   |
|   |                                                                     |   |
|   |   +-----------+  +----------+  +---------+  +-------------------+   |   |
|   |   |  Routes   |  |WebSocket |  | Storage |  |    Treasury       |   |   |
|   |   |  /api/*   |  | Server   |  |Interface|  |   Coordinator     |   |   |
|   |   +-----+-----+  +-----+----+  +----+----+  +--------+----------+   |   |
|   |         |              |             |                |              |   |
|   |         +--------------+------+------+----------------+              |   |
|   |                               |                                      |   |
|   |   +-----------------------+---+-----------------------+              |   |
|   |   |                   SERVICES                        |              |   |
|   |   |                                                   |              |   |
|   |   |  +------------+  +------------------+             |              |   |
|   |   |  | PoA Engine |  | Treasury Hive    |             |              |   |
|   |   |  |            |  | (dhive multisig) |             |              |   |
|   |   |  +-----+------+  +--------+---------+             |              |   |
|   |   |        |                   |                      |              |   |
|   |   |  +-----+---+  +-----------+  +--------+          |              |   |
|   |   |  |  IPFS   |  |   Hive       |  Agent |          |              |   |
|   |   |  | Client  |  |  Client      |   WS   |          |              |   |
|   |   |  +----+----+  +------+-------+ Manager |          |              |   |
|   |   |       |              |        +----+---+          |              |   |
|   |   +-------+--------------+-------------+--------------+              |   |
|   |           |              |             |                             |   |
|   +-----------+--------------+-------------+-----------------------------+   |
|               |              |             |                                 |
+---------------+--------------+-------------+---------------------------------+
                |              |             |
    +-----------v--+   +-------v--+   +------v------+
    |     IPFS     |   |   Hive   |   |  Desktop    |
    |    Network   |   |Blockchain|   |  Agents     |
    |              |   |  (L1)    |   | (Signers)   |
    +--------------+   +----------+   +-------------+
```

---

## Service Layer

### PoA Engine (`server/services/poa-engine.ts`)

The core orchestrator that:
- Schedules validation challenges against storage nodes
- Coordinates with IPFS, SPK, and Hive clients
- Records results and updates reputation
- **Routes rewards through the multisig treasury** when operational (falls back to direct transfer)
- Handles both simulation and live modes

### Treasury Coordinator (`server/services/treasury-coordinator.ts`)

The brain of the multisig treasury:
- Manages signer lifecycle (join/leave/cooldown/derank detection)
- Builds unsigned transactions and computes canonical digests
- Distributes signing requests to connected agents via WebSocket
- Collects signatures, broadcasts when threshold (60%) is met
- **Self-heals**: compares on-chain authority with DB every 10 minutes
- Handles genesis bootstrap with `TREASURY_GENESIS_KEY`
- `isOperational()` gate: requires `TREASURY_ENABLED` + authority in sync + 3+ online signers

### Treasury Hive Primitives (`server/services/treasury-hive.ts`)

Pure functions for Hive L1 multisig operations:
- `buildUnsignedTransaction()` - Fetches chain props, builds tx header, computes digest
- `assembleSignedTransaction()` - Attaches collected signatures to tx
- `broadcastMultisig()` - Calls `client.broadcast.send(signedTx)` (the multisig broadcast path)
- `buildTransferOp()` - Creates transfer operation from treasury account
- `buildAuthorityUpdateOp()` - Creates `account_update` with new signer set, preserving memo_key
- `readOnChainAuthority()` - Reads current active authority
- `authorityMatchesSigners()` - Compares on-chain vs expected
- `computeThreshold()` - `Math.ceil(N * 0.6)`

### Agent WebSocket Manager (`server/services/agent-ws-manager.ts`)

Manages WebSocket connections from desktop agents:
- Handles registration, proof challenges, commitment requests
- **Routes `SigningRequest`/`SigningResponse` messages** for treasury multisig
- `sendToSigner(username, message)` - Targets a specific agent by Hive username
- `getConnectedSignerUsernames()` - Returns online agents for signing eligibility

### Desktop Agent Treasury Signer (`desktop-agent/src/main/treasury-signer.ts`)

Agent-side auto-signing daemon:
- Receives `SigningRequest` over the existing `/ws/agent` WebSocket
- **Verifies digest independently**: computes `cryptoUtils.transactionDigest(tx, HIVE_CHAIN_ID)` and rejects if mismatch
- Policy engine: op type whitelist (`transfer`, `account_update`), per-tx cap (1 HBD), daily cap (50 HBD), rate limit (100/hr)
- Signs with Hive active key stored via Electron `safeStorage`
- Returns `SigningResponse` with hex signature

### IPFS Client (`server/services/ipfs-client.ts`)

Interfaces with IPFS nodes for `cat`, `refs`, and health checks. Supports both real IPFS API and mock mode.

### Hive Client (`server/services/hive-client.ts`)

Blockchain integration via `@hiveio/dhive`:
- `broadcastPoAResult()` - Post validation results via `custom_json`
- `transferHBD()` - Direct transfers (fallback when treasury unavailable)
- `isTopWitness()` - Witness rank verification for eligibility

---

## Data Layer

### Database Schema (`shared/schema.ts`)

45 tables total. Key treasury tables:

```
+---------------------+     +---------------------+     +-------------------------+
|  treasury_signers   |     |  treasury_vouches   |     | treasury_transactions   |
+---------------------+     +---------------------+     +-------------------------+
| id (PK)             |     | id (PK)             |     | id (PK)                 |
| username (UNIQUE)   |     | voucher_username    |     | tx_type                 |
| status              |     | candidate_username  |     | status                  |
| weight (default 1)  |     | voucher_rank_at_vouch|    | operations_json         |
| joined_at           |     | active              |     | tx_digest (UNIQUE)      |
| left_at             |     | revoked_at          |     | signatures (JSONB)      |
| cooldown_until      |     | revoke_reason       |     | threshold               |
| opt_events          |     | created_at          |     | expires_at              |
| last_heartbeat      |     +---------------------+     | initiated_by            |
| created_at          |     UNIQUE partial index:       | broadcast_tx_id         |
+---------------------+     (voucher, candidate)        | metadata (JSONB)        |
                             WHERE active = true         | created_at              |
                                                         +-------------------------+
```

Existing core tables:

```
+-------------------+     +-------------------+     +-------------------+
|   validators      |     |  storage_nodes    |     |     files         |
+-------------------+     +-------------------+     +-------------------+
| id                |     | id                |     | id                |
| hiveUsername      |     | peerId            |     | cid               |
| hiveRank          |     | hiveUsername      |     | name              |
| status            |     | reputation        |     | uploaderUsername  |
| performance       |     | totalProofs       |     | replicationCount |
| createdAt         |     | lastSeen          |     | createdAt        |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                          |
         v                         v                          v
+---------------------------+   +--------------------------+
|      poa_challenges       |   |   storage_assignments    |
+---------------------------+   +--------------------------+
| validatorId               |   | fileId                   |
| nodeId                    |   | nodeId                   |
| fileId                    |   | status                   |
| challengeData             |   | proofCount               |
| result                    |   +--------------------------+
| latencyMs                 |
+---------------------------+
```

### Storage Interface (`server/storage.ts`)

Abstraction layer for all database operations including ~15 treasury methods:
- Signers: create, getByUsername, getActive, updateStatus, updateHeartbeat
- Vouches: create, getForCandidate, getByVoucher, getAllActive, revoke, count
- Transactions: create, get, getRecent, updateSignature, updateStatus

---

## Multisig Treasury Architecture

### Transaction Signing Flow

```
  PoA Engine                 Treasury Coordinator              Desktop Agents
  (reward ready)             (server)                          (signers)
       |                           |                               |
       |  submitTransfer()         |                               |
       |-------------------------->|                               |
       |                           |                               |
       |                    Build unsigned tx                      |
       |                    Compute digest                         |
       |                    Store in treasury_transactions         |
       |                           |                               |
       |                    SigningRequest (via WebSocket)          |
       |                           |------------------------------>|
       |                           |                               |
       |                           |              Verify digest locally
       |                           |              Check policy (caps, ops)
       |                           |              Sign with active key
       |                           |                               |
       |                           |         SigningResponse       |
       |                           |<------------------------------|
       |                           |                               |
       |                    Store signature                        |
       |                    Check: sigCount >= threshold?           |
       |                           |                               |
       |                    YES -> Assemble SignedTransaction       |
       |                    Broadcast to Hive L1                   |
       |                           |                               |
       |   { success, txId }       |                               |
       |<--------------------------|                               |
```

### Authority Rotation Flow

```
  Signer joins/leaves           Treasury Coordinator           Hive L1
       |                              |                          |
       |  POST /api/treasury/join     |                          |
       |----------------------------->|                          |
       |                              |                          |
       |                       Update DB (status=active)         |
       |                       Read current signers              |
       |                       Compute new threshold             |
       |                       Read account memo_key             |
       |                       Build account_update op           |
       |                              |                          |
       |                       Distribute SigningRequest          |
       |                       to CURRENT authority holders       |
       |                              |                          |
       |                       Collect signatures                |
       |                       Threshold met                     |
       |                              |                          |
       |                       Broadcast account_update          |
       |                              |------------------------->|
       |                              |                          |
       |                              |     Authority atomically |
       |                              |     updated on-chain     |
       |                              |                          |
```

### Self-Healing Cycle (every 10 minutes)

```
1. Read all active signers from DB
2. For each signer: still a top-150 witness? Still has 3+ vouches?
   - NO -> auto-remove, revoke vouches from deranked witnesses
3. Re-read active signers after removals
4. Compare on-chain authority with expected signer set
   - Match -> authorityInSync = true
   - Mismatch -> initiate corrective account_update
5. isOperational() = TREASURY_ENABLED && authorityInSync && 3+ online signers
```

---

## Frontend Architecture

### Pages

| Page | Purpose |
|------|---------|
| Dashboard | Overview stats, recent activity |
| Storage | File management, upload |
| Validators | Validator list, status |
| **Treasury** | **Multisig dashboard: authority ring, signer list, WoT vouching, tx history** |
| Wallet | HBD balance, transactions |
| Node Status | Storage node health |
| Settings | Configuration |

### State Management

- **React Query** for server state (10-15s polling for treasury data)
- **WebSocket** for real-time updates
- **Local state** for UI-only concerns

### Component Library

- **Radix UI** primitives
- **Tailwind CSS** styling
- **shadcn/ui** component patterns

---

## Operating Modes

### Simulation Mode (Default)

```
SPK_POA_URL not set -> Simulation Mode

- Mock IPFS client with in-memory storage
- Simulated challenge success/failure
- Local database logging
- No external dependencies
- Treasury disabled (no TREASURY_ENABLED)
```

### Live Mode

```
SPK_POA_URL set -> Live Mode

- Real IPFS HTTP API
- WebSocket to SPK PoA nodes
- Hive blockchain broadcasts
- Full production operation
```

### Treasury Mode (Live Mode + TREASURY_ENABLED)

```
TREASURY_ENABLED=true -> Treasury Mode

- Rewards route through @hivepoa-treasury multisig
- Desktop agents auto-sign within policy limits
- Authority self-heals on 10-minute interval
- Fallback to direct transfer if treasury not operational
```

---

## Security Considerations

### Key Management

| Key | Storage | Purpose |
|-----|---------|---------|
| HIVE_POSTING_KEY | Server env/secrets | Sign custom_json operations |
| HIVE_ACTIVE_KEY | Server env/secrets | Sign direct HBD transfers (fallback) |
| TREASURY_GENESIS_KEY | Server env (temporary) | Bootstrap initial multisig authority |
| Agent Active Key | Electron safeStorage | Auto-sign treasury transactions |

### Attack Mitigations

| Attack | Mitigation |
|--------|------------|
| Challenge replay | Unique salt per challenge |
| Proof forgery | SHA256 cryptographic hash |
| Sybil attack | Hive account costs (RC) |
| DoS on validators | Rate limiting, witness rotation |
| **Tampered digest** | **Agent-side independent digest verification** |
| **Concurrent broadcast race** | **broadcastingTxIds Set guard** |
| **Signer churn** | **7/30-day cooldowns, opt-event tracking** |
| **Authority drift** | **10-minute self-healing sync cycle** |
| **Duplicate vouches** | **Partial unique index WHERE active=true** |

---

## Performance Characteristics

### Throughput

| Metric | Value |
|--------|-------|
| Challenges per second | ~0.2 (1 every 5 seconds) |
| Database ops per challenge | ~8 |
| IPFS calls per challenge | 1-5 |
| API response time | <50ms |
| **Treasury signing latency** | **<30s (typically <10s with 3+ online signers)** |
| **Hive block time** | **3 seconds (instant, free transactions)** |

### Scalability

- **Horizontal**: Multiple validators can run independently
- **Vertical**: Node.js handles thousands of concurrent connections
- **Database**: PostgreSQL scales to millions of records
- **Treasury**: Up to 40 signers per Hive authority (protocol limit)
