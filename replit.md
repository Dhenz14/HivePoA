# SPK Network 2.0 - Decentralized Storage Validation System

## Overview

SPK Network 2.0 (HivePoA) is a decentralized storage validation protocol that integrates with the Hive blockchain for HBD (Hive Backed Dollar) payments. It focuses on Proof of Access (PoA), a cryptographic method to validate that storage nodes physically hold the files they claim to store. This project aims to provide a robust, decentralized storage solution with a comprehensive ecosystem for storage operators and validators. The business vision is to create a reliable and incentivized decentralized storage network, leveraging the Hive blockchain for payments and a federated trust model.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Hybrid PWA Architecture
The system features a hybrid Progressive Web App (PWA) architecture:
-   **Browser Node (Helia)**: An in-browser IPFS node using Helia, offering no-installation usage with IndexedDB persistence.
-   **Desktop Agent (Tauri)**: A one-click desktop application (Tauri-based) that runs a 24/7 IPFS node, integrates with the system tray, and provides a local HTTP API for web app detection. It handles Hive account linking, earnings tracking, and PoA challenge responses, with auto-start on boot and native notifications.
-   **Connection Modes**: Supports Browser (Helia), Local (Kubo daemon), Remote, and Demo connections.
-   **Static Build**: The application can be built for static hosting platforms like GitHub Pages or IPFS.

### Core Features
-   **Proof of Access (PoA)**: The core innovation, providing cryptographic validation of file storage. Includes parallel block fetching, a 2-second challenge timeout, LRU block caching, batch challenges, weighted node selection, Hive block entropy for unpredictability, consecutive failure tracking, and streak bonuses.
-   **3Speak Integration**: Allows users to browse and pin 3Speak videos to their local IPFS node, with real-time pinning progress tracking.
-   **Storage Operator Dashboard**: Provides comprehensive tools for storage operators, including:
    -   **Earnings Dashboard**: Tracks HBD earnings, streaks, ban risks, and challenge activity.
    -   **Content Marketplace**: Recommends high-value content for pinning based on rarity and ROI.
    -   **Performance Analytics**: Monitors proofs/hour, bandwidth, success rates, and latency.
    -   **Alert System**: Notifies operators of milestones and warnings.
-   **Hive Keychain Authentication**: Secure login for validators using the Hive Keychain browser extension, restricting access to the top 150 Hive witnesses. Features server-side sessions, challenge replay protection, and protected API routes.
-   **Validator Operations Center**: Tools for validators to police the network:
    -   **Validator Dashboard**: Overview of challenge statistics, success/fail ratios, and validation earnings.
    -   **Node Monitoring**: Health map, risk assessment, and detailed drilldown for storage nodes.
    -   **Challenge Queue**: Manages pending, active, and historical challenges.
    -   **Fraud Detection**: Identifies suspicious patterns, outsourcing, collusion, and hash mismatches.
    -   **Payout Report Generator**: Validators generate payout reports from PoA data, exportable as JSON for wallet execution.
-   **Network Wallet Dashboard**: Tracks central wallet deposits, pending/executed payouts, and available balance for the storage payment system.

### Frontend Architecture
-   **Framework**: React 18 with TypeScript
-   **Routing**: Wouter
-   **State Management**: TanStack React Query
-   **Styling**: Tailwind CSS v4 with shadcn/ui and Radix UI primitives
-   **Animations**: Framer Motion
-   **Charts**: Recharts

### Backend Architecture
-   **Framework**: Express.js with TypeScript
-   **Database**: PostgreSQL with Drizzle ORM
-   **Real-time**: WebSocket server (ws library)
-   **API Pattern**: RESTful endpoints

### Key Design Decisions
-   **Health Score Encoding**: Uses a compact Base64 encoding for health scores, based on z-scores, for efficient storage and transmission.
-   **Geographic Correction**: Adjusts latency expectations based on geographical distance to prevent unfair penalties.
-   **Federated Trust Model**: Leverages Hive's DPoS model, with the top 150 Witnesses acting as validators.
-   **HBD as Payment Rail**: Utilizes Hive Backed Dollars for all payments, avoiding custom tokens.
-   **Reputation-Based Filtering**: Implements quality tiers for storage nodes based on their reputation.

### Data Models
The system uses PostgreSQL with Drizzle ORM, organizing data into core tables for storage nodes, files, validators, PoA challenges, and Hive transactions, alongside specific tables for CDN, transcoding, moderation, encryption, and reward allocation features across different development phases.

### API Routes
A comprehensive set of API routes manages various functionalities including IPFS gateway, CDN, uploads, contracts, transcoding, moderation, encryption, user settings, beneficiaries, and 3Speak integration.

## External Dependencies

### Database
-   PostgreSQL with Drizzle ORM

### Blockchain
-   `@hiveio/dhive` for Hive blockchain integration

### Frontend Libraries
-   React, TanStack Query, Radix UI, Framer Motion, Recharts, Lucide

### Build Tools
-   Vite, esbuild, tsx