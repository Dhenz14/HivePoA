# Validator Ranking & Filtering Logic

## 1. Validator Ranking System (The "Watcher of Watchers")

The system relies on a **Global Reputation Rank** to allocate work. Storage Nodes do **not** manually filter validators; instead, the protocol automatically biases towards high-ranking validators.

### Ranking Metrics (0-100 Score)
The score is calculated based on on-chain data and peer feedback:
1.  **Payout Reliability (40%)**: Does this Validator actually send HBD when a proof is valid?
2.  **Uptime / Availability (30%)**: Is the Validator online to issue challenges?
3.  **Hive Witness Rank (20%)**: Higher rank = more community trust.
4.  **Fee Competitiveness (10%)**: Reasonable fees.

### The "Rank = Jobs" Mechanism
*   **High Rank (Top 50)**: The protocol automatically directs the majority of storage nodes to peer with these validators. They receive the most "Jobs" (audit requests) and thus distribute the most rewards.
*   **Low Rank**: Nodes automatically deprioritize these connections. Bad validators receive fewer jobs.
*   **Malicious (0 Score)**: Effectively cut off from the network as their "Job Weight" hits zero.

**Key Distinction:** Users (Storage Nodes) cannot "block" or "filter" validators manually. They simply follow the protocol's ranking consensus.

---

## 2. Validator Filtering Policies (The "Gatekeeper")

Validators (Witnesses) spend their own money (HBD) to reward nodes. They **DO** have the right to filter who they audit.

### Configurable Filters (Policy Engine)
Validators can set these rules in their `config.yaml` or UI:

1.  **Minimum Reputation Score**: "I will only audit nodes with Reputation > 50."
    *   *Effect:* Filters out unreliable or new nodes.
2.  **Stake/Collateral**: "Node must have > 10 HBD in Savings." (Sybil resistance).
3.  **Content Whitelist/Blacklist**:
    *   "Only audit content with tag #hive."
    *   "Ignore content flagged as spam."
4.  **Network Topology**: "Max 5 nodes per IP subnet." (Anti-centralization).

### The "Job Negotiation" Protocol
1.  Storage Node announces availability to Validator.
2.  Validator checks Policy:
    *   `If (Node.Reputation < Config.MinRep)` -> **REJECT** ("Reputation too low").
3.  If Accepted, Validator adds Node to the "Challenge Pool".
