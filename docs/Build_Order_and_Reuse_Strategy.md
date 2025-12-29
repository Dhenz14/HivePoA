# Build Order & Code Reuse Strategy (SPK Network Alignment)

## Executive Summary
To achieve a **100% Client-Side & Decentralized** architecture, we will mirror the **SPK Network** design, specifically referencing the `Oratr` desktop app (client) and `ProofOfAccess` (validator).

The build order focuses on the flow of data: **User -> Swarm -> Police**.

---

## Phase 1: The User Client (The "Oratr" Experience)
**Goal:** Replace the centralized API upload with a Browser-based "Node" experience.
**Reuse Strategy:** Mimic **Oratr**'s desktop flow (Transcode -> Hash -> Pin -> Broadcast).

*   **Step 1.1: Browser-Based Transcoding/Hashing**
    *   *Current UI:* Simple "Upload" button.
    *   *New UI:* A client-side processing queue. When a user drops a video, show: "Transcoding (720p)..." -> "Hashing..." -> "Pinning to Local IPFS".
    *   *Reuse:* Conceptually reuse Oratr's `ffmpeg` pipeline (simulated in browser via WASM or mocked).

*   **Step 1.2: The "Seed" Signal**
    *   Instead of POSTing to a server, the client signs a Hive `custom_json` transaction: `spk_video_upload`.
    *   *Reuse:* Use `dhive` (standard Hive JS lib) which SPK uses.

---

## Phase 2: The Storage Swarm (The "Miner" Experience)
**Goal:** Nodes listen to Hive, not a central server.
**Reuse Strategy:** Replicate the **SPK Indexer** logic (listening for specific `custom_json` ops).

*   **Step 2.1: The "Listener" Engine**
    *   Update the Storage Dashboard to have a "Live Feed" of network uploads.
    *   This feed comes directly from Hive blockchain data, not our backend.
    *   *UI:* "New content detected: @user/my-video.mp4 (Size: 50MB). Download?"

*   **Step 2.2: The "Pin" Action**
    *   When a node accepts, it simulates `ipfs.pin.add(cid)`.

---

## Phase 3: The Validator Police (The "ProofOfAccess" Binary)
**Goal:** Automated auditing.
**Reuse Strategy:** Directly reference `github.com/spknetwork/proofofaccess` logic.

*   **Step 3.1: The Challenge Protocol**
    *   Implement the specific salt/hash logic from SPK's Go repo in our mocked "Police Mode".
    *   *Logic:* `Hash(FileChunk + Salt + PeerID)`.

*   **Step 3.2: The "Slash" Transaction**
    *   If a node fails, the Validator broadcasts a `spk_reputation_slash` op to Hive.

---

## Phase 4: Integration & "Tangle"
**Goal:** Governance and Consensus.
**Reuse Strategy:** Use the concept of **L2 State Consensus** (The "Tangle" or SPK's "HoneyComb").

*   **Step 4.1: The State View**
    *   Build a client-side view that aggregates all `custom_json` events to show the "True State" of the network (who stores what).

---

## Recommended Build Order (Immediate Next Steps)

1.  **Enhance Upload UI**: Add the "Transcoding/Hashing" visual step to emphasize client-side work.
2.  **Create "Network Feed"**: A page showing raw Hive stream of uploads (simulated) that nodes can pick from.
3.  **Refine Police Console**: Add the specific "Salt/Hash" details to the log output to match SPK's PoA implementation.
