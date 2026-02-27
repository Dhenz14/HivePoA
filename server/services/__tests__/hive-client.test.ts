import { describe, it, expect } from "vitest";
import { MockHiveClient } from "../hive-client";

describe("MockHiveClient", () => {
  const client = new MockHiveClient({ username: "test-validator" });

  it("getAccount returns a mock account", async () => {
    const account = await client.getAccount("testuser");
    expect(account).toBeDefined();
    expect(account).toHaveProperty("name", "testuser");
    expect(account).toHaveProperty("hbd_balance");
  });

  it("verifySignature returns true for signatures > 10 chars", async () => {
    const result = await client.verifySignature("user", "message", "a_long_signature_string");
    expect(result).toBe(true);
  });

  it("verifySignature returns false for short signatures", async () => {
    const result = await client.verifySignature("user", "message", "short");
    expect(result).toBe(false);
  });

  it("broadcastPoAResult increments transaction counter", async () => {
    const tx1 = await client.broadcastPoAResult("node1", "QmCid", true, 100, "proof");
    const tx2 = await client.broadcastPoAResult("node2", "QmCid", false, 200, "proof");
    expect(tx1.id).not.toBe(tx2.id);
    expect(tx1.blockNumber).toBeGreaterThan(0);
  });

  it("transfer returns a mock transaction", async () => {
    const tx = await client.transfer({
      to: "storage-node",
      amount: "0.050 HBD",
      memo: "PoA reward",
    });
    expect(tx).toHaveProperty("id");
    expect(tx).toHaveProperty("blockNumber");
    expect(tx.id).toContain("mock_tx_");
  });

  it("getLatestBlockHash returns a hex string", async () => {
    const hash = await client.getLatestBlockHash();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("isTopWitness returns true for known witnesses", async () => {
    const result = await client.isTopWitness("blocktrades");
    expect(result).toBe(true);
  });

  it("isTopWitness returns false for unknown users", async () => {
    const result = await client.isTopWitness("random-unknown-user");
    expect(result).toBe(false);
  });

  it("getWitnessRank returns a number for known witnesses", async () => {
    const rank = await client.getWitnessRank("blocktrades");
    expect(rank).toBe(1);
  });

  it("getWitnessRank returns null for unknown users", async () => {
    const rank = await client.getWitnessRank("random-unknown-user");
    expect(rank).toBeNull();
  });
});
