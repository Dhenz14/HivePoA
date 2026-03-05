# Multisig Treasury System

Complete documentation for the HivePoA shared treasury — Hive L1 native multisig with auto-signing, fluid authority rotation, and self-healing.

---

## Overview

The treasury system eliminates single points of failure for HBD reward distribution. Instead of each validator paying storage nodes from their own wallet, rewards flow through `@hivepoa-treasury` — a shared account controlled by multiple Hive witnesses via native L1 weighted authority.

**Key properties:**
- **No shared secret**: Each signer uses their own Hive active key. The treasury account has no private key in circulation.
- **Instant and free**: Hive transactions settle in 3 seconds with zero fees.
- **Automatic**: Signing is policy-driven with no human interaction for routine payments.
- **Self-healing**: On-chain authority auto-corrects when signers change.

---

## Architecture

### Files

| File | Purpose |
|------|---------|
| `shared/treasury-types.ts` | Shared interfaces, constants, and policy defaults |
| `server/services/treasury-hive.ts` | dhive multisig primitives (build tx, compute digest, broadcast) |
| `server/services/treasury-coordinator.ts` | Core orchestration (signer lifecycle, signing flow, authority sync) |
| `desktop-agent/src/main/treasury-signer.ts` | Agent-side auto-signing with local policy engine |
| `desktop-agent/src/main/wallet-manager.ts` | Encrypted wallet (AES-256-GCM + PBKDF2) for key storage |
| `desktop-agent/src/main/cli.ts` | Headless CLI entry point for Linux servers |
| `client/src/pages/treasury.tsx` | Treasury dashboard UI |

### Database Tables

**`treasury_signers`** — Who's in the signer set

| Column | Type | Description |
|--------|------|-------------|
| id | varchar (PK) | UUID |
| username | text (UNIQUE) | Hive username |
| status | text | `active`, `leaving`, `cooldown`, `removed` |
| weight | integer | Always 1 (equal weight) |
| joined_at | timestamp | When they joined |
| left_at | timestamp | When they left (nullable) |
| cooldown_until | timestamp | Can't rejoin before this (nullable) |
| opt_events | integer | Number of opt-out events (for churn detection) |
| last_heartbeat | timestamp | Last WebSocket activity |

**`treasury_vouches`** — WoT extension for treasury (1:N, unlike validator WoT which is 1:1)

| Column | Type | Description |
|--------|------|-------------|
| id | varchar (PK) | UUID |
| voucher_username | text | Witness doing the vouching |
| candidate_username | text | Who they're vouching for |
| voucher_rank_at_vouch | integer | Witness rank when vouch was created |
| active | boolean | True if vouch is active |
| revoked_at | timestamp | When revoked (nullable) |
| revoke_reason | text | `manual`, `voucher_deranked` (nullable) |

Partial unique index: `(voucher_username, candidate_username) WHERE active = true`

**`treasury_transactions`** — Signature collection and audit trail

| Column | Type | Description |
|--------|------|-------------|
| id | varchar (PK) | UUID |
| tx_type | text | `transfer` or `authority_update` |
| status | text | `pending`, `signing`, `broadcast`, `expired`, `failed` |
| operations_json | text | Full serialized transaction (not just operations) |
| tx_digest | text (UNIQUE) | Hex digest that signers sign |
| signatures | jsonb | `{ "username": "hex_sig", ... }` |
| threshold | integer | Signatures needed |
| expires_at | timestamp | Hive tx expiration (~50 seconds) |
| initiated_by | text | `system` or username |
| broadcast_tx_id | text | Hive tx ID after broadcast (nullable) |
| metadata | jsonb | Recipient, amount, memo, etc. |

---

## How Signing Works

### 1. Reward Determination

The PoA engine verifies storage proofs and batches rewards. When `flushProofBatch()` fires:

```
if (treasuryCoordinator.isOperational()) {
    -> route through multisig treasury
} else {
    -> fallback to direct transfer from validator's wallet
}
```

`isOperational()` requires ALL THREE:
- `TREASURY_ENABLED=true` env var
- On-chain authority matches DB signer set (`authorityInSync`)
- 3+ signers currently connected via WebSocket

### 2. Transaction Building

The coordinator builds an unsigned Hive transaction:
1. Fetches current chain properties (`head_block_number`, `head_block_id`)
2. Constructs transaction header (50-second expiration)
3. Computes canonical digest via `cryptoUtils.transactionDigest(tx, chainId)`
4. Stores the **entire transaction object** in `operations_json` — chain props change every 3 seconds, so we can't rebuild later

### 3. Signing Request Distribution

A `SigningRequest` is sent to every connected agent whose `hiveUsername` is in the active signer set, over the **existing `/ws/agent` WebSocket** (no separate connection):

```json
{
  "type": "SigningRequest",
  "txId": "uuid",
  "txDigest": "a1b2c3...",
  "operations": [["transfer", {...}]],
  "tx": { "ref_block_num": ..., "operations": [...], ... },
  "expiresAt": "ISO8601",
  "metadata": { "txType": "transfer", "recipient": "node-xyz", "amount": "0.150 HBD" }
}
```

### 4. Agent-Side Verification and Signing

Each agent's `TreasurySigner`:

1. **Checks enabled** + has active key + not expired
2. **Policy engine**: op type whitelist, per-tx cap (1 HBD), daily cap (50 HBD), rate limit (100/hr)
3. **Digest verification** (CRITICAL): Independently computes `cryptoUtils.transactionDigest(request.tx, HIVE_CHAIN_ID)` and rejects if the server-provided digest doesn't match. This prevents a compromised server from sending a benign-looking operations array but a digest for a different malicious transaction.
4. Signs the verified digest with the agent's Hive active key
5. Returns `SigningResponse` with hex signature

### 5. Signature Collection and Broadcast

Back on the server:
1. Each signature is stored in `treasury_transactions.signatures` JSONB
2. After each signature: check `sigCount >= threshold`
3. `broadcastingTxIds` Set prevents race conditions if two signatures cross the threshold simultaneously
4. Original transaction is parsed from `operations_json` (exact same tx all signers signed)
5. `client.broadcast.send(signedTx)` broadcasts to Hive with all collected signatures
6. Status updated to `broadcast` with the Hive transaction ID

### 6. Timeout and Fallback

- Signing timeout: 45 seconds (Hive max is ~60s)
- If timeout or broadcast fails, the PoA engine falls back to a direct transfer
- No rewards are lost — the accumulator is preserved for retry

---

## Authority Rotation

### How It Works

Hive accounts have an `active` authority with:
- **`account_auths`**: `[["username", weight], ...]` — other accounts that can act on behalf
- **`weight_threshold`**: minimum total weight required

We use `account_auths` exclusively (not `key_auths`). Each signer gets weight 1. Threshold = `ceil(N * 0.6)`.

### When a Signer Joins

1. `POST /api/treasury/join` — eligibility checked (top-150 witness OR 3+ WoT vouches)
2. Cooldown checked (if previously left)
3. DB status set to `active`
4. `initiateAuthorityUpdate()` fires:
   - Reads all active signers from DB
   - Computes new threshold
   - Reads current `memo_key` and `json_metadata` to preserve them
   - Builds `account_update` operation
   - Distributes for signing to CURRENT authority holders
   - Broadcasts when threshold met

### When a Signer Leaves

1. `POST /api/treasury/leave`
2. `optEvents` increments for churn tracking
3. Cooldown applied: 7 days (or 30 days if 3+ opt-outs in 90 days)
4. Authority update fires with reduced signer set

### Threshold Examples

| Signers | Threshold | Required |
|---------|-----------|----------|
| 3 | ceil(3 * 0.6) = 2 | 2 of 3 |
| 5 | ceil(5 * 0.6) = 3 | 3 of 5 |
| 10 | ceil(10 * 0.6) = 6 | 6 of 10 |
| 15 | ceil(15 * 0.6) = 9 | 9 of 15 |

---

## Self-Healing

Every 10 minutes (`AUTHORITY_SYNC_INTERVAL_MS`), `syncAuthority()` runs:

1. **Check signer eligibility**: Is each active signer still a top-150 witness? If not, do they still have 3+ vouches?
2. **Check voucher eligibility**: Is each voucher still a top-150 witness? If not, revoke their vouch.
3. **Cascade**: If vouch revocation drops a candidate below 3 vouches, remove them from signer set.
4. **Compare on-chain authority** with DB signer set using `authorityMatchesSigners()`.
5. **If diverged**: Initiate corrective `account_update` transaction.

---

## WoT Integration

DPoS and WoT work together — the same trust model as the validator system:

- **Top-150 witnesses**: Opt in directly. They ARE the trust layer.
- **Non-witnesses**: Need 3+ vouches from top-150 witnesses via `treasury_vouches` table.
- **Separate from validator WoT**: Validator vouches are 1:1 (one witness, one vouched validator). Treasury vouches are 1:N (one witness can vouch for multiple signer candidates).
- **Auto-revocation cascade**: Witness drops from top-150 -> their vouch is revoked -> if candidate drops below 3 vouches -> candidate removed from signer set.

---

## Churn Protection

Simple cooldowns with escalation — no penalty tables, no uptime scoring:

| Scenario | Cooldown |
|----------|----------|
| First opt-out | 7 days |
| 2nd opt-out | 7 days |
| 3rd opt-out | 7 days |
| 4th+ opt-out (within 90 days) | 30 days |

Tracked via `opt_events` counter and `cooldown_until` timestamp on `treasury_signers`.

---

## Genesis Bootstrap

When `@hivepoa-treasury` is first created, it has a single key in `key_auths` and no `account_auths`. The chicken-and-egg problem: how do you set the first multisig authority when there are no signers yet?

1. Set `TREASURY_GENESIS_KEY` env var with a private key
2. On first `syncAuthority()`, coordinator detects `key_auths.length > 0 && account_auths.length === 0`
3. Signs initial `account_update` with the genesis key
4. Sets the multisig authority with all active signers
5. Genesis key is now useless — authority is controlled by the signer set
6. Remove the env var

---

## Encrypted Wallet

Private keys are never stored in plaintext. The desktop agent uses an encrypted wallet file at `~/.spk-ipfs/wallet/wallet.json`.

### Encryption

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key derivation**: PBKDF2 with 600,000 iterations, SHA-512, 32-byte key
- **Salt**: 32 random bytes, stored in the wallet file
- **IV**: 16 random bytes per key entry

Each key entry stores `encrypted` (ciphertext), `iv`, `tag` (GCM auth tag), and `publicKey` (STM format, not secret).

### Key Lifecycle

1. User sets a wallet password -> PBKDF2 derives encryption key from password + salt
2. User imports a private key -> key is encrypted with AES-256-GCM and written to disk
3. On startup, wallet is unlocked with the password -> keys decrypted into memory for signing
4. On shutdown, in-memory keys are zeroed

### Password Storage

- **Electron mode**: Password stored in the OS keychain via `electron.safeStorage` (DPAPI / Keychain / libsecret). Wallet auto-unlocks on app start.
- **CLI mode**: Password provided via `SPK_WALLET_PASSWORD` environment variable. Never persisted to disk.

### Recovery

There is no password recovery mechanism. If the password is lost, delete the wallet file and re-import keys.

---

## Agent-Side Policy Configuration

Default policy (ships with safe defaults, configurable per agent):

| Policy | Default | Purpose |
|--------|---------|---------|
| `enabled` | true | Master toggle |
| `maxPerTxHbd` | 1.0 | Per-transaction cap |
| `dailyCapHbd` | 50.0 | Daily spending cap |
| `maxSigningRequestsPerHour` | 100 | Rate limit |

Operation type whitelist: `transfer`, `account_update` only. Everything else is rejected.

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/treasury/status` | Public | Operational status, signer count, threshold, balance |
| GET | `/api/treasury/signers` | Public | Active signers with online status and vouch count |
| POST | `/api/treasury/join` | Bearer | Opt in as treasury signer |
| POST | `/api/treasury/leave` | Bearer | Opt out with cooldown |
| GET | `/api/treasury/transactions` | Bearer | Recent treasury transactions |
| GET | `/api/treasury/transactions/:id` | Bearer | Single tx with signature progress |
| POST | `/api/wot/treasury-vouch` | Witness | Vouch for a signer candidate |
| DELETE | `/api/wot/treasury-vouch` | Witness | Revoke treasury vouch |
| GET | `/api/wot/treasury-vouches` | Public | All active vouches grouped by candidate |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TREASURY_ENABLED` | No | Set to `true` to enable treasury mode |
| `TREASURY_GENESIS_KEY` | No | One-time private key for bootstrapping initial authority. Remove after first successful multisig update. |

---

## Security Model

| Threat | Mitigation |
|--------|------------|
| Compromised server sends tampered digest | Agent independently recomputes digest from tx object using Hive mainnet chain ID |
| Race condition: two signatures trigger concurrent broadcast | `broadcastingTxIds` Set with cleanup in `finally` block |
| Signer churning disrupts authority | 7/30-day cooldowns based on opt-out frequency |
| Authority drifts from DB state | 10-minute self-healing sync cycle |
| Duplicate vouch race condition | Partial unique index on `(voucher, candidate) WHERE active = true` |
| Authority update resets memo_key | `readAccountInfo()` preserves current memo_key and json_metadata |
| Stale chain props invalidate signatures | Full tx stored in `operations_json`, not rebuilt at broadcast time |
| Unsafe JSON in SQLite storage | `parseTxJsonFields()` helper with try-catch wrappers |
| Raw keys in process memory | AES-256-GCM encrypted wallet; keys decrypted only at startup, zeroed on shutdown |
| Wallet password exposure | Electron: OS keychain (DPAPI/Keychain/libsecret). CLI: env var per session, never persisted |
