# Generic Trusted-Role Registry — Spec

## Design Position

HivePoA defines trusted-role eligibility through a **witness-rooted Web of Trust**.
This is a **permissioned governance overlay**, not open stake-weighted voting.

All privileged operational roles (validators, treasury signers, compute verifiers,
oracle runners, DBC trainers) share the same trust root but may have different
eligibility rules, vouch requirements, and quorum policies.

## Trust Root

- **Root of trust:** Top-150 Hive witnesses (as determined by `condenser_api.get_witnesses_by_vote`)
- **Delegated trust:** Direct witness vouches only (one hop)
- **No transitive chains:** A vouched user cannot vouch for others
- **Auto-revocation:** When a voucher drops out of the top 150, all their vouches are invalidated

## Roles

| Role | Direct Eligibility | Vouch Requirement | Opt-In | Quorum |
|------|-------------------|-------------------|--------|--------|
| `validator` | Top-150 witness | 1 witness vouch | Yes | N/A (individual) |
| `treasury_signer` | Top-150 witness | 3 witness vouches | Yes | 60% transfers, 80% authority |
| `compute_verifier` | Top-150 witness | 2 witness vouches | Yes | N/A (individual) |
| `oracle_runner` | Top-150 witness | 2 witness vouches | Yes | N/A (individual) |
| `dbc_trainer` | Top-150 witness | 2 witness vouches | Yes | N/A (individual) |

## Schema

### `trusted_roles` (new table — replaces nothing, extends the system)

Central registry of who holds what role and why.

```
trusted_roles:
  id                  VARCHAR PK
  username            TEXT NOT NULL          -- Hive username
  role                TEXT NOT NULL          -- validator, treasury_signer, compute_verifier, etc.
  status              TEXT NOT NULL DEFAULT 'active'  -- active, cooldown, suspended, removed
  eligibility_type    TEXT NOT NULL          -- 'witness' or 'vouched'
  witness_rank        INTEGER               -- rank at time of eligibility (null if vouched)
  opted_in_at         TIMESTAMP
  cooldown_until      TIMESTAMP
  removed_at          TIMESTAMP
  remove_reason       TEXT
  metadata_json       TEXT
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()

  UNIQUE(username, role)
```

### `trusted_role_vouches` (new table — unified vouching)

One vouch table for all roles. Replaces the need for per-role vouch tables.

```
trusted_role_vouches:
  id                  VARCHAR PK
  voucher_username    TEXT NOT NULL          -- Top-150 witness doing the vouching
  candidate_username  TEXT NOT NULL          -- Who they're vouching for
  role                TEXT NOT NULL          -- Which role this vouch applies to
  voucher_rank        INTEGER NOT NULL       -- Witness rank at time of vouch
  active              BOOLEAN NOT NULL DEFAULT true
  revoked_at          TIMESTAMP
  revoke_reason       TEXT                   -- 'manual', 'voucher_deranked', 'candidate_removed'
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()

  UNIQUE(voucher_username, candidate_username, role) WHERE active = true
```

### `trusted_role_policies` (new table — per-role configuration)

```
trusted_role_policies:
  role                TEXT PK               -- e.g. 'compute_verifier'
  vouches_required    INTEGER NOT NULL DEFAULT 2
  cooldown_hours      INTEGER NOT NULL DEFAULT 168  -- 7 days
  max_churn_events    INTEGER NOT NULL DEFAULT 5
  requires_opt_in     BOOLEAN NOT NULL DEFAULT true
  auto_eligible_witness_rank  INTEGER NOT NULL DEFAULT 150
  description         TEXT
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
```

## API Surface

### Eligibility Check (the key endpoint Hive-AI calls)

```
GET /api/trust/check/:username/:role

Response:
{
  "eligible": true,
  "eligibility_type": "witness",     // or "vouched"
  "witness_rank": 42,                // null if vouched
  "vouchers": [],                    // list of voucher usernames if vouched
  "opted_in": true,
  "status": "active",
  "role": "compute_verifier"
}
```

### Role Management

```
GET    /api/trust/roles                    -- List all defined roles + policies
GET    /api/trust/roles/:role/members      -- List active members of a role
POST   /api/trust/roles/:role/opt-in       -- Opt into a role (requireAuth)
POST   /api/trust/roles/:role/opt-out      -- Opt out (requireAuth, triggers cooldown)
```

### Vouching

```
POST   /api/trust/vouch                    -- Vouch for a candidate for a role (witness only)
  Body: { "candidateUsername": "...", "role": "compute_verifier" }

DELETE /api/trust/vouch                    -- Revoke a vouch
  Body: { "candidateUsername": "...", "role": "compute_verifier" }

GET    /api/trust/vouches/:role            -- List active vouches for a role
GET    /api/trust/vouches/by/:username     -- List all vouches made by a witness
GET    /api/trust/vouches/for/:username    -- List all vouches received by a candidate
```

### Admin / System

```
POST   /api/trust/refresh-witnesses        -- Re-check witness ranks, revoke stale vouches
GET    /api/trust/audit-log                -- Recent trust state changes
```

## Migration Plan

### Phase 1: Add new tables + endpoints (non-breaking)

Add `trusted_roles`, `trusted_role_vouches`, `trusted_role_policies` tables.
Add `/api/trust/*` endpoints.
Seed policies for all 5 roles.
**Do NOT remove existing `web_of_trust` or `treasury_vouches` tables yet.**

### Phase 2: Dual-write (backward compatible)

When a validator vouch is created via `/api/wot/vouch`, also write to `trusted_role_vouches`.
When a treasury vouch is created via `/api/wot/treasury-vouch`, also write to `trusted_role_vouches`.
New roles (compute_verifier, oracle_runner, dbc_trainer) only use the new tables.

### Phase 3: Read migration

Update validator eligibility checks to read from `trusted_roles` instead of `web_of_trust`.
Update treasury signer eligibility to read from `trusted_roles` instead of `treasury_vouches`.
Old endpoints continue to work but delegate to the new service internally.

### Phase 4: Cleanup (optional, not urgent)

Remove old `web_of_trust` and `treasury_vouches` tables.
Remove old `/api/wot/vouch` and `/api/wot/treasury-vouch` endpoints.
Or keep them as aliases that delegate to `/api/trust/*`.

## Guardrails (retained from existing system)

- Opt-in only — no one is force-enrolled
- One-hop vouching only — no transitive trust
- Auto-revocation when voucher loses witness status
- Cooldowns on opt-out (7 days default, 30 days for frequent churners)
- Audit logs for all trust state changes
- Emergency suspend (any active member of a role can flag)
- Per-role quorum policies where applicable

## What This Does NOT Include

- HP staking or weighting for privileged roles
- Hive account reputation scores
- Hybrid trust formulas
- Transitive vouch chains
- Open voting mechanisms
- Generic arbitrary role creation (roles are defined in policy table)

## Integration Contract for Hive-AI

Hive-AI calls ONE endpoint:

```
GET /api/trust/check/:username/:role
```

If `eligible: true` and `status: active`, the user is trusted for that role.
No HP checks. No reputation math. Binary yes/no.
```

