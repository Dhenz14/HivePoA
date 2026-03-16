/**
 * Hive Mainnet Burn-In Script
 *
 * Exercises the full read → write → confirm path against real Hive mainnet.
 * Requires HIVE_USERNAME, HIVE_POSTING_KEY, HIVE_ACTIVE_KEY in env.
 *
 * Usage:
 *   npx tsx scripts/hive-burn-in.ts
 *
 * Sequence:
 *   Phase 1 — Read-only smoke tests (getAccount, witnesses, block hash, balance)
 *   Phase 2 — Write: broadcast one custom_json, confirm inclusion
 *   Phase 3 — Write: broadcast one tiny HBD transfer (0.001 HBD), confirm inclusion
 *   Phase 4 — Reconciliation: verify both txs reach irreversible status
 */

import { createHiveClient, HiveClient, MockHiveClient } from "../server/services/hive-client";

const SEPARATOR = "─".repeat(60);

function log(phase: string, msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${ts}] [${phase}] ${msg}${suffix}`);
}

function fail(phase: string, msg: string, err?: any): never {
  log(phase, `FAIL: ${msg}`, err?.message || err);
  process.exit(1);
}

async function main() {
  console.log(SEPARATOR);
  console.log("  Hive Mainnet Burn-In");
  console.log(SEPARATOR);

  // ── Guard: must be real client ───────────────────────────────
  const hive = createHiveClient();
  if (hive instanceof MockHiveClient) {
    fail("INIT", "MockHiveClient active — set HIVE_USERNAME, HIVE_POSTING_KEY, HIVE_ACTIVE_KEY in env");
  }
  const client = hive as HiveClient;
  const username = process.env.HIVE_USERNAME!;
  log("INIT", `Real HiveClient created for @${username}`);

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Read-Only Smoke Tests
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${SEPARATOR}\n  Phase 1: Read-Only Smoke Tests\n${SEPARATOR}`);

  // 1a. getAccount
  try {
    const account = await client.getAccount(username);
    if (!account) fail("READ", `Account @${username} not found on chain`);
    log("READ", `getAccount OK`, { name: account.name, hbd: account.hbd_balance?.toString() });
  } catch (err) {
    fail("READ", "getAccount failed", err);
  }

  // 1b. getHBDBalance
  try {
    const balance = await client.getHBDBalance(username);
    log("READ", `getHBDBalance OK`, { balance });
    const hbd = parseFloat(balance);
    if (hbd < 0.01) {
      log("READ", `WARNING: Balance very low (${balance}). Transfer test needs >= 0.001 HBD.`);
    }
  } catch (err) {
    fail("READ", "getHBDBalance failed", err);
  }

  // 1c. getReputationScore
  try {
    const rep = await client.getReputationScore(username);
    log("READ", `getReputationScore OK`, { reputation: rep });
  } catch (err) {
    fail("READ", "getReputationScore failed", err);
  }

  // 1d. getTopWitnesses
  try {
    const witnesses = await client.getTopWitnesses(5);
    log("READ", `getTopWitnesses(5) OK`, { top5: witnesses });
  } catch (err) {
    fail("READ", "getTopWitnesses failed", err);
  }

  // 1e. getLatestBlockHash + getBlockchainTime
  try {
    const [hash, time] = await Promise.all([
      client.getLatestBlockHash(),
      client.getBlockchainTime(),
    ]);
    log("READ", `getLatestBlockHash OK`, { hash: hash.slice(0, 16) + "..." });
    log("READ", `getBlockchainTime OK`, { time: time.toISOString() });
  } catch (err) {
    fail("READ", "Block hash / time failed", err);
  }

  log("READ", "All read-only tests PASSED");

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: custom_json Broadcast
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${SEPARATOR}\n  Phase 2: custom_json Broadcast\n${SEPARATOR}`);

  let customJsonTxId: string;
  try {
    const tx = await client.broadcastCustomJsonWithReconciliation({
      id: "spk_poa_burnin",
      json: {
        type: "burn_in_test",
        validator: username,
        timestamp: new Date().toISOString(),
        version: "v1",
      },
    });
    customJsonTxId = tx.id;
    log("WRITE", `custom_json broadcast accepted`, { trxId: tx.id, blockNum: tx.blockNumber });
  } catch (err) {
    fail("WRITE", "custom_json broadcast failed", err);
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase 3: HBD Transfer (0.001 HBD self-transfer)
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${SEPARATOR}\n  Phase 3: HBD Transfer (0.001 HBD → self)\n${SEPARATOR}`);

  let transferTxId: string;
  try {
    const tx = await client.transferWithReconciliation({
      to: username, // Self-transfer — no HBD leaves the account
      amount: "0.001 HBD",
      memo: `hivepoa-burn-in-${Date.now()}`,
    });
    transferTxId = tx.id;
    log("WRITE", `HBD transfer broadcast accepted`, { trxId: tx.id, blockNum: tx.blockNumber });
  } catch (err) {
    fail("WRITE", "HBD transfer broadcast failed", err);
  }

  // ═══════════════════════════════════════════════════════════════
  // Phase 4: Reconciliation — confirm both txs
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${SEPARATOR}\n  Phase 4: Transaction Reconciliation\n${SEPARATOR}`);

  // 4a. Confirm custom_json
  log("CONFIRM", `Confirming custom_json tx ${customJsonTxId!.slice(0, 12)}...`);
  const cjResult = await client.confirmTransaction(customJsonTxId!, { maxAttempts: 15, intervalMs: 3000 });
  log("CONFIRM", `custom_json outcome: ${cjResult.outcome}`, { blockNum: cjResult.blockNum });
  if (cjResult.outcome !== "confirmed" && cjResult.outcome !== "included") {
    log("CONFIRM", `WARNING: custom_json did not reach irreversible. Outcome: ${cjResult.outcome}`);
  }

  // 4b. Confirm transfer
  log("CONFIRM", `Confirming transfer tx ${transferTxId!.slice(0, 12)}...`);
  const txResult = await client.confirmTransaction(transferTxId!, { maxAttempts: 15, intervalMs: 3000 });
  log("CONFIRM", `transfer outcome: ${txResult.outcome}`, { blockNum: txResult.blockNum });
  if (txResult.outcome !== "confirmed" && txResult.outcome !== "included") {
    log("CONFIRM", `WARNING: transfer did not reach irreversible. Outcome: ${txResult.outcome}`);
  }

  // 4c. Cross-check via verifyTransfer
  log("CONFIRM", `Cross-checking transfer via condenser_api.get_transaction...`);
  const verified = await client.verifyTransfer(transferTxId!);
  if (verified) {
    log("CONFIRM", `verifyTransfer OK`, verified);
  } else {
    log("CONFIRM", `verifyTransfer returned null — tx may still be propagating`);
  }

  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${SEPARATOR}\n  BURN-IN SUMMARY\n${SEPARATOR}`);
  console.log(`  Account:      @${username}`);
  console.log(`  custom_json:  ${customJsonTxId!} → ${cjResult.outcome}`);
  console.log(`  transfer:     ${transferTxId!} → ${txResult.outcome}`);
  console.log(`  verify:       ${verified ? "CONFIRMED" : "PENDING"}`);
  console.log(SEPARATOR);

  const allConfirmed = (cjResult.outcome === "confirmed" || cjResult.outcome === "included")
    && (txResult.outcome === "confirmed" || txResult.outcome === "included");

  if (allConfirmed) {
    console.log("  RESULT: ALL PASSED — ready to freeze v1 baseline");
  } else {
    console.log("  RESULT: PARTIAL — review warnings above before freezing");
  }
  console.log(SEPARATOR);
  process.exit(allConfirmed ? 0 : 1);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
