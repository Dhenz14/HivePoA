# Phase 0: Transaction-Integrity Design Decisions

**Status:** BINDING — do not implement without resolving every item below.
**Grounded against:** HivePoA `94cc699`, Hive-AI `a5e16e4`, full interface re-read 2026-03-16.

## Four Frozen Invariants

These are the load-bearing edges. Implementers, DB constraints, and fault tests must all enforce the **same exact rules**:

1. **Exactly one accepted attempt may exist per job.** Enforced by `computeJobs.acceptedAttemptId` (nullable FK, set atomically with `WHERE acceptedAttemptId IS NULL`).
2. **A submission is late iff server-side validation occurs after lease expiry.** Decided by `now() > attempt.leaseExpiresAt` within the submit handler's DB transaction.
3. **For a given `(attemptId, nonce)`, exact replay is idempotent; divergent replay is conflict.** First valid submission creates the record. Same payload retried returns 200. Different payload retried returns 409 `SUBMISSION_PAYLOAD_MISMATCH`.
4. **Settlement executes from frozen payout inputs, not live mutable state.** Payout amounts are snapshotted into `computePayouts` rows at acceptance time. `settlePayouts()` reads only from those rows.

---

## Decision 1: Canonical Unit-of-Work Identity Model

| Concept | Identifier | Source | Mutability |
|---------|-----------|--------|------------|
| **Job** | `computeJobs.id` (UUIDv4) | Server-assigned at `createJob()` | Immutable |
| **Claim** | `computeJobAttempts.id` (UUIDv4) + `leaseToken` | Server-assigned at `claimComputeJobAtomic()` | Immutable per attempt |
| **Submission attempt** | `(attemptId, submittedAt)` | Composite — attemptId is the attempt, submittedAt disambiguates retries | First-write-wins on server |
| **Logical completion** | `computeJobs.acceptedAttemptId` FK → `computeJobAttempts.id` | Server-assigned at `acceptAttempt()` | Terminal — exactly one per job, DB-enforced |
| **Settlement event** | `computePayouts.id` (UUIDv4) per payout line | Server-assigned at `acceptAttempt()` → three rows created | Idempotent — `settlePayouts()` transitions `pending → queued` only |

### Rules
- A job has at most `maxAttempts` attempts (default 3).
- Each attempt has exactly one `leaseToken` (32-byte hex, random).
- **Exactly one accepted attempt may exist per job.** This is both a code invariant and a DB invariant:
  - `computeJobs.acceptedAttemptId` is the authoritative winning attempt for a job.
  - Job completion is a **job-level derived condition** from that accepted attempt.
  - `acceptAttempt()` sets `acceptedAttemptId` — if already non-null, the operation is rejected.
  - DB constraint: `acceptedAttemptId` is nullable FK, but `acceptAttempt()` checks `WHERE acceptedAttemptId IS NULL` atomically.
- Settlement creates exactly 3 payout rows (validity + completion + bonus) on acceptance. No more can be created for the same job.
- `settlePayouts()` is idempotent: calling it again on already-queued payouts is a no-op.

### What's Missing (to add in Phase 0)
- **Nonce**: Server-issued per attempt. New column `computeJobAttempts.nonce` (UUIDv4). Worker must echo it back on submit. Prevents cross-attempt replay.
- **Idempotency key for submit**: `(attemptId, nonce)` tuple. If server already has a submit for this tuple, return the existing result (first-write-wins).
- **Settlement dedup guard**: Before creating payout rows, check `COUNT(*) FROM computePayouts WHERE jobId = ? AND reason IN ('validity_fee', 'completion_fee', 'bonus')`. If > 0, skip creation.

---

## Decision 2: Server-Side Authoritative State Machine

### Current (from code)
```
Job:     queued → leased → running → submitted → verifying → accepted | rejected | expired | cancelled
Attempt: leased → running → submitted → accepted | rejected | failed | timed_out
```

### Phase 0 addition: `settled` terminal state
```
Job:     ... → accepted → settled
```

`settled` means all payouts for the job have reached `confirmed` status (on-chain finality). This is a new terminal state on `computeJobs`.

### Transition Authority Table

| Transition | Who triggers | Preconditions | Reversible? |
|-----------|-------------|---------------|-------------|
| queued → leased | Server (atomic claim) | Node online, VRAM sufficient, workload supported, attempts remaining | No (attempt created) |
| leased → running | Worker (startJob) | Valid leaseToken | No |
| running → submitted | Worker (submitResult) | Valid leaseToken, state=running | No |
| submitted → verifying | Server (inline) | Submission received | No |
| verifying → accepted | Server (verification pass) | Structural + workload checks pass | Terminal |
| verifying → rejected | Server (verification fail) | Any check fails | Compensatable (requeue if attempts remain) |
| leased/running → timed_out | Server (sweeper) | heartbeatAt > 2min stale | Compensatable (requeue if attempts remain) |
| leased/running → failed | Worker (failJob) | Valid leaseToken | Compensatable (requeue if attempts remain) |
| any non-terminal → cancelled | Creator (cancelJob) | Creator owns job, not already terminal | Terminal (partial payout possible) |
| accepted → settled | Server (all payouts confirmed) | Every payout row status = 'confirmed' | Terminal |

### Contested Edge Answers

**Q: Can a `claimed` job be reclaimed?**
A: No. The attempt owns the lease. If the attempt times out or fails, the *job* can be requeued and a *new* attempt created. The old attempt stays in its terminal state.

**Q: Can a `rejected` job be retried by the same worker?**
A: Yes, if attempts remain and the job is requeued. The same node can claim it again (new attempt, new leaseToken, new nonce).

**Q: Is `settled` terminal?**
A: Yes. If a settlement tx fails on-chain, the payout row stays in `broadcast` or `failed` status — the job does NOT go back to `accepted`. The treasury coordinator retries the payout, not the job.

**Q: Expired claim + late submit?**
A: Rejected. See Decision 3 (Gate C).

**Q: Submit accepted + settlement retry?**
A: Settlement is payout-level, not job-level. Individual payout rows can be retried (`failed → queued → broadcast`). The job stays `accepted` until all payouts reach `confirmed`, then transitions to `settled`.

**Q: Fail reported after successful submit timeout?**
A: Server checks attempt state before applying fail. If state is already `submitted` or later, the fail call is rejected (409 Conflict). First-write-wins.

---

## Decision 3: Ownership Rule Under Lease Expiry (Gate C: Late-Work Policy)

**Policy: REJECT with provenance recording.**

### Linearization rule

**A submission is late iff server-side validation occurs after lease expiry.** The precise cutoff:

- Each attempt stores `leaseExpiresAt` (server-computed: `createdAt + job.leaseSeconds`). New column on `computeJobAttempts`.
- Submit freshness is decided by **server receipt time within the DB transaction** — `now() > leaseExpiresAt` at validation means late.
- The sweeper also uses `leaseExpiresAt` (not just heartbeat staleness) as the authoritative expiry boundary.
- Heartbeat renewal and submit validation both compare the current `leaseToken` atomically within their respective transactions. A submit that races with the sweeper is resolved by whoever commits first — if the sweeper committed `timed_out`, the submit sees it and returns 409; if the submit committed first, the sweeper skips the attempt.

### Rejection behavior

- An expired claimant **cannot** submit. The `submitResult()` call checks `attempt.state === 'running' AND now() <= leaseExpiresAt`. If either fails, submit returns 409 Conflict.
- If the expired worker's work was valuable, it is lost. This is acceptable because:
  - The job gets requeued (if attempts remain) and another worker can redo it.
  - Accepting late work creates double-pay risk that is harder to solve than redoing work.
- **Provenance-only recording** (Phase 0 addition): When a late submit is rejected, log a structured event (`late_submit_rejected`) with the attempt's nonce, artifact hash, and timestamps. This provides forensic evidence without protocol-level acceptance.

### Double-work prevention
- The nonce is attempt-scoped. A new attempt gets a new nonce. The old nonce is dead.
- Even if two workers produce the same artifact hash, they have different attempt IDs and nonces. Only the accepted attempt earns payouts.

---

## Decision 4: Provenance Mandatory vs Advisory Fields

### Mandatory (protocol correctness — reject submission if missing)

| Category | Field | Rationale |
|----------|-------|-----------|
| Identity | `worker_id` (nodeInstanceId) | Already in attempt via nodeId FK |
| Identity | `job_id` | Already in attempt via jobId FK |
| Identity | `attempt_nonce` | New — server-issued, worker-echoed |
| Identity | `schema_version` | Already in manifest |
| Environment | `platform` | Trivial to collect |
| Derivation | `output_artifact_cid` | Already: outputCid |
| Derivation | `output_artifact_sha256` | Already: outputSha256 |

### Advisory (recorded if available — do not reject if missing)

| Category | Field | Rationale |
|----------|-------|-----------|
| Environment | `git_sha` | May not exist in container builds |
| Environment | `cuda_version` | Already collected at registration, redundant per-job |
| Environment | `torch_version` | Same |
| Environment | `python_version` | Same |
| Environment | `dependency_fingerprint` | Expensive to compute |
| Derivation | `base_model_sha256` | Expensive; only meaningful for training workloads |
| Derivation | `dataset_sha256` | Only meaningful for training workloads |
| Derivation | `seed` | Only meaningful for training workloads |
| Derivation | `hyperparameters` | Only meaningful for training workloads |
| Derivation | `input_artifact_refs` | Only meaningful for training workloads |

### Implementation Shape

New JSON field on `computeJobAttempts`: `provenanceJson` (text, nullable).

```json
{
  "schema_version": 1,
  "identity": {
    "nonce": "attempt-nonce-echoed-back",
    "worker_version": "1.2.0"
  },
  "environment": {
    "platform": "linux-x86_64",
    "git_sha": "abc123",
    "cuda_version": "12.4",
    "torch_version": "2.5.0",
    "python_version": "3.13.1"
  },
  "derivation": {
    "base_model_sha256": null,
    "dataset_sha256": null,
    "seed": null,
    "hyperparameters": null,
    "input_artifact_refs": [],
    "output_artifact_ref": {
      "cid": "sha256:abcdef...",
      "sha256": "abcdef...",
      "size_bytes": 12345
    }
  }
}
```

### Validation boundaries (binding)

- **7 mandatory fields** validated server-side at submit time. Missing any → deterministic 400 with `PROVENANCE_MISSING_REQUIRED` and the field name.
- **Unknown extra fields** are allowed and stored, but ignored semantically. They do not affect acceptance, verification, or settlement unless explicitly promoted in a future schema version.
- **Max size bound**: `provenanceJson` must be ≤ 64 KB. Exceeding → 400 with `PROVENANCE_TOO_LARGE`.
- **Malformed JSON** → deterministic 400 with `PROVENANCE_INVALID_JSON`. Checked before any state mutation.
- **Provenance is forensic/advisory** unless a field is explicitly promoted into acceptance logic. Currently no provenance field gates acceptance — nonce echo and structural/workload verification are the only acceptance gates. This prevents provenance from quietly becoming hidden policy.

Validated against `provenance_v2.json` schema (already exists in `schemas/`). Mandatory fields enforced at submit time. Advisory fields validated structurally but allowed to be null.

---

## Decision 5: IPFS Verification Scope (Gate B: Authoritative Artifact Trust Source)

**Choice: Content-address consistency (hash match) as the acceptance gate. Retrieval verification is a settlement prerequisite, not an acceptance prerequisite.**

### Rationale
- V1 doesn't use real IPFS — outputCid is `sha256:{hash}` prefix. Full IPFS comes in Phase 0 Step 2.
- Local retrievability (weakest) is trivially true and proves nothing.
- Coordinator-visible retrieval (strongest) is the right settlement gate but too expensive/slow for inline acceptance.
- Content-address consistency (hash match) is the acceptance gate because it's the only thing provable at submit time.

### Two-stage trust model

| Stage | Gate | What it proves | When |
|-------|------|---------------|------|
| **Acceptance** | `outputSha256` matches worker-claimed hash, structural + workload verification passes | Worker produced a plausible result | Inline at submit |
| **Settlement** | Artifact retrievable through coordinator-accessible IPFS gateway, content hash matches | Result is real and available | Before `pending → queued` payout transition |

### Implementation
- `submitResult()` (acceptance): Unchanged — verify hash format, run structural + workload checks inline.
- `settlePayouts()` (settlement): NEW — before transitioning payouts from `pending → queued`, verify artifact is retrievable. If not retrievable, payouts stay `pending` and a `settlement_blocked_artifact_unavailable` event is emitted.
- Worker responsibility: Pin artifact, verify local readback, report CID. Worker does NOT need to prove external retrievability.

---

## Decision 6: Time Authority and Skew Handling

**Server clock is authoritative for all time-sensitive decisions.**

| Decision point | Timestamp used | Source |
|---------------|---------------|--------|
| Lease expiry | `heartbeatAt` vs `now()` on server | Server DB clock |
| Late submit detection | `attempt.state` (already timed_out?) | Server state, not time comparison |
| Submission receipt | `submittedAt = now()` on server | Server DB clock |
| Deadline enforcement | `deadlineAt` vs `now()` in atomic claim | Server DB clock |
| Verification timing | Not time-bounded in V1 (inline) | N/A |
| Settlement timing | Not time-bounded | N/A |

### Worker timestamps
- Worker-supplied timestamps (in metricsJson, provenanceJson) are **advisory only**.
- Never used for protocol decisions (lease, expiry, acceptance, settlement).
- Recorded for forensics and debugging.

### Clock skew tolerance
- Not applicable — worker never makes time-based protocol decisions. The server decides all time-sensitive transitions based on its own clock.
- Worker heartbeats are receipt-time stamped by the server (`heartbeatAt = now()` on server), not worker-claimed times.

### Server-issued deadlines
- Lease expiry is implicit: 2 minutes since last `heartbeatAt` update (server-stamped).
- Job deadline (`deadlineAt`) is server-stored and compared against `now()` during atomic claim.
- No duration-since-claim calculations on worker side. Worker just keeps heartbeating. If heartbeats stop arriving, server times out.

---

## Decision 7: Acceptance vs Settlement Thresholds

**These are distinct thresholds. They must never collapse.**

| Threshold | What it means | Gate |
|-----------|--------------|------|
| **Acceptance** | Result is syntactically complete, nonce matches, structural + workload verification passes | `attempt.state → accepted`, `job.state → accepted` |
| **Settlement** | Artifact verified through authoritative trust path, all payouts confirmed on-chain | `job.state → settled` |

### What acceptance does NOT mean
- Does NOT mean "payable" — payouts are created with `status = 'pending'`, not immediately disbursed.
- Does NOT mean artifact is globally available — only that the worker claims it exists and provided a valid hash.
- Does NOT mean the job is finished from the treasury's perspective — settlement is a separate lifecycle.

### State naming for operator clarity
- API responses and logs must use `accepted` (not "completed" or "done") for post-verification state.
- `settled` is the only state that means "money moved, job fully closed."
- Dashboard/UI should show: `accepted (awaiting settlement)` to prevent misinterpretation.

### Settlement inputs are frozen at acceptance

**Payout basis is snapshotted when the attempt is accepted, not read from live mutable state.**

- `acceptAttempt()` computes all three payout amounts (validity, completion, bonus) from the job's `budgetHbd` and the `verificationScore` at acceptance time.
- These amounts are written to `computePayouts` rows immediately, with `status = 'pending'`.
- `settlePayouts()` reads from these frozen payout rows. It never re-reads `budgetHbd`, verification scores, node reputation, or any other mutable config to recompute amounts.
- This prevents "same accepted work, different payout outcome" under config drift, mixed-version rollout, or treasury policy changes after acceptance.

### Implementation
- Payout creation happens at acceptance (3 rows, status=`pending`, amounts frozen).
- Payout disbursement happens at settlement (`settlePayouts()` transitions `pending → queued`, treasury coordinator handles `queued → broadcast → confirmed`).
- Job transitions `accepted → settled` only when ALL payout rows reach `confirmed`.

---

## Decision 8: Mixed-Version Deployment Behavior

**Hard cutover with deterministic rejection.**

### Version scope
- `schema_version` is the **protocol payload version**, not a local worker constant.
- It lives in the manifest (already: `manifest.schema_version`).
- Phase 0 does NOT bump schema_version from 1 to 2. The additions (nonce, provenance, settlement) are backward-compatible extensions to v1.
- Schema version bump to 2 is reserved for when mandatory provenance fields or nonce echo become required (Step 1 completion).

### Transition plan

1. **Phase 0 Step 1-4**: Server accepts both v1 (no nonce/provenance) and v1+ (with nonce/provenance). Nonce and provenance are optional during development.
2. **Phase 0 Step 5** (fault injection tests pass): Server begins requiring nonce echo and mandatory provenance. `schema_version` bumps to 2 in manifest validation.
3. **After bump**: Server rejects `schema_version: 1` manifests with error code `SCHEMA_VERSION_UNSUPPORTED` and message `"Minimum required schema_version is 2"`. Worker gets a deterministic 400 response, not silent drop.

### Rejection timing (binding)

**Missing required v1-extension fields must fail before any state mutation.**

- Version/field validation happens at the **top of the request handler**, before `UPDATE` or `INSERT` statements execute.
- Rejection uses **stable machine-readable error codes** (not freeform strings): `SCHEMA_VERSION_UNSUPPORTED`, `NONCE_REQUIRED`, `PROVENANCE_REQUIRED`.
- All legacy-worker write paths (`/submit`, `/start`, `/progress`, `/fail`) validate consistently through a shared validation layer — not endpoint-by-endpoint improvisation.
- This is what makes the cutover actually deterministic: a v1 worker hitting a v2 server gets the same structured error regardless of which endpoint it calls first.

### Observability
- Every submit, accept, reject, and settlement event includes `schema_version` in structured logs.
- Version mismatch rejections are logged as `version_mismatch_rejected` events.

### Rollback plan
- If v2 causes issues, server can temporarily re-allow v1 by lowering `MIN_SCHEMA_VERSION` config. No code deployment needed — just config change.

---

## Gate A: Canonical Idempotency Key

**Choice: `(attemptId, nonce)` tuple.**

### Why this tuple
- `attemptId` identifies the work slot. `nonce` proves the worker holds the current lease for that slot (server-issued, not worker-generated).
- This is distinct from dedup (same artifact hash across different jobs/attempts).

### Replay behavior (binding)

For a given `(attemptId, nonce)`:

1. **First valid submission** creates the authoritative submission record (state → `submitted`, triggers verification).
2. **Exact replay** (same `(attemptId, nonce)`, same payload hash) returns the original result idempotently (200 OK with existing data). No side effects, no re-verification.
3. **Divergent replay** (same `(attemptId, nonce)`, different payload hash) returns **deterministic conflict** (409 Conflict, error code `SUBMISSION_PAYLOAD_MISMATCH`). This distinguishes harmless retries from tampering.
4. **Stale nonce** (valid `attemptId` but nonce from a previous/different attempt) returns 409 Conflict with `NONCE_MISMATCH`.
5. Nonce is **per-attempt issuance** — a new claim always gets a new nonce. Nonces are never reused.

Payload hash for divergent-replay detection: `SHA256(outputSha256 + resultJson)`, stored on first submission. This is cheap and deterministic — no need to hash the entire request body.

### Why not other candidates
- `(jobId, workerId)` — too coarse. Same worker can have multiple attempts on the same job.
- `(jobId, resultHash)` — confuses idempotency with dedup. Two different workers producing the same hash is dedup, not idempotency.
- `leaseToken` alone — leaseToken is an authorization credential, not an idempotency key. Mixing auth and idempotency creates coupling.

### DB enforcement
- `computeJobAttempts` gets a new column: `nonce` (text, not null, server-generated UUIDv4).
- Unique constraint: `UNIQUE(id, nonce)` — trivially true since `id` is already unique, but the nonce column enables the submit handler to verify the echoed nonce matches.
- Submit handler: `WHERE id = :attemptId AND nonce = :nonce AND state = 'running'`. If 0 rows match, reject.

---

## Gate B: Authoritative Artifact Trust Source

**Choice: Content-address consistency (hash match) for acceptance. Coordinator-visible retrieval for settlement.**

(Full details in Decision 5 above.)

Summary:
- Acceptance gate: `outputSha256` present and valid format (64 hex chars). Worker claims artifact exists.
- Settlement gate: Artifact retrievable via coordinator's IPFS access path. Content re-hashed and compared.
- Worker responsibility: Pin + local readback verification before submit.
- Acceptance does NOT imply settlement-ready.

---

## Gate C: Late-Work Policy

**Choice: Always rejected. Provenance recorded for forensics.**

(Full details in Decision 3 above.)

Summary:
- Submit after lease expiry → 409 Conflict.
- Late work is logged (`late_submit_rejected` event) but not accepted into protocol state.
- Job requeued for another worker if attempts remain.
- No "accepted but unpaid" or "conditional acceptance" — those create ambiguous states.

---

## New DB Columns (Phase 0)

### `computeJobAttempts` additions

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `nonce` | text, not null | Server-generated UUIDv4 at claim time | Idempotency + replay prevention |
| `leaseExpiresAt` | timestamp, not null | `createdAt + job.leaseSeconds` | Authoritative lease expiry boundary |
| `submissionPayloadHash` | text, nullable | null | `SHA256(outputSha256 + resultJson)` — stored on first submit for divergent-replay detection |
| `provenanceJson` | text, nullable | null | Structured provenance metadata (≤ 64 KB) |

### `computeJobs` additions

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `acceptedAttemptId` | varchar, nullable, FK → computeJobAttempts | null | Authoritative winning attempt. At most one per job (code + DB enforced) |
| (state value) | `'settled'` added to state enum | N/A | Terminal state after all payouts confirmed |

### Explicitly NOT added: `settling` state

Job stays `accepted` while payouts are in flight. Payout rows carry settlement progress (`pending → queued → broadcast → confirmed`). Job flips to `settled` only when all required on-chain confirmations exist. A `settling` intermediate state is unnecessary state inflation — only add it if operator UX or retry orchestration later proves it's needed.

### New structured events (observability)
```
claim_issued           — job_id, attempt_id, node_id, nonce, lease_seconds
nonce_issued           — attempt_id, nonce
submit_attempt         — attempt_id, nonce, output_sha256, has_provenance
submit_accepted        — attempt_id, job_id, verification_score
submit_rejected        — attempt_id, job_id, reason, nonce
submit_idempotent      — attempt_id, nonce (duplicate submit, returned existing)
late_submit_rejected   — attempt_id, nonce, output_sha256, timestamps
settlement_attempted   — job_id, payout_ids[], total_hbd
settlement_blocked     — job_id, reason (artifact unavailable, etc.)
settlement_confirmed   — job_id, payout_ids[], tx_ids[]
ownership_mismatch     — attempt_id, expected_state, actual_state
version_mismatch       — attempt_id, submitted_version, required_version
```

---

## New API Behaviors (Phase 0)

### POST /api/compute/jobs/:id/submit — enhanced
- **New request field**: `nonce` (string, required) — echo back the server-issued nonce
- **New request field**: `provenanceJson` (string, optional in v1, required in v2)
- **New behavior**: If `(attemptId, nonce)` already submitted → return existing result (200 OK, idempotent)
- **New behavior**: If nonce doesn't match → 409 Conflict with `NONCE_MISMATCH` error code
- **New behavior**: If attempt state is not `running` → 409 Conflict with `INVALID_STATE` error code (covers late submit, already submitted, etc.)

### POST /api/compute/jobs/:id/settle — enhanced
- **New behavior**: Before transitioning payouts, verify artifact retrievability (Gate B settlement check)
- **New behavior**: If artifact not retrievable → return `{ settled: 0, blocked: true, reason: "artifact_unavailable" }`
- **New response field**: `blocked` (boolean), `reason` (string, if blocked)

### POST /api/compute/jobs/claim-next — enhanced
- **New response field**: `attempt.nonce` included in claim response so worker can echo it back on submit

---

## Test Shapes (Phase 0 Step 5)

### Single-fault scenarios (7 minimum)
1. Worker crash after artifact creation, before pin → checkpoint recovery or fail-closed
2. Worker crash after pin, before submit → checkpoint recovery or fail-closed
3. Submit timeout, unknown server receipt → worker retries with same nonce, server returns idempotent result
4. Duplicate submit after server accept → idempotent return, no double payout
5. Fail/submit race → first-write-wins, loser gets 409
6. Reclaim while stale worker retries → nonce mismatch rejects stale submit
7. IPFS retrieval timeout during settlement verification → payouts stay pending, not rejected

### Compound-fault scenarios (3 minimum)
1. Submit timeout + server accepted + worker crash before local checkpoint → worker restarts, retries with same nonce, gets idempotent 200
2. Artifact pinned + verification timeout + lease expiry + reclaim → old attempt timed_out, new attempt gets new nonce, old artifact orphaned but logged
3. Old worker retry + new worker submit + same hash + different attempts → each attempt has unique nonce, only one can be accepted per job (first-write-wins at job level)

### Ambiguous-success scenarios (2 minimum)
1. Server accepted submit, response lost, worker retries → server returns same accepted result (idempotent), no double payout, settlement proceeds once
2. Settlement committed on-chain, acknowledgment lost, coordinator retries → payout status already `confirmed`, retry is no-op, job already `settled`

---

## Implementation Order

1. **DB migration**: Add `nonce` and `provenanceJson` columns to `computeJobAttempts`. Add `settled` to job state values.
2. **Server: nonce issuance**: Generate nonce at `claimComputeJobAtomic()`, include in claim response.
3. **Server: nonce validation**: Check nonce echo in `submitResult()`. Implement first-write-wins idempotency.
4. **Server: provenance validation**: Accept and store `provenanceJson` in submit. Validate mandatory fields.
5. **Server: settlement guard**: Add artifact retrieval check to `settlePayouts()`. Add `settled` state transition.
6. **Server: structured events**: Emit events for all protocol-significant actions.
7. **Worker: nonce echo**: Store nonce from claim response, include in submit.
8. **Worker: provenance collection**: Collect environment + derivation fields, serialize to JSON.
9. **Worker: checkpoint state machine**: Durable local state for crash recovery.
10. **Tests: fault injection suite**: All 12+ scenarios above.
