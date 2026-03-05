# Multisig Treasury Research: Deep Dive for HivePoA

## Table of Contents
1. [The Problem: Why the Treasury Needs Multisig](#1-the-problem)
2. [Hive L1 Multisig Mechanics (Verified)](#2-hive-l1-multisig-mechanics)
3. [Auto-Signing: No Popups, Pure Background Operation](#3-auto-signing)
4. [Cryptographic Approaches Compared](#4-cryptographic-approaches)
5. [HF28 Relevant Changes](#5-hf28-changes)
6. [Integration with HivePoA Dashboard](#6-dashboard-integration)
7. [Recommended Architecture](#7-recommended-architecture)
8. [Step-by-Step Implementation Blueprint](#8-implementation-blueprint)
9. [Risk Analysis & Edge Cases](#9-risk-analysis)
10. [Sources](#10-sources)

---

## 1. The Problem: Why the Treasury Needs Multisig {#1-the-problem}

### Current State
HivePoA uses a **Witness Federation** model where Top-150 Hive witnesses serve as trusted validators. The system currently operates with individual validator wallets - each witness pays storage nodes directly from their own funds.

### The Decentralization Gap
For true decentralization, a **shared treasury account** is needed where:
- Community funds pool (DHF allocations, protocol fees, etc.)
- No single person can rug-pull the treasury
- Threshold-based authorization ensures m-of-n consensus for spending
- Witness rotation doesn't break fund access

### Why Trust-Based Multisig Works Here
Hive witnesses are **already trusted**. They're publicly elected by stake-weighted voting, they run critical infrastructure, and they have massive reputations to lose. The multisig isn't about distrust - it's about **removing single points of failure**. No one witness should hold all the keys. The trust is already earned; the multisig just distributes the control.

This is fundamentally different from anonymous DeFi multisig where you need complex game theory. Here, the signers are known, reputable community members who opted in.

### Hive's Own Treasury Problem
The `@hive.fund` (DHF treasury) is controlled at the **protocol level** - funds are distributed via proposal voting, not by any key holder. However, for application-level treasuries (like HivePoA's operational fund), there is **no built-in DAO treasury primitive**. You must build it using Hive's account authority system.

The `@hiveio` account, for example, has multiple keys in its authority but its `weight_threshold` is set to **1** - meaning any single authorized key can act alone. This is NOT true multisig. True multisig requires `weight_threshold > any_single_key_weight`.

---

## 2. Hive L1 Multisig Mechanics (Verified) {#2-hive-l1-multisig-mechanics}

### Authority Structure
Every Hive account has three authority roles, each with identical structure:

```
{
  "weight_threshold": <integer>,       // Min total weight needed
  "account_auths": [                    // Other accounts as signers
    ["account_name", <weight>],
    ...
  ],
  "key_auths": [                        // Public keys as signers
    ["STMxxxxxxx", <weight>],
    ...
  ],
  "address_auths": []                   // Legacy, unused
}
```

**An account becomes multisig when no single signer's weight meets the threshold.**

### Authority Types and Their Use
| Authority | Controls | Best For |
|-----------|----------|----------|
| **Owner** | Account recovery, authority updates. 30-day recovery delay | Emergency recovery multisig |
| **Active** | Financial txs: transfers, power-ups, DHF proposals | **Treasury multisig (primary)** |
| **Posting** | Social: posts, votes, custom_json | Governance signaling |
| **Memo Key** | Encrypted messages only | Not authority-based |

### Hard Limits
- **Maximum 40 authorities** (keys + accounts combined) per role
- **Transaction expiration**: max 1 hour (HF28 may have increased this)
- **No automated threshold validation** - the blockchain rejects under-signed txs but doesn't tell you how many more signatures you need
- Authority updates require current threshold signatures (chicken-and-egg during rotation)
- **`account_auths` arrays MUST be alphabetically sorted** before broadcast

### dhive Code Example: Setting Up Multisig

```javascript
const dhive = require('@hiveio/dhive');
const client = new dhive.Client('https://api.hive.blog');

// 6-of-10 multisig on Active authority
const update_account = {
  "account": "hivepoa-treasury",
  "active": {
    "weight_threshold": 6,
    "account_auths": [
      // MUST be alphabetically sorted
      ["witness-alice", 1],
      ["witness-bob", 1],
      ["witness-carol", 1],
      ["witness-dave", 1],
      ["witness-eve", 1],
      ["witness-frank", 1],
      ["witness-grace", 1],
      ["witness-hank", 1],
      ["witness-iris", 1],
      ["witness-jack", 1]
    ],
    "key_auths": []  // Using account-based auth, not raw keys
  },
  "json_metadata": "",
  "memo_key": "STM..."  // Required field
};

// Requires current Active authority to broadcast
client.broadcast.updateAccount(
  update_account,
  dhive.PrivateKey.from("current_active_key")
);
```

### Why `account_auths` (Not `key_auths`)

| Approach | Pros | Cons |
|----------|------|------|
| **`account_auths`** (account names) | Witnesses rotate their own keys without touching treasury; human-readable | Adds indirection; each account's own authority must be secure |
| **`key_auths`** (public keys) | Direct cryptographic binding | Must update treasury authority every time a witness rotates keys |

**Decision: Use `account_auths` with witness account names.** When a witness rotates their personal Active key, the treasury doesn't need updating. The treasury authority only changes when the *set of signers* changes.

### Verification APIs (Before Broadcasting)

Two critical API calls help validate multisig transactions before broadcasting:

- **`get_potential_signatures(tx)`**: Returns all key combinations that could satisfy the threshold
- **`get_required_signatures(tx, available_keys)`**: Given available keys, returns the minimal subset needed

```javascript
// Check if we have enough signatures before broadcasting
const required = await client.database.call(
  'get_required_signatures', [tx, availableKeys]
);
if (required.length === 0) {
  // All requirements met - safe to broadcast
  await client.broadcast.send(tx);
}
```

### `account_update` vs `account_update2`

- **`account_update`** (original): Requires owner key to modify active authority
- **`account_update2`** (HF21+): Allows posting authority to sign when owner/active/memo fields are absent. Adds `posting_json_metadata` field. More flexible for partial updates.

---

## 3. Auto-Signing: No Popups, Pure Background Operation {#3-auto-signing}

### The Core Question
> "Does signing need to be a manual popup every time, or can a witness auto-accept?"

**YES, auto-signing is fully possible and is the right approach here.**

### Why Auto-Signing Makes Sense for HivePoA

The witnesses' role in the multisig is **purely trust-based**. They're not reviewing individual transactions for fraud - the PoA system deterministically calculates who gets paid and how much. The multisig exists to prevent a single-account rug, not to have humans manually approve every 0.005 HBD storage payment.

Witnesses already trust the HivePoA system with their **active key** for direct PoA reward transfers. Auto-signing multisig transactions from the treasury is the exact same trust level - just distributed across multiple signers instead of one.

### How Auto-Signing Works

The witness's HivePoA daemon (same process that runs PoA validation) holds the active key and auto-signs transactions that match **policy rules**:

```
┌─────────────────────────────────────────────────┐
│           HivePoA Daemon (per witness)           │
│                                                  │
│  ┌──────────────┐    ┌───────────────────────┐  │
│  │  PoA Engine   │    │  Multisig Signer      │  │
│  │  (existing)   │    │  (new module)         │  │
│  │               │    │                       │  │
│  │  - Challenges │    │  - Connects to coord  │  │
│  │  - Verifies   │    │    server via WS      │  │
│  │  - Reports    │    │  - Receives sign reqs │  │
│  │               │    │  - Validates policy   │  │
│  └───────┬───────┘    │  - Auto-signs if OK   │  │
│          │            │  - Returns signature  │  │
│          │            └───────────┬───────────┘  │
│          │                        │              │
│          └────────┬───────────────┘              │
│                   │                              │
│           ┌───────▼───────┐                      │
│           │  Active Key   │                      │
│           │  (already     │                      │
│           │   configured) │                      │
│           └───────────────┘                      │
└─────────────────────────────────────────────────┘
```

### Policy-Based Auto-Signing Rules

The daemon auto-signs a transaction **only if ALL rules pass**:

```javascript
function shouldAutoSign(tx) {
  for (const op of tx.operations) {
    const [type, data] = op;

    // Rule 1: Only allow known operation types
    if (!['transfer', 'transfer_to_vesting', 'custom_json'].includes(type)) {
      return { sign: false, reason: `Blocked op type: ${type}` };
    }

    // Rule 2: Transfers must come FROM the treasury account
    if (type === 'transfer' && data.from !== TREASURY_ACCOUNT) {
      return { sign: false, reason: 'Transfer not from treasury' };
    }

    // Rule 3: Per-transfer amount cap (e.g., 100 HBD)
    if (type === 'transfer') {
      const amount = parseFloat(data.amount);
      if (amount > MAX_AUTO_SIGN_AMOUNT) {
        return { sign: false, reason: `Amount ${amount} exceeds cap ${MAX_AUTO_SIGN_AMOUNT}` };
      }
    }

    // Rule 4: Daily spending cap (e.g., 500 HBD/day)
    if (type === 'transfer') {
      const todaySpent = await getDailySpending();
      const amount = parseFloat(data.amount);
      if (todaySpent + amount > DAILY_SPENDING_CAP) {
        return { sign: false, reason: 'Daily spending cap exceeded' };
      }
    }

    // Rule 5: Recipient must be a known storage node or validator
    if (type === 'transfer' && !isKnownRecipient(data.to)) {
      return { sign: false, reason: `Unknown recipient: ${data.to}` };
    }

    // Rule 6: NEVER auto-sign authority updates
    if (type === 'account_update' || type === 'account_update2') {
      return { sign: false, reason: 'Authority updates require manual approval' };
    }
  }

  return { sign: true };
}
```

### What Gets Auto-Signed vs Manual

| Transaction Type | Auto-Sign? | Rationale |
|-----------------|------------|-----------|
| PoA reward transfers (small HBD) | YES | Routine, deterministic, high-volume |
| Validator compensation | YES | Within policy caps |
| Recurrent transfer setup | YES | If within caps |
| Authority updates (signer rotation) | NO - manual | Changes who controls the treasury |
| Large one-off transfers | NO - manual | Above per-tx or daily cap |
| Unknown operation types | NO - manual | Safety default |

### The Signing Flow (Fully Automated)

```
1. PoA Engine determines: "Node X earned 0.005 HBD for proving CID abc123"
2. Payment Queue batches multiple rewards into one transaction
3. Transaction is created with treasury as sender
4. Coordination server distributes to all 10 signer daemons via WebSocket
5. Each daemon's policy engine validates the transaction
6. If policy passes -> daemon signs with its active key automatically
7. Signatures flow back to coordination server
8. Once 6+ signatures collected -> auto-broadcast to Hive
9. Done. No human touched anything.
```

**Average time from reward determination to on-chain payment: < 30 seconds** (assuming 6+ signers are online, which they should be since they're running witness nodes 24/7).

### Signing Coordination Options

**Option A: Self-Hosted Coordination Server**
- HivePoA runs its own WebSocket server for signing coordination
- Simpler, no external dependency
- Each signer daemon connects on startup
- Server batches transactions, distributes for signing, collects signatures, broadcasts

**Option B: Keychain Multisig SDK**
- Use the existing `hive-multisig-backend` WebSocket infrastructure
- Already built and maintained by Hive Keychain team
- Designed for manual approval (popup-based) but the SDK itself just relays encrypted messages
- We can use the relay layer while implementing auto-signing on the client side

**Recommendation: Option A (self-hosted) for auto-signing.** The Keychain SDK is designed around human-in-the-loop approval. For fully automated signing, a purpose-built coordination server is simpler and doesn't depend on an external team's infrastructure. The Keychain SDK remains useful for the rare manual-approval cases (authority updates).

### Implementation: Signing Coordinator

```javascript
// Coordinator server (runs alongside existing HivePoA backend)
class MultisigCoordinator {
  private signers: Map<string, WebSocket> = new Map();
  private pendingTxs: Map<string, PendingTransaction> = new Map();

  // Signer daemon connects
  onSignerConnect(ws, username) {
    // Verify: is this username in the current treasury authority?
    const isAuthorized = await this.verifyTreasuryAuthority(username);
    if (!isAuthorized) return ws.close();

    // Challenge-response auth (same as existing validator login)
    await this.authenticateSigner(ws, username);
    this.signers.set(username, ws);
  }

  // Submit a transaction for signing
  async submitForSigning(tx) {
    const txId = crypto.randomUUID();
    const pending = {
      tx, signatures: [], needed: 6,
      expires: Date.now() + 45 * 60 * 1000
    };
    this.pendingTxs.set(txId, pending);

    // Distribute to all connected signers
    for (const [username, ws] of this.signers) {
      ws.send(JSON.stringify({ type: 'sign_request', txId, tx }));
    }
  }

  // Signer returns a signature
  onSignatureReceived(txId, username, signature) {
    const pending = this.pendingTxs.get(txId);
    pending.signatures.push({ username, signature });

    // Threshold met?
    if (pending.signatures.length >= pending.needed) {
      this.broadcast(pending);
    }
  }

  async broadcast(pending) {
    // Attach all signatures to transaction
    pending.tx.signatures = pending.signatures.map(s => s.signature);
    await hiveClient.broadcast.send(pending.tx);
  }
}
```

---

## 4. Cryptographic Approaches Compared {#4-cryptographic-approaches}

### Option A: Native Hive L1 Multisig (Recommended)

**How it works**: Multiple signatures on-chain, validated by witnesses during block production.

| Aspect | Detail |
|--------|--------|
| **Security** | No smart contract vulnerabilities (no reentrancy, no overflow) |
| **Cost** | Zero fees (Resource Credits only) |
| **Speed** | 3-second block times |
| **Transparency** | All authority configs visible on-chain |
| **Limit** | 40 signers max per authority role |
| **On-chain footprint** | Multiple signatures visible (larger tx) |

### Option B: Shamir's Secret Sharing (SSS)

**How it works**: Split a single private key into n shares; t shares needed to reconstruct.

| Aspect | Detail |
|--------|--------|
| **Key generation** | Single dealer creates key, then splits (single point of failure during creation) |
| **Reconstruction** | Key must be reassembled in one place to sign (temporary SPOF) |
| **On-chain** | Looks like single-sig (privacy) |
| **Rotation** | Requires reconstruction + re-split (dangerous window) |

**Verdict**: NOT recommended. The reconstruction step creates a vulnerability window where the full key exists in memory.

### Option C: Threshold Signature Schemes (TSS) / FROST

**How it works**: Distributed Key Generation (DKG) creates key shares; threshold signatures produced without ever reconstructing the full key.

| Aspect | Detail |
|--------|--------|
| **Key generation** | Distributed - full key NEVER exists in one place |
| **Signing** | Collaborative - produces single signature from partial shares |
| **Standard** | FROST = RFC 9591 (June 2024), Schnorr-based |
| **Rotation** | Proactive Secret Sharing (PSS) - refresh shares without reconstruction |

**Problem for Hive**: Hive uses **secp256k1 ECDSA** signatures (Bitcoin-style), not Schnorr. FROST requires Schnorr. To use TSS on Hive, you'd need:
- An ECDSA-compatible TSS (e.g., GG20 protocol) - more complex, known attacks
- Or a Hive hardfork to add Schnorr support (unlikely near-term)

### Comparison Matrix

| Feature | Native Multisig | SSS | TSS/FROST |
|---------|----------------|-----|-----------|
| Key never in one place | N/A (no shared key) | NO | YES |
| On-chain support | Native L1 | Works anywhere | Needs Schnorr |
| Existing Hive tooling | YES | None | None |
| Complexity | Low | Medium | High |
| Proven on Hive | YES | No | No |
| Auto-signing compatible | YES | Yes | Yes |
| **Recommendation** | **USE THIS** | Avoid | Future |

---

## 5. HF28 Relevant Changes {#5-hf28-changes}

Hive Hardfork 28 (activated **November 19, 2025**) includes changes directly relevant to multisig:

| Change | Relevance |
|--------|-----------|
| **Redundant signatures allowed** | Extra signatures beyond threshold no longer cause tx failure. Huge - just collect all available sigs and broadcast |
| **Stricter authority matching** | Active authority can no longer satisfy posting-level requirements. Each op must use correct authority tier |
| **Multiple recurrent transfers for same sender/receiver pair** | Treasury can set up auto-distributions to multiple storage nodes |
| **Increased transaction expiration time** | More time for signature collection across time zones |
| **HBD in Treasury excluded from inflation calcs** | Cleaner treasury accounting |

### Most Impactful for Auto-Signing

1. **Redundant signatures**: Pre-HF28, if 8 out of 10 signers auto-signed a 6-of-10 treasury tx, the 2 extra signatures would cause the transaction to **fail**. Post-HF28, this works fine. This is critical for auto-signing - we don't need to carefully stop at exactly 6 signatures. Every online signer just signs, and we broadcast whenever we have enough.

2. **Recurrent transfers**: The treasury can set up automated recurring payments to validators/storage nodes, reducing the number of multisig transactions needed. Set it once, it runs automatically.

---

## 6. Integration with HivePoA Dashboard {#6-dashboard-integration}

### Design Principle: Same Dashboard, One More Toggle

Witnesses already use the HivePoA dashboard to:
- Opt-in as a **Validator** (PoA challenge engine)
- View challenge results, node health, payouts

Multisig signer is just **another role** in the same dashboard. No separate app. No separate download. The witness opts in, and their existing daemon starts auto-signing.

### Dashboard Changes

```
┌─────────────────────────────────────────────────────┐
│  HivePoA Dashboard - witness-alice                   │
├─────────────────────────────────────────────────────┤
│                                                      │
│  Roles:                                              │
│  ┌──────────────┐  ┌──────────────┐                 │
│  │ [x] Validator │  │ [x] Multisig │  <-- NEW       │
│  │   Running     │  │   Running    │                 │
│  └──────────────┘  └──────────────┘                 │
│                                                      │
│  Validator Stats:          Treasury Stats:            │
│  - Challenges: 142         - Balance: 2,450.00 HBD  │
│  - Success: 98.6%          - Today's payouts: 12    │
│  - Nodes: 47               - Your sigs today: 12    │
│                             - Signers online: 8/10  │
│                             - Your uptime: 99.2%    │
│                                                      │
│  Treasury Activity (auto-signed):                    │
│  ┌─────────────────────────────────────────────┐    │
│  │ 14:32  0.005 HBD -> storage-node-7 (PoA)   │    │
│  │ 14:31  0.005 HBD -> storage-node-3 (PoA)   │    │
│  │ 14:28  0.010 HBD -> storage-node-12 (PoA)  │    │
│  │ 14:25  [MANUAL] Authority update proposed   │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  Multisig Config:                                    │
│  - Auto-sign: ON (policy: <100 HBD/tx, <500/day)   │
│  - Per-tx cap: [100 HBD]  Daily cap: [500 HBD]     │
│  - Manual queue: 1 pending (authority update)        │
└─────────────────────────────────────────────────────┘
```

### Opt-In Flow (Witness Perspective)

1. Witness opens HivePoA dashboard (already logged in via Keychain)
2. Sees "Multisig Signer" toggle next to existing "Validator" toggle
3. Clicks to enable
4. Dashboard shows brief explanation: "Your daemon will auto-sign treasury transactions within your configured policy limits. Authority updates always require manual approval."
5. Witness confirms
6. Backend: daemon starts multisig signer module, connects to coordination server
7. Done. It just runs.

### What Witnesses See Day-to-Day

**Almost nothing.** The multisig signing happens silently in the background. The dashboard shows a rolling log of auto-signed transactions and uptime stats. The only time a witness needs to act manually is:
- Authority update proposals (adding/removing signers) - rare
- Transactions exceeding their personal policy caps - rare
- Notification that they've been selected/removed as a signer

---

## 7. Recommended Architecture {#7-recommended-architecture}

### Approach: Native L1 Multisig + Auto-Signing Daemon + Dashboard Integration

```
                    +---------------------+
                    |   HivePoA Treasury  |
                    |   @hivepoa-treasury |
                    |                     |
                    |  Active Authority:  |
                    |  threshold: 6       |
                    |  account_auths: [   |
                    |    [signer1, 1],    |
                    |    [signer2, 1],    |
                    |    ...              |
                    |    [signer10, 1]    |
                    |  ]                  |
                    +----------+----------+
                               |
              +----------------+----------------+
              |                                 |
     +--------v--------+             +----------v---------+
     |  Payment Queue  |             |  Authority Manager |
     |  (Backend)      |             |  (Backend)         |
     |                 |             |                    |
     | - Collects PoA  |             | - Monitors witness |
     |   reward claims |             |   rankings         |
     | - Batches into  |             | - Tracks opt-ins   |
     |   transfers     |             | - Proposes signer  |
     | - Sends to      |             |   changes          |
     |   coordinator   |             | - Authority updates |
     |   for signing   |             |   need manual      |
     +---------+-------+             |   approval         |
               |                     +--------------------+
               v
     +--------------------+
     | Signing Coordinator|     (WebSocket server, part of HivePoA backend)
     |                    |
     | - Holds pending txs|
     | - Distributes to   |
     |   connected signers|
     | - Collects sigs    |
     | - Broadcasts when  |
     |   threshold met    |
     +---------+----------+
               |
    ┌──────────┼──────────────────────────────────┐
    |          |          |          |             |
    v          v          v          v             v
 ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐     ┌──────┐
 │Daemon│  │Daemon│  │Daemon│  │Daemon│ ... │Daemon│
 │  #1  │  │  #2  │  │  #3  │  │  #4  │     │ #10  │
 │      │  │      │  │      │  │      │     │      │
 │ PoA  │  │ PoA  │  │ PoA  │  │ PoA  │     │ PoA  │
 │Engine│  │Engine│  │Engine│  │Engine│     │Engine│
 │  +   │  │  +   │  │  +   │  │  +   │     │  +   │
 │Auto- │  │Auto- │  │Auto- │  │Auto- │     │Auto- │
 │Signer│  │Signer│  │Signer│  │Signer│     │Signer│
 └──────┘  └──────┘  └──────┘  └──────┘     └──────┘
 (each witness runs one daemon with both modules)
```

### Key Design Decisions

1. **Use `account_auths` not `key_auths`** - Witnesses rotate their own keys independently
2. **Equal weights (1 each)** - Simple m-of-n, no power concentration
3. **6-of-10 threshold** - Tolerates 4 offline signers
4. **Auto-signing with policy caps** - No popups for routine operations
5. **Self-hosted coordination** - No dependency on external infrastructure
6. **Same daemon, same dashboard** - Multisig is just another module in the existing HivePoA software
7. **Authority updates require manual approval** - The only human-in-the-loop moment

### Account Structure

```
@hivepoa-treasury
  Owner Authority:
    weight_threshold: 7        (higher threshold for owner - safety)
    account_auths: [10 signers, weight 1 each]
    key_auths: [1 emergency recovery key, weight 7]  (cold storage)

  Active Authority:
    weight_threshold: 6        (day-to-day operations)
    account_auths: [10 signers, weight 1 each]
    key_auths: []

  Posting Authority:
    weight_threshold: 3        (social ops, custom_json)
    account_auths: [10 signers, weight 1 each]
    key_auths: []
```

**Emergency Recovery Key**: A single key with weight=7 stored in cold storage (hardware wallet, split across physical locations). Only used if >4 signers simultaneously become unavailable. This is the "break glass" mechanism.

### Signer Selection (Using Existing WoT)

The existing Web of Trust system (`web_of_trust` table, `/api/wot/*` endpoints) is reused and extended for signer selection. Currently, WoT lets a Top-150 witness vouch for one non-witness to become a validator. For multisig, we extend the same vouch mechanism to also select treasury signers:

**Eligibility criteria:**
1. **Must be a Top-150 Hive witness OR vouched by one** (same as current validator eligibility)
2. **Must be opted-in as HivePoA validator** (already running the software)
3. **Must opt-in as multisig signer** (new toggle in dashboard, stored in `treasury_signers` table)
4. **Must be vouched by >= 3 other Top-150 witnesses for the `treasury_signer` role** (extends existing WoT vouch model)
5. **Must maintain >90% signing uptime** (measured automatically)

**How it extends WoT:**
- The existing `web_of_trust` table handles 1:1 witness-to-validator vouches
- For multisig, we add a `role` dimension: vouching for `treasury_signer` is separate from vouching for `validator`
- A witness can vouch for multiple users as treasury signers (unlike the 1:1 validator vouch)
- The vouch/revoke API (`POST /api/wot/vouch`, `DELETE /api/wot/vouch`) gets a `role` parameter
- All vouches are public and on-chain via `custom_json`, same as existing WoT

**Selection algorithm:**
- From all eligible users who opted in, rank by: `witness_rank * vouch_count * uptime_score`
- Top 10 become active treasury signers
- If a signer loses eligibility (deranked, vouches revoked, uptime drops), next eligible user is promoted
- Authority update is proposed and requires current signers to approve (6-of-10)

### Stability Parameters
| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Max signers** | 10 | Practical limit for coordination |
| **Threshold** | 6-of-10 | >50% honest assumption |
| **Uptime requirement** | >90% signing response rate | 30-day rolling window |
| **Min tenure** | 7 days before eligible for rotation out | Prevents churn |
| **Auto-removal** | Witness deranked or <80% uptime | Safety valve |

---

## 8. Step-by-Step Implementation Blueprint {#8-implementation-blueprint}

### Phase 1: Backend - Signing Coordinator (Week 1-2)

**1.1 Add Multisig Module to Daemon**

New module in the existing HivePoA daemon codebase:

```
server/services/
  multisig-coordinator.ts    -- WebSocket server for coordinating signatures
  multisig-signer.ts         -- Client module that auto-signs (runs in each daemon)
  multisig-policy.ts         -- Policy engine (caps, allowed ops, recipient whitelist)
  treasury-manager.ts        -- Payment batching, authority monitoring
```

**1.2 Database Schema Extension**
```sql
CREATE TABLE treasury_signers (
  id SERIAL PRIMARY KEY,
  hive_username VARCHAR(16) NOT NULL UNIQUE,
  witness_rank INTEGER NOT NULL,
  opted_in BOOLEAN DEFAULT FALSE,
  opted_in_at TIMESTAMP,
  active BOOLEAN DEFAULT FALSE,        -- currently in the authority set
  uptime_score DECIMAL(5,4) DEFAULT 1.0,
  sigs_requested INTEGER DEFAULT 0,
  sigs_completed INTEGER DEFAULT 0,
  sigs_missed INTEGER DEFAULT 0,
  last_seen TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE treasury_transactions (
  id SERIAL PRIMARY KEY,
  tx_type VARCHAR(32) NOT NULL,        -- 'poa_reward', 'authority_update'
  hive_tx_id VARCHAR(64),
  status VARCHAR(16) DEFAULT 'pending', -- pending, signing, broadcast, confirmed, expired
  operations JSONB NOT NULL,
  threshold INTEGER NOT NULL,
  signatures_collected INTEGER DEFAULT 0,
  signers JSONB,                       -- [{username, signed_at}]
  auto_signed BOOLEAN DEFAULT TRUE,    -- was this auto-signed or manual?
  initiated_at TIMESTAMP DEFAULT NOW(),
  broadcast_at TIMESTAMP,
  confirmed_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);
```

**1.3 Signing Coordinator Service**
- WebSocket server (piggybacks on existing HivePoA WebSocket)
- Authenticates connecting signer daemons via challenge-response
- Maintains connected signer registry
- Receives transactions from payment queue
- Distributes to signers, collects signatures
- Broadcasts when threshold met
- Re-queues expired transactions

**1.4 Auto-Signer Module**
- Connects to coordinator on daemon startup
- Receives sign requests
- Validates against policy (amount caps, op types, known recipients)
- Signs with daemon's active key (already configured for PoA)
- Returns signature to coordinator
- Logs all signing activity locally

### Phase 2: Payment Queue & Treasury Logic (Week 3)

**2.1 Payment Queue**
- Replaces direct per-validator transfers with treasury-based batched transfers
- Collects PoA reward claims from all validators
- Batches into transactions (e.g., 20 transfers per tx for RC efficiency)
- Submits to signing coordinator
- Monitors for confirmation

**2.2 Authority Manager**
- Monitors witness rankings hourly
- Tracks signer opt-ins and uptime
- When signer set needs to change:
  - Generates `account_update` operation
  - Submits to signing coordinator with `manual_approval_required` flag
  - Notifies all current signers via dashboard + WebSocket
  - Collects 6+ manual approvals
  - Broadcasts authority update

### Phase 3: Dashboard Integration (Week 4)

**3.1 Multisig Toggle**
- Add "Multisig Signer" toggle to existing validator dashboard
- Show eligibility status (witness rank, validator status)
- Show auto-signing policy config (caps, allowed ops)

**3.2 Treasury Overview Panel**
- Treasury balance (real-time from Hive API)
- Today's payouts (count, total HBD)
- Signers online (X/10)
- Your signing stats (sigs, uptime)

**3.3 Activity Feed**
- Rolling log of auto-signed transactions
- Manual approval queue for authority updates
- Signer status changes

### Phase 4: Account Creation & Bootstrap (Week 5)

**4.1 Create Treasury Account**
```javascript
const createAccount = {
  creator: "bootstrap-account",
  new_account_name: "hivepoa-treasury",
  owner: {
    weight_threshold: 7,
    account_auths: initialSigners.map(s => [s, 1]).sort(),
    key_auths: [[emergencyRecoveryPubKey, 7]]
  },
  active: {
    weight_threshold: 6,
    account_auths: initialSigners.map(s => [s, 1]).sort(),
    key_auths: []
  },
  posting: {
    weight_threshold: 3,
    account_auths: initialSigners.map(s => [s, 1]).sort(),
    key_auths: []
  },
  memo_key: treasuryMemoPubKey,
  json_metadata: JSON.stringify({
    app: "hivepoa", type: "multisig_treasury", version: 1
  })
};
```

**4.2 Bootstrap**
- Initial signers = first 10 witnesses who are running HivePoA validators
- Seed treasury with small amount (<100 HBD)
- Run parallel with direct-payment model for 30 days
- Monitor signing latency, success rates, uptime
- Increase treasury allocation after proven stability

### Phase 5: Testing & Hardening (Week 6)

- Testnet simulation: signer rotation, expired txs, offline signers
- Load test: batch payment throughput
- Edge case: simultaneous authority updates
- Emergency recovery key test
- Gradual mainnet rollout

---

## 9. Risk Analysis & Edge Cases {#9-risk-analysis}

### Critical Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **>4 signers offline simultaneously** | HIGH | Emergency recovery key; witnesses run 24/7 infrastructure so this is unlikely; reduce threshold to 5 if chronic |
| **Witness collusion (>6 of 10)** | HIGH | Signers are public, reputable witnesses with massive HP at stake; on-chain audit trail; community would vote them out |
| **Policy bypass (malicious tx gets auto-signed)** | MEDIUM | Policy engine validates every tx; per-tx and daily caps limit blast radius; authority updates always manual |
| **Transaction expiration** | LOW | Auto-signing completes in seconds, not minutes; 6+ witnesses are typically online 24/7 |
| **RC exhaustion** | LOW | Treasury needs adequate HP delegation; batch transactions to reduce per-tx RC cost |

### Edge Cases

1. **Signer opts out, would drop below threshold**: Block opt-out until replacement is available. Dashboard shows: "Cannot opt out - would leave only 5 signers (need minimum 6 for threshold)."

2. **Witness deranked mid-signing**: Already-submitted txs complete (signature is valid regardless of rank). New txs won't include them. Authority update queued to remove them.

3. **Conflicting authority updates**: Coordinator serializes authority update proposals - only one can be in flight at a time.

4. **Emergency: all signers offline**: Use cold-storage emergency recovery key (weight=7) to reset authorities. This should never happen since witnesses run 24/7 infrastructure, but the failsafe exists.

5. **Policy cap hit**: If a batch of PoA rewards exceeds the daily cap, the remaining rewards queue for the next day. No rewards are lost, just delayed. The witness can also manually approve the overflow if they check their dashboard.

---

## 10. Sources {#10-sources}

### Hive Multisig & Authority System
- [Hive Multisig dApp (Live)](https://hive-multisig.web.app)
- [How to set up multisignature accounts on Hive](https://hive.blog/utopian-io/@stoodkev/how-to-set-up-and-use-multisignature-accounts-on-steem-blockchain)
- [Hive Developer Portal: Using Multisignature Accounts](https://developers.hive.io/tutorials-recipes/using-multisignatire-accounts.html)
- [Hive Developer Portal: Grant Active Permission (JS)](https://developers.hive.io/tutorials-javascript/grant_active_permission.html)
- [Hive Developer Portal: Glossary](https://developers.hive.io/glossary/)
- [Hive Multisig SDK Documentation](https://multisig-doc.hive-keychain.com/websocket-flow)
- [Hive Multisig Backend (GitHub)](https://github.com/hive-keychain/hive-multisig-backend)
- [Hive Multisig Proposal (@stoodkev)](https://ecency.com/hive-139531/@stoodkev/hive-multisig-proposal)

### Graphene Authority System
- [Updating an account to multi-sig (Graphene Book)](https://neura-sx.gitbooks.io/graphene-book/content/book/multi-sig/tutorial-updating-multi-sig.html)
- [Creating a multi-sig account (Graphene Book)](https://neura-sx.gitbooks.io/graphene-book/content/book/multi-sig/tutorial-creating-multi-sig.html)
- [Graphene Architecture (GitHub Wiki)](https://github.com/cryptonomex/graphene/wiki/architecture)

### Cryptographic Approaches
- [TSS vs Multi-Sig vs Shamir's Secret (Silence Laboratories)](https://silencelaboratories.com/blog-posts/why-is-the-threshold-signature-scheme-better-than-multi-sig-and-shamirs-secret)
- [Multisig, SSS, & MPC Compared (Bitcoin Magazine)](https://bitcoinmagazine.com/technical/multisig-shamirs-secret-sharing-mpc-compared)
- [SSS vs Multisig vs BLS vs DKG vs TSS (Cryptologie)](https://cryptologie.net/article/486/difference-between-shamir-secret-sharing-sss-vs-multisig-vs-aggregated-signatures-bls-vs-distributed-key-generation-dkg-vs-threshold-signatures/)
- [Threshold Signatures Explained (Binance Academy)](https://academy.binance.com/en/articles/threshold-signatures-explained)
- [FROST RFC 9591](https://www.rfc-editor.org/rfc/rfc9591.html)

### Proactive Secret Sharing
- [Proactive Secret Sharing (Medium)](https://medium.com/@samngms/proactive-secret-sharing-8f0b05d87dce)
- [Proactive Secret Sharing (Wikipedia)](https://en.wikipedia.org/wiki/Proactive_secret_sharing)
- [PSS Concepts (Source Network / Orbis)](https://docs.source.network/orbis/concepts/pss/)

### Slashing & Validator Penalties (Reference)
- [Understanding Slashing in PoS (Stakin)](https://stakin.com/blog/understanding-slashing-in-proof-of-stake-key-risks-for-validators-and-delegators)
- [Polkadot Offenses and Slashes](https://docs.polkadot.com/infrastructure/staking-mechanics/offenses-and-slashes/)
- [Cosmos Slashing Parameters](https://github.com/gavinly/CosmosParametersWiki/blob/master/Slashing.md)

### Hive Hardfork 28
- [HF28 Jump Starter Kit (@gtg)](https://hive.blog/hive-160391/@gtg/hive-hardfork-28-jump-starter-kit)
- [Blocktrades HF28 Update](https://hive.blog/hive-139531/@blocktrades/10th-update-of-2024-api-node-software-release-in-dec-hardfork-tentatively-set-for-q1-2025)
- [HF28 Release Notes (GitHub)](https://github.com/openhive-network/hive/releases/tag/1.28.3)

### Hive Resource Credits & Operations
- [RC Bandwidth System](https://developers.hive.io/tutorials-recipes/rc-bandwidth-system.html)
- [Calculating RC Costs](https://developers.hive.io/tutorials-recipes/calculate_rc_recipe.html)
- [Hive Broadcast Operations](https://developers.hive.io/apidefinitions/broadcast-ops.html)

### Implementation References
- [stoodkev Multisig Sample Code](https://github.com/stoodkev/multisig)
- [beem Library (Python)](https://github.com/holgern/beem)
- [Multisig Signing Scripts (Gist)](https://gist.github.com/crokkon/17e5be82d9ef073bcee80a461a11dea9)
