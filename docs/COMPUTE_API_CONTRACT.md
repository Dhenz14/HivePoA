# GPU Compute API Contract — Canary V1

First-pass API contract for Hive-AI's GPU worker and coordinator integration.

## Auth

Two auth schemes:
- **Bearer token** (`Authorization: Bearer <session-token>`) — for job creators/coordinators
- **Agent API key** (`Authorization: ApiKey <key>`) — for GPU workers

Get an API key: `POST /api/auth/agent-key` (requires Bearer auth first).

## Node Lifecycle

### Register Node
```
POST /api/compute/nodes/register
Auth: Bearer (session token)

Body:
{
  "nodeInstanceId": "gpu-HOSTNAME-abc123def456",  // stable per-device, generated once
  "gpuModel": "RTX 4090",
  "gpuVramGb": 24,
  "cudaVersion": "12.4",                          // optional
  "cpuCores": 16,                                 // optional
  "ramGb": 64,                                    // optional
  "supportedWorkloads": "eval_sweep,benchmark_run",
  "cachedModels": "qwen3:14b,Qwen2.5-Coder-14B",  // optional, comma-separated
  "workerVersion": "1.0.0",                        // optional
  "pricePerHourHbd": "0.50",                       // optional
  "maxConcurrentJobs": 1                           // optional, default 1
}

Response: ComputeNode object
```

### Heartbeat
```
POST /api/compute/nodes/heartbeat
Auth: ApiKey

Body:
{
  "nodeInstanceId": "gpu-HOSTNAME-abc123def456",
  "jobsInProgress": 1
}

Response: { "ok": true }
```

**Timing:** Send heartbeat every 20-30s. Lease expires after 2 minutes without heartbeat.

### Drain
```
POST /api/compute/nodes/drain
Auth: ApiKey
Body: { "nodeInstanceId": "..." }
Response: { "ok": true, "status": "draining" }
```

### Get Node(s)
```
GET /api/compute/nodes/me
Auth: ApiKey
Query: ?nodeInstanceId=... (optional — returns specific node, otherwise all nodes for this account)

GET /api/compute/nodes/:id (public)
GET /api/compute/nodes (public — all nodes)
```

## Job Lifecycle (Worker)

### Claim Next Job
```
POST /api/compute/jobs/claim-next
Auth: ApiKey

Body:
{
  "nodeInstanceId": "gpu-HOSTNAME-abc123def456"
}

Response (job found):
{
  "job": { ...full ComputeJob object... },
  "attempt": {
    "id": "uuid",
    "leaseToken": "hex64"
  }
}

Response (no jobs): { "job": null }
```

**Claim is atomic** — uses `SELECT FOR UPDATE SKIP LOCKED`. Two concurrent workers cannot claim the same job.

**Ranking:** Jobs ranked by cache match (preferred) → priority DESC → created_at ASC.

**Warm-up:** Nodes with reputation < 20 can only claim `eval_sweep`, `benchmark_run`, `adapter_validation`.

### Start Job
```
POST /api/compute/jobs/:id/start
Auth: ApiKey

Body:
{
  "attemptId": "uuid",
  "leaseToken": "hex64"
}
```

### Report Progress
```
POST /api/compute/jobs/:id/progress
Auth: ApiKey

Body:
{
  "attemptId": "uuid",
  "leaseToken": "hex64",
  "progressPct": 50,
  "currentStage": "running_eval"   // optional
}
```

**Also serves as heartbeat** — updates `heartbeatAt` on the attempt.

### Submit Result
```
POST /api/compute/jobs/:id/submit
Auth: ApiKey

Body:
{
  "attemptId": "uuid",
  "leaseToken": "hex64",
  "outputCid": "sha256:<hash>",           // content-addressed artifact ID
  "outputSha256": "<64-char hex>",         // REQUIRED, exactly 64 chars
  "outputSizeBytes": 12345,               // optional
  "outputTransportUrl": "https://...",     // optional fast HTTP URL
  "metricsJson": "{...}",                 // optional, untrusted telemetry
  "resultJson": "{...}"                   // structured result per workload type
}
```

**Triggers inline verification.** After submission, HivePoA runs:
1. Structural verification (artifact exists, valid JSON, manifest integrity)
2. Workload-specific verification (result shape check — full hidden eval is Hive-AI's responsibility)

**State transitions:** `running` → `submitted` → `verifying` → `accepted`|`rejected`

### Report Failure
```
POST /api/compute/jobs/:id/fail
Auth: ApiKey

Body:
{
  "attemptId": "uuid",
  "leaseToken": "hex64",
  "reason": "OOM during eval",
  "stderrTail": "last 4KB of stderr"   // optional, max 4000 chars
}
```

Job re-enters queue if attempts remain. Node reputation decreases by 5.

## Job Lifecycle (Coordinator)

### Create Job
```
POST /api/compute/jobs
Auth: Bearer

Body:
{
  "workloadType": "eval_sweep",
  "manifest": { ... },               // any JSON object — HivePoA hashes it, doesn't interpret it
  "budgetHbd": "1.000",              // MUST be \d+\.\d{3} format (3 decimal places)
  "priority": 0,                     // optional, 0-100
  "minVramGb": 16,                   // optional, default 16
  "requiredModels": "qwen3:14b",     // optional, comma-separated
  "leaseSeconds": 3600,              // optional, max 86400
  "maxAttempts": 3                   // optional, 1-10
}
```

### Get Job Details
```
GET /api/compute/jobs/:id
Auth: Bearer

Response includes: job + attempts[] + verifications[] + payouts[]
```

### Cancel Job
```
POST /api/compute/jobs/:id/cancel
Auth: Bearer (must be job creator)

Prorated cancellation payout: min(0.8, elapsed/lease) * 30% of budget
```

### Settle Payouts
```
POST /api/compute/jobs/:id/settle
Auth: Bearer (must be job creator)

Moves pending payouts → queued for treasury processing
```

### Estimate Cost
```
GET /api/compute/estimate?workloadType=eval_sweep&minVramGb=16

Response: { "estimatedHbd": "0.500", "availableNodes": 3 }
```

### Network Stats
```
GET /api/compute/stats (public)

Response: { "totalNodes": 5, "onlineNodes": 3, "totalJobs": 12, "completedJobs": 8, "totalHbdPaid": "4.500" }
```

## Payout Model

Three-stage payouts on job acceptance:
- **validity_fee**: 30% of budget (structural verification passed)
- **completion_fee**: 40% of budget (semantic verification passed)
- **bonus**: 30% of budget × verification score (0.0-1.0)

On cancellation of in-progress job:
- **cancellation_refund**: min(0.8, elapsed/lease) × 30% of budget

Payout states: `pending` → `queued` → `broadcast` → `confirmed`

## State Machine

```
Job:     queued → leased → running → submitted → verifying → accepted|rejected
                                                           ↗ (re-queue if attempts remain)
Attempt: leased → running → submitted → accepted|rejected|timed_out|failed
```

Lease timeout: 2 minutes without heartbeat → attempt `timed_out`, job re-queued.

## Integration Checklist

1. [ ] Get Bearer session token via Hive Keychain login
2. [ ] Create agent API key: `POST /api/auth/agent-key`
3. [ ] Register GPU node with `nodeInstanceId` (persist to disk)
4. [ ] Start heartbeat loop (every 20-30s)
5. [ ] Poll `claim-next` with `nodeInstanceId`
6. [ ] On claim: `start` → report `progress` periodically → `submit` result
7. [ ] On error: `fail` with reason
8. [ ] Coordinator: `create` job → `monitor` state → `verify` result → `settle` payouts
9. [ ] Format budgetHbd as exactly 3 decimal places (e.g., "1.000")
10. [ ] outputSha256 must be exactly 64 hex characters
