# SPK Network 2.0 - Decentralized Storage Validation System

## Overview

SPK Network 2.0 (HivePoA) is a comprehensive decentralized storage validation protocol that integrates with the Hive blockchain for HBD (Hive Backed Dollar) payments. This is a complete reimplementation of the original SPK Network, repurposing code from trole, oratr, and proofofaccess repositories while removing unnecessary complexity.

**Core Innovation**: Proof of Access (PoA) - Cryptographic validation that storage nodes physically hold the files they claim to store.

## Recent Changes (December 2025)

### 3Speak Integration
- **Browse Network**: Users can discover trending/new videos from 3Speak
- **IPFS Pinning**: Pin videos to local IPFS node with one click
- **CID Extraction**: Automatically extracts IPFS CIDs from playUrl

### Phase 1-4 Complete Implementation
- **Phase 1**: CDN with geo-routing, chunked uploads, storage contracts
- **Phase 2**: Video transcoding with encoder marketplace
- **Phase 3**: Multi-tier blocklists, community tagging, content fingerprinting
- **Phase 4**: E2E encryption, auto-pinning, beneficiary rewards

## Documentation

| Document | Description |
|----------|-------------|
| [SPK Network 2.0 PoA Protocol](docs/SPK_NETWORK_2.0_POA.md) | Complete technical specification of the PoA algorithm |
| [Architecture](docs/ARCHITECTURE.md) | System architecture, components, and data flow |
| [Validator Guide](docs/VALIDATOR_GUIDE.md) | How to run a PoA validator node |
| [Storage Node Guide](docs/STORAGE_NODE_GUIDE.md) | How to provide storage and earn HBD |
| [Local IPFS Setup](docs/LOCAL_IPFS_SETUP.md) | Set up a local IPFS node for testing |

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight router)
- **State Management**: TanStack React Query
- **Styling**: Tailwind CSS v4 with shadcn/ui
- **UI Components**: Radix UI primitives
- **Animations**: Framer Motion
- **Charts**: Recharts

### Backend Architecture
- **Framework**: Express.js with TypeScript
- **Database**: PostgreSQL with Drizzle ORM
- **Real-time**: WebSocket server (ws library)
- **API Pattern**: RESTful endpoints under `/api/*`

### Backend Services

| Service | File | Description |
|---------|------|-------------|
| IPFS Manager | `ipfs-manager.ts` | Auto-starts IPFS daemon on server boot |
| Hive Simulator | `hive-simulator.ts` | Emits blockchain events every 3s |
| PoA Engine | `poa-engine.ts` | Runs validation challenges every 5s |
| CDN Manager | `cdn-manager.ts` | Health monitoring and geo-routing |
| Upload Manager | `upload-manager.ts` | Chunked uploads with CID verification |
| Transcoding Service | `transcoding-service.ts` | Video encoding with job queue |
| Blocklist Service | `blocklist-service.ts` | Multi-tier content moderation |
| Encryption Service | `encryption-service.ts` | AES-GCM E2E encryption |
| Auto-Pin Service | `auto-pin-service.ts` | Auto-pin viewed content |
| Beneficiary Service | `beneficiary-service.ts` | HBD reward splitting |
| IPFS Gateway | `ipfs-gateway.ts` | CDN-routed IPFS proxy |
| 3Speak Service | `threespeak-service.ts` | 3Speak video browsing and pinning |

### Data Models (shared/schema.ts)

**Core Tables**:
- `storage_nodes`: IPFS nodes earning HBD with reputation (0-100)
- `files`: Content stored with CIDs, encryption, and fingerprinting
- `validators`: Hive Witnesses running PoA software
- `poa_challenges`: Challenge-response records
- `hive_transactions`: Blockchain transaction log
- `storage_assignments`: Node-to-file mapping

**Phase 1 Tables**:
- `cdn_nodes`: CDN endpoints with health scores and geo data
- `cdn_metrics`: Latency/performance history
- `file_chunks`: Chunked upload tracking
- `storage_contracts`: Blockchain-verified storage agreements
- `contract_events`: Contract lifecycle events

**Phase 2 Tables**:
- `transcode_jobs`: Video encoding tasks
- `encoder_nodes`: Encoder marketplace

**Phase 3 Tables**:
- `blocklist_entries`: Unified multi-tier blocklist
- `platform_blocklists`: Per-platform policies
- `tags`: Content categorization
- `file_tags`: Community-voted tags
- `tag_votes`: Individual votes

**Phase 4 Tables**:
- `user_keys`: Encryption key vault
- `user_node_settings`: Auto-pin preferences
- `view_events`: View tracking for auto-pin
- `beneficiary_allocations`: HBD reward splits
- `payout_history`: All payouts logged

### API Routes

**Gateway**: `/ipfs/:cid` - CDN-routed IPFS proxy
**CDN**: `/api/cdn/*` - Node management and recommendations
**Uploads**: `/api/upload/*` - Chunked file uploads
**Contracts**: `/api/contracts/*` - Storage contract management
**Transcoding**: `/api/transcode/*` - Video encoding
**Moderation**: `/api/blocklist/*`, `/api/tags` - Content moderation
**Encryption**: `/api/encryption/*` - Key management
**Auto-Pin**: `/api/settings/*`, `/api/view` - User settings
**Beneficiaries**: `/api/beneficiaries/*`, `/api/payouts/*` - Reward splitting
**3Speak**: `/api/threespeak/*` - Video browsing and pinning

### Key Design Decisions

**Health Score Encoding** (from SPK's trole/healthScore.js):
- Base64 characters represent z-scores (standard deviations)
- 2-character format: raw latency + geo-corrected
- `W` = 0 standard deviations (normal)
- Enables compact storage and network transmission

**Geographic Correction** (from SPK's trole/geoCorrection.js):
- Adjusts latency expectations based on distance
- Categories: same (5ms), local (20ms), continental (50ms), intercontinental (150ms)
- Prevents penalizing distant but healthy nodes

**Federated Trust Model**: Uses Hive's DPoS - Top 150 Witnesses as validators
**HBD as Payment Rail**: No custom tokens, just Hive Backed Dollars
**Reputation-Based Filtering**: Quality tiers via reputation thresholds

## Environment Variables

**Required for Live Mode**:
- `SPK_POA_URL`: SPK PoA node URL
- `IPFS_API_URL`: IPFS HTTP API URL
- `HIVE_USERNAME`: Hive account username
- `HIVE_POSTING_KEY`: Hive posting key
- `HIVE_ACTIVE_KEY`: Hive active key (optional, for HBD transfers)

## External Dependencies

### Database
- PostgreSQL with Drizzle ORM
- `npm run db:push` to sync schema

### Blockchain
- `@hiveio/dhive`: Hive blockchain integration

### Frontend
- React, TanStack Query, Radix UI, Framer Motion, Recharts, Lucide

### Build
- Vite, esbuild, tsx

## Code Provenance

This implementation repurposes code patterns from:
- **trole**: CDN health scoring, geo-correction, upload queue
- **oratr**: Transcoding job management
- **proofofaccess**: PoA cryptographic algorithm (FNV-1a + SHA256)
