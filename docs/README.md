# SPK Network 2.0 Documentation

## Overview

SPK Network 2.0 is a streamlined decentralized storage validation protocol. This is the next evolution of the SPK Network, removing unnecessary complexity while preserving the core innovation: **Proof of Access (PoA)** — now backed by a **native Hive L1 multisig treasury** for trustless reward distribution.

---

## Documentation Index

### Core Documentation

| Document | Description |
|----------|-------------|
| [SPK Network 2.0 PoA Protocol](./SPK_NETWORK_2.0_POA.md) | Complete technical specification of the Proof of Access algorithm and protocol |
| [Architecture](./ARCHITECTURE.md) | System architecture, component design, data flow, and multisig treasury architecture |
| [Multisig Treasury](./TREASURY.md) | Complete treasury system documentation: how it works, signing flow, authority rotation, security |

### Research & Design

| Document | Description |
|----------|-------------|
| [Multisig Treasury Research](./Multisig_Treasury_Research.md) | Deep-dive research: Hive L1 multisig mechanics, auto-signing, cryptographic approaches, HF28 changes |
| [Decentralized HBD Architecture](./Decentralized_HBD_Architecture.md) | Feasibility analysis of HBD-based governance |
| [Hive Witness Federation](./Hive_Witness_Federation_Architecture.md) | Witness-as-validator federation model |
| [PoA Architecture and Gameplan](./PoA_Architecture_and_Gameplan.md) | PoA system design and implementation strategy |

### Guides

| Guide | Audience |
|-------|----------|
| [Validator Guide](./VALIDATOR_GUIDE.md) | Hive Witnesses who want to run PoA validators and optionally become treasury signers |
| [Storage Node Guide](./STORAGE_NODE_GUIDE.md) | Operators who want to provide storage and earn HBD |

---

## Quick Links

### For Developers

- [Original SPK Network PoA](https://github.com/spknetwork/proofofaccess) - The Go implementation we ported
- [Hive Blockchain](https://hive.io) - The blockchain we use for payments and reputation
- [IPFS Documentation](https://docs.ipfs.tech) - The storage layer
- [dhive Library](https://github.com/openhive-network/dhive) - TypeScript library for Hive blockchain operations

### Key Concepts

- **Proof of Access (PoA)**: Cryptographic verification that a node has a file without downloading the entire file
- **Validator**: A node that audits storage providers (typically Hive Witnesses)
- **Storage Node**: A node that stores files and earns HBD for passing PoA challenges
- **HBD**: Hive Backed Dollar - the stablecoin used for payments
- **Multisig Treasury**: Shared `@hivepoa-treasury` account controlled by multiple witnesses via Hive L1 native weighted authority
- **Web of Trust (WoT)**: Extension of DPoS — witnesses vouch for non-witnesses to participate as validators or treasury signers

---

## What Changed from SPK Network 1.0

### Removed

| Component | Reason |
|-----------|--------|
| Honeycomb | Unnecessary middleware layer |
| LARYNX token | Simplified to HBD only |
| BROCA token | Simplified to HBD only |
| SPK token | Simplified to HBD only |
| Complex tokenomics | Reduced speculation, increased utility |
| libp2p PubSub | Replaced with simpler WebSocket/REST |

### Kept

| Component | Why |
|-----------|-----|
| PoA Algorithm | Core innovation - works well |
| IPFS Integration | Standard for decentralized storage |
| Hive Blockchain | Proven, fast, free transactions |
| Witness-as-Validator | Already trusted infrastructure |

### Added

| Component | Benefit |
|-----------|---------|
| **Multisig Treasury** | No single point of failure for fund management |
| Direct HBD payments | Simpler economics |
| REST/WebSocket API | Easier integration |
| Web UI Dashboard | Better monitoring (including treasury dashboard) |
| **Web of Trust** | Extends DPoS trust to non-witness participants |
| Simulation mode | Easy development/testing |

---

## Getting Started

### Run in Simulation Mode

```bash
# Clone and install
git clone <repository>
cd spk-network-2.0
npm install

# Initialize database
npm run db:push

# Start in simulation mode
npm run dev
```

### Run in Live Mode

```bash
# Set environment variables
export SPK_POA_URL=http://your-spk-node:3000
export IPFS_API_URL=http://127.0.0.1:5001
export HIVE_USERNAME=your-account
export HIVE_POSTING_KEY=5K...

# Enable treasury (optional)
export TREASURY_ENABLED=true

# Start
npm run dev
```

---

## Contributing

This is an open-source project. Contributions welcome:

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

---

## Credits

### Original SPK Network
- Steven Ettinger (@disregardfiat)
- Nathan Senn (@nathansenn)

### SPK Network 2.0
Built on the foundation of the original, streamlined for efficiency.

---

## License

Unlicense - Free for any use.
