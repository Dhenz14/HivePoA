# Go-To-Market Plan: Making HivePoA Live

## 1. Feasibility Analysis: "Live" Launch
**Difficulty Level:** Moderate (4-6 weeks for MVP)

Since we have simplified the architecture to use **Hive Witnesses** as trusted validators and **HBD** for payments, the path to a live production system is clear. We are no longer building a new consensus mechanism; we are building a *utility layer* on top of Hive.

## 2. Core Components to Build (Backend)

### A. The "Witness-Validator" Binary (Go)
This is the piece of software a Hive Witness will run.
*   **Opt-In Logic:**
    *   Reads `config.yaml` for Hive Username & Active Key.
    *   Queries Hive API (`condenser_api.get_witness_by_account`) to verify `rank <= 150`.
    *   If valid, it starts the **PoA Engine**.
*   **PoA Engine Logic:**
    *   **Listen**: Connects to the HivePoA P2P network (libp2p).
    *   **Select**: Every `N` minutes, picks a random connected Storage Peer.
    *   **Challenge**: Requests a random chunk hash from a random CID that peer claims.
    *   **Verify**: Compares response with local IPFS data.
    *   **Punish/Reward**:
        *   *Success*: Broadcast HBD Transfer (`memo: PoA Reward`).
        *   *Fail*: Log "Strike" in local DB. Publish "Reputation Slash" custom JSON to Hive.

### B. The "Storage-Provider" Binary (Go)
This is what users run to earn HBD.
*   **Setup**: Users pin files to their local IPFS node.
*   **Announce**: Broadcast `hivepoa_announce` custom JSON with list of CIDs.
*   **Serve**: Listen for WebSocket challenges from verified Witnesses.
*   **Respond**: Read chunk from disk -> Hash -> Reply.

---

## 3. UI Implementation Plan (The "Reputation System")

We need to visualize the consequences of failing PoA.

### New "Reputation" Logic
*   **Score**: 0-100 (Starts at 50).
*   **Success**: +1 Score (Max 100).
*   **Failure**: -5 Score (Min 0).
*   **Consequences**:
    *   **< 30**: "Probation" (Reduced Rewards).
    *   **< 10**: "Banned" (Validators disconnect, 0 Rewards).

### UI Updates Required
1.  **Storage Node Dashboard**:
    *   Show "Current Reputation Score".
    *   Visual "Health Bar" (Green/Yellow/Red).
    *   Log of "Failed Challenges" with reasons (e.g., "Timeout", "Bad Hash").
2.  **Validator Dashboard**:
    *   "Ban List" table.
    *   "Slashed Nodes" activity feed.

---

## 4. Development Roadmap

### Week 1: The Core Protocol (Go)
*   Implement `Challenge(cid, salt)` and `Verify(response)` functions.
*   Implement Hive Witness Rank Check.

### Week 2: Networking (libp2p)
*   Connect Storage Nodes to Witness Validators.
*   Implement secure WebSocket tunnels for challenges.

### Week 3: Hive Integration (HBD)
*   Implement HBD Transfer logic using `go-hive`.
*   Implement Custom JSON logging for Reputation events.

### Week 4: Beta Testing (Testnet)
*   Deploy on Hive Testnet (MirrorNet).
*   Run 5 fake "Witnesses" and 20 Storage Nodes.
*   Simulate failures (unplug drives, network lag) to test punishment logic.

---

## 5. Conclusion
This system is ready to be built. The architecture is sound. The hardest part is no longer "consensus" but simply **tuning the economics** (how much HBD per GB?) and **hardening the P2P networking** (preventing DDoS).
