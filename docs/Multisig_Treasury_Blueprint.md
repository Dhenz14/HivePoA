# Multisig Treasury Blueprint (Historical)

> **Note**: This document was the original planning blueprint for the multisig treasury system. The system has been **fully implemented**. For current documentation, see [TREASURY.md](./TREASURY.md).

## What Was Built

The implementation simplified the original blueprint significantly:

| Blueprint | Implementation | Rationale |
|-----------|----------------|-----------|
| 4 tables (including `treasury_penalties`) | 3 tables | Churn protection via simple cooldowns, no penalty scoring |
| 11 new files | 5 new files | Reused existing WebSocket, no separate coordinator server |
| 15 API endpoints | 9 endpoints | Consolidated, removed redundant admin endpoints |
| Separate `/ws/treasury-signer` WebSocket | Reuse existing `/ws/agent` | Same connection handles PoA challenges and signing requests |
| Uptime scoring + penalty tables | Simple cooldowns (7d/30d) | Less complexity, same outcome |
| Fixed 10 signers, 6-of-10 threshold | Dynamic N signers, 60% threshold | More flexible as network grows |

## Implementation Files

### New Files (5)
- `shared/treasury-types.ts` — Shared interfaces and constants
- `server/services/treasury-hive.ts` — dhive multisig primitives
- `server/services/treasury-coordinator.ts` — Core orchestration (~630 lines)
- `desktop-agent/src/main/treasury-signer.ts` — Agent-side auto-signing
- `client/src/pages/treasury.tsx` — Treasury dashboard UI

### Modified Files (14)
- `shared/schema.ts` — 3 new tables
- `shared/schema-sqlite.ts` — SQLite mirror
- `server/db-sqlite.ts` — CREATE TABLE statements
- `server/storage.ts` — ~15 treasury storage methods
- `server/storage-sqlite.ts` — SQLite mirror
- `server/routes.ts` — 9 treasury API endpoints
- `server/services/agent-ws-manager.ts` — Treasury WebSocket integration
- `server/services/poa-engine.ts` — Treasury payment routing with fallback
- `desktop-agent/src/main/config.ts` — Active key storage
- `desktop-agent/src/main/agent-ws.ts` — SigningRequest handling
- `desktop-agent/src/main/index.ts` — TreasurySigner initialization
- `client/src/App.tsx` — Treasury route
- `client/src/components/layout/Sidebar.tsx` — Treasury nav item
- `package-lock.json` — Dependency updates

For full technical documentation, see [TREASURY.md](./TREASURY.md).
