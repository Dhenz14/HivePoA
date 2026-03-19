# Staging Measurement Contract — Audit and Open Questions

## Purpose

Before any staging execution results are treated as calibration evidence for
Gates 2 or 3, the measurement contract must be unambiguous. This document
audits what the frozen specs and existing code already define, and identifies
what remains open.

This is a documentation exercise, not an implementation task.

---

## What Is Already Frozen

### 1. Authoritative timing source

**Frozen in Phase 2B protocol spec (item 2 of Acceptable Evidence):**
> "Server-measured deadline met — `checkpoint_received_at − stage_issued_at`
> within the Phase 2B deadline band for this profile."

**Frozen in Phase 2A protocol spec (item 5 of Protocol Summary):**
> "Timing: stage_issued_at (server reveal time) to checkpoint_received_at
> (server receipt) — only interval that counts"

**Frozen in Phase 2A protocol spec (Three Timing Notions):**
> "Server processing time explicitly excluded from worker timing."

**Verdict:** The authoritative timing source is server-side. Both timestamps
are set on the server. Client-reported timing is NOT authoritative. This is
already frozen.

### 2. What timestamp starts the interval

**Code evidence** (`server/storage.ts:3300-3305`):
```javascript
const now = new Date();          // ← inside DB transaction
stageIssuedAt: now,              // ← written to bundle row
stageDeadlineAt: new Date(now.getTime() + profile.stageDeadlineMs),
```

`stage_issued_at` is set to `new Date()` at the moment the server executes the
reveal operation inside the storage transaction. This is the server's wall
clock at the time the stage nonce becomes available to the worker.

For auto-reveal (next stage revealed inside `acceptChallengeCheckpoint`), the
same pattern is used at `storage.ts:3444-3447`.

**Verdict:** Interval start = server `new Date()` at reveal time. Already
implemented.

### 3. What timestamp ends the interval

**Code evidence** (`server/services/phase2a-challenge-service.ts:311`):
```javascript
const receivedAt = new Date();   // ← BEFORE the storage transaction
```

`checkpoint_received_at` is set to `new Date()` at the moment the service
layer receives the checkpoint submission, before the storage transaction
(which includes validation, dedup, digest check, and next-stage reveal).

**Verdict:** Interval end = server `new Date()` at checkpoint receipt, before
validation. Already implemented. Server-side validation latency is excluded
from the worker's measured interval (consistent with the "server processing
time explicitly excluded" rule).

### 4. Deadline enforcement

**Code evidence** (`server/storage.ts:3364`):
```javascript
if (bundle.stageDeadlineAt && receivedAt.getTime() > bundle.stageDeadlineAt.getTime()) {
    result = { error: "STAGE_DEADLINE_MISSED" };
}
```

The deadline check uses the same `receivedAt` timestamp. A worker either
submits before the deadline or doesn't. There is no grace period.

**Verdict:** Deadline check is strict, using server receipt time. Already
implemented.

---

## What Is NOT Yet Defined (Open Questions for Staging Contract)

### Q1. What is included in the measured interval?

The interval `checkpoint_received_at − stage_issued_at` includes:

- [x] Network round-trip time (server → worker → server)
- [x] Worker-side GPU computation time
- [x] Worker-side serialization and HTTP overhead
- [ ] **QUESTION: Does the interval include the auto-reveal of the PREVIOUS
      stage's accept processing?**

For stage 0: `stage_issued_at` is set by an explicit `revealChallengeStage()`
call. Clean.

For stages 1-4: `stage_issued_at` is set inside `acceptChallengeCheckpoint()`
for stage i-1 — meaning the reveal of stage i happens INSIDE the same
transaction as the accept of stage i-1. The worker receives the next stage
nonce in the response to its previous checkpoint submission.

**Implication:** The measured interval for stages 1-4 starts from when the
server reveals the next stage inside the accept-checkpoint transaction. The
worker does not need a separate "fetch next stage" round trip. This is
efficient, but it means the interval starts slightly later than the moment the
worker receives the HTTP response (because the server sets `now` inside the
transaction, not when it sends the response).

**Assessment:** This is a minor timing nuance. In practice, the difference
between "when the server sets the timestamp" and "when the worker receives the
response" is dominated by network latency, which is already included in the
calibration procedure's deadline formula (`positive_p99 + safety_margin`
where `safety_margin = max(3σ, 500ms)`). This is not a contract gap that
needs closing before staging execution.

### Q2. How are retries handled?

**Existing behavior:** Checkpoint insertion is idempotent
(`storage.ts:3333-3343`). If the same `(attempt_id, stage_index)` checkpoint
is submitted twice, the second submission returns the existing checkpoint
without inserting a new row.

**Implication for calibration:** A retry does NOT reset the timing interval.
`stage_issued_at` is set once (one-way mutation). `checkpoint_received_at` is
set on first successful insert. A retry after deadline would still fail the
deadline check because the original `stage_issued_at` is unchanged.

**Assessment:** Clean. No contract gap.

### Q3. How are outliers handled?

**Frozen in calibration plan Section 5.3:**
- Heavy-tail rejection check: `p99/p50 > 2.0` blocks the deadline formula
- Minimum 20 challenges (100 stage observations) per device
- If σ > 15% of median, increase to 40 challenges
- Unimodal distribution required

**Assessment:** Already frozen. No contract gap.

### Q4. Device identity binding — what binds evidence to a specific GPU?

**Frozen in Phase 2B protocol spec (Evidence Attachment Granularity):**
> "Phase 2B evidence attaches to the schedulable execution device, not the
> host."

**Frozen in Phase 2B protocol spec (Implementation gate):**
> "Phase 2B evidence must not be consumed by routing, admission, or UI
> capability display until node identity has been migrated to per-device
> granularity."

**Current code state:** `compute_nodes` currently maps to a host, not a
device. The per-device migration is an implementation prerequisite that is
explicitly deferred.

**OPEN QUESTION: For staging calibration (not production), is host-level
identity sufficient?**

During calibration, the operator physically controls the hardware pair. The
operator knows which GPU is in each machine. The staging environment is not
production — it is a controlled measurement environment.

**Proposed answer:** For calibration evidence, the operator documents the
device identity in the calibration evidence record (GPU model, VRAM,
nvidia-smi UUID, driver version). The per-device identity migration is
required before production use of Phase 2B evidence, but NOT required for the
calibration measurement itself. The calibration record is signed by the
operator, not by the protocol.

**Risk:** If the calibration hardware is a multi-GPU host with device index
ambiguity, the operator must verify which device executed the workload. For
single-GPU machines (which is the expected case for calibration volunteers),
this is trivially satisfied.

**Assessment:** Minor gap. Can be closed by requiring single-GPU machines for
calibration (already in the community requirements checklist) and documenting
the nvidia-smi device UUID in the evidence record.

### Q5. Workload identity binding — what proves the staging challenge used
the correct profile parameters?

**Existing mechanism:** The profile row in `compute_resource_class_profiles`
defines M, N, K, mix_rounds, and deadline. The precomputed bundle set
references the profile via `profile_id`. The bundle contains the expected
digest. If the worker's computation does not match the profile's parameters,
the digest will be wrong and the checkpoint will be rejected.

**Assessment:** Already bound by the digest chain. The workload identity is
cryptographically tied to the profile parameters through the precomputed
expected digest. No contract gap.

### Q6. Clock skew between `stage_issued_at` and `checkpoint_received_at`

Both timestamps come from the same server process via `new Date()`. There is
no cross-machine clock synchronization issue for the timing interval itself.

**Edge case:** If the server is under heavy load, `new Date()` may be delayed
by OS scheduling. The `stage_issued_at` for auto-revealed stages is set inside
a DB transaction, which may introduce milliseconds of delay if the transaction
is contended.

**Assessment:** Not a contract gap for calibration. The safety margin
(min 500ms) absorbs server-side jitter. For production at scale, this could
matter — but that is a Phase 2B operational concern, not a calibration
contract concern.

---

## Summary

| Item | Status | Source |
|---|---|---|
| Authoritative timing source: server-side | **FROZEN** | Phase 2A + 2B protocol specs |
| Interval start: server `new Date()` at reveal | **IMPLEMENTED** | storage.ts:3300 |
| Interval end: server `new Date()` at receipt, before validation | **IMPLEMENTED** | challenge-service.ts:311 |
| Client-reported timing: NOT authoritative | **FROZEN** | Protocol spec: "server-measured" |
| Deadline enforcement: strict, using server receipt time | **IMPLEMENTED** | storage.ts:3364 |
| Retry handling: idempotent, no timing reset | **IMPLEMENTED** | storage.ts:3333 |
| Outlier handling: heavy-tail check + sample size rules | **FROZEN** | Calibration plan Section 5.3 |
| Workload identity: digest chain binds to profile | **IMPLEMENTED** | storage.ts:3376 |
| Clock skew: same process, no cross-machine issue | **IMPLEMENTED** | N/A |
| Device identity for calibration: operator-documented, single-GPU | **OPEN (minor)** | Needs explicit note |
| Device identity for production: per-device migration required | **FROZEN (gate)** | Phase 2B spec implementation gate |

## Conclusion

The staging measurement contract is **substantially already defined** by the
frozen specs and existing implementation. The interval definition, authority
model, retry semantics, outlier handling, and workload binding are all closed.

The one genuinely open question is device identity binding for calibration
specifically (Q4), which is minor and can be closed by the existing requirement
for single-GPU calibration machines + operator documentation of the device UUID.

**There is no need to write a new measurement contract.** The staging challenge
server, when built, must implement the existing Phase 2A challenge protocol
exactly. The timing interval, authority model, and deadline enforcement are
inherited from Phase 2A. Phase 2B adds only the new profile rows with larger
dimensions and separately calibrated deadlines — per the frozen spec:
"No new routes. No new challenge lifecycle."

The staging server is not a new protocol surface. It is a deployment of the
existing protocol surface with a Phase 2B profile row loaded.
