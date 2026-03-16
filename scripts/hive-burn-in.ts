/**
 * Hive Mainnet Burn-In Script — Production Validation
 *
 * Exercises the full read → write → confirm → verify path against real Hive mainnet.
 * Requires HIVE_USERNAME, HIVE_POSTING_KEY, HIVE_ACTIVE_KEY in env.
 *
 * Usage:
 *   npx tsx scripts/hive-burn-in.ts              # 5 cycles (default)
 *   npx tsx scripts/hive-burn-in.ts --cycles=10   # 10 cycles
 *
 * Per cycle:
 *   Phase 1 — Read-only smoke tests (getAccount, witnesses, block hash, balance)
 *   Phase 2 — Write: broadcast one custom_json, confirm inclusion
 *   Phase 3 — Write: broadcast one tiny HBD self-transfer (0.001 HBD), confirm inclusion
 *   Phase 4 — Ledger invariant verification (sender=receiver, amount, memo, no duplicates)
 *
 * Evidence is saved to scripts/burn-in-evidence.json after all cycles.
 */

import { createHiveClient, HiveClient, MockHiveClient } from "../server/services/hive-client";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const SEPARATOR = "─".repeat(60);
const TRANSFER_AMOUNT = "0.001 HBD";

interface CycleEvidence {
  cycle: number;
  startedAt: string;
  completedAt: string;
  readSmoke: {
    account: string;
    hbdBalance: string;
    reputation: number;
    topWitnesses: string[];
    blockHash: string;
    blockchainTime: string;
  };
  customJson: {
    trxId: string;
    blockNum: number;
    outcome: string;
    confirmBlockNum?: number;
  };
  transfer: {
    trxId: string;
    blockNum: number;
    outcome: string;
    confirmBlockNum?: number;
  };
  ledgerVerification: {
    verified: boolean;
    from: string | null;
    to: string | null;
    amount: string | null;
    memo: string | null;
    senderEqualsReceiver: boolean;
    amountExact: boolean;
    memoMatches: boolean;
  };
  preBalance: string;
  postBalance: string;
  balanceDelta: string;
  result: "PASS" | "FAIL";
  failReason?: string;
}

interface BurnInEvidence {
  version: string;
  commitSha: string;
  account: string;
  nodeList: string[];
  totalCycles: number;
  passedCycles: number;
  failedCycles: number;
  startedAt: string;
  completedAt: string;
  duplicateTransferCheck: {
    allTrxIds: string[];
    hasDuplicates: boolean;
  };
  cycles: CycleEvidence[];
}

function log(phase: string, msg: string, data?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${ts}] [${phase}] ${msg}${suffix}`);
}

function getCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function parseArgs(): { cycles: number } {
  const cycleArg = process.argv.find(a => a.startsWith("--cycles="));
  return { cycles: cycleArg ? parseInt(cycleArg.split("=")[1], 10) || 5 : 5 };
}

async function runCycle(
  client: HiveClient,
  username: string,
  cycleNum: number,
  totalCycles: number,
): Promise<CycleEvidence> {
  const evidence: Partial<CycleEvidence> = {
    cycle: cycleNum,
    startedAt: new Date().toISOString(),
    result: "FAIL",
  };

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  CYCLE ${cycleNum}/${totalCycles}`);
  console.log(`${"═".repeat(60)}`);

  // ── Phase 1: Read-Only Smoke ────────────────────────────────
  console.log(`\n${SEPARATOR}\n  Phase 1: Read-Only Smoke Tests\n${SEPARATOR}`);

  let preBalance: string;
  try {
    const account = await client.getAccount(username);
    if (!account) { evidence.failReason = "Account not found"; return evidence as CycleEvidence; }

    preBalance = account.hbd_balance?.toString() || "0.000 HBD";
    const rep = await client.getReputationScore(username);
    const witnesses = await client.getTopWitnesses(5);
    const [hash, time] = await Promise.all([
      client.getLatestBlockHash(),
      client.getBlockchainTime(),
    ]);

    evidence.readSmoke = {
      account: account.name,
      hbdBalance: preBalance,
      reputation: rep,
      topWitnesses: witnesses,
      blockHash: hash,
      blockchainTime: time.toISOString(),
    };
    evidence.preBalance = preBalance;

    log("READ", "All reads OK", { balance: preBalance, rep, blockHash: hash.slice(0, 16) + "..." });
  } catch (err: any) {
    evidence.failReason = `Read smoke failed: ${err.message}`;
    log("READ", `FAIL: ${err.message}`);
    return evidence as CycleEvidence;
  }

  // ── Phase 2: custom_json Broadcast ──────────────────────────
  console.log(`\n${SEPARATOR}\n  Phase 2: custom_json Broadcast\n${SEPARATOR}`);

  let customJsonTxId: string;
  let customJsonBlockNum: number;
  try {
    const tx = await client.broadcastCustomJsonWithReconciliation({
      id: "spk_poa_burnin",
      json: {
        type: "burn_in_test",
        validator: username,
        cycle: cycleNum,
        timestamp: new Date().toISOString(),
        version: "v1",
      },
    });
    customJsonTxId = tx.id;
    customJsonBlockNum = tx.blockNumber;
    log("WRITE", `custom_json accepted`, { trxId: tx.id, blockNum: tx.blockNumber });
  } catch (err: any) {
    evidence.failReason = `custom_json broadcast failed: ${err.message}`;
    log("WRITE", `FAIL: ${err.message}`);
    return evidence as CycleEvidence;
  }

  // ── Phase 3: HBD Self-Transfer ──────────────────────────────
  console.log(`\n${SEPARATOR}\n  Phase 3: HBD Transfer (${TRANSFER_AMOUNT} → self)\n${SEPARATOR}`);

  const memo = `hivepoa-burnin-c${cycleNum}-${Date.now()}`;
  let transferTxId: string;
  let transferBlockNum: number;
  try {
    const tx = await client.transferWithReconciliation({
      to: username,
      amount: TRANSFER_AMOUNT,
      memo,
    });
    transferTxId = tx.id;
    transferBlockNum = tx.blockNumber;
    log("WRITE", `Transfer accepted`, { trxId: tx.id, blockNum: tx.blockNumber });
  } catch (err: any) {
    evidence.failReason = `Transfer broadcast failed: ${err.message}`;
    log("WRITE", `FAIL: ${err.message}`);
    return evidence as CycleEvidence;
  }

  // ── Reconciliation: confirm both to irreversible ────────────
  console.log(`\n${SEPARATOR}\n  Reconciliation\n${SEPARATOR}`);

  log("CONFIRM", `Confirming custom_json ${customJsonTxId.slice(0, 12)}...`);
  const cjResult = await client.confirmTransaction(customJsonTxId, { maxAttempts: 20, intervalMs: 3000 });
  log("CONFIRM", `custom_json: ${cjResult.outcome}`, { blockNum: cjResult.blockNum });

  evidence.customJson = {
    trxId: customJsonTxId,
    blockNum: customJsonBlockNum,
    outcome: cjResult.outcome,
    confirmBlockNum: cjResult.blockNum,
  };

  log("CONFIRM", `Confirming transfer ${transferTxId.slice(0, 12)}...`);
  const txResult = await client.confirmTransaction(transferTxId, { maxAttempts: 20, intervalMs: 3000 });
  log("CONFIRM", `transfer: ${txResult.outcome}`, { blockNum: txResult.blockNum });

  evidence.transfer = {
    trxId: transferTxId,
    blockNum: transferBlockNum,
    outcome: txResult.outcome,
    confirmBlockNum: txResult.blockNum,
  };

  // ── Phase 4: Ledger Invariant Verification ──────────────────
  console.log(`\n${SEPARATOR}\n  Phase 4: Ledger Invariant Verification\n${SEPARATOR}`);

  const verified = await client.verifyTransfer(transferTxId);
  const senderEqualsReceiver = verified?.from === username && verified?.to === username;
  const amountExact = verified?.amount === TRANSFER_AMOUNT;
  const memoMatches = verified?.memo === memo;

  evidence.ledgerVerification = {
    verified: !!verified,
    from: verified?.from || null,
    to: verified?.to || null,
    amount: verified?.amount || null,
    memo: verified?.memo || null,
    senderEqualsReceiver,
    amountExact,
    memoMatches,
  };

  if (verified) {
    log("VERIFY", `from=${verified.from}, to=${verified.to}, amount=${verified.amount}`);
    log("VERIFY", `sender=receiver: ${senderEqualsReceiver ? "OK" : "FAIL"}`);
    log("VERIFY", `amount exact: ${amountExact ? "OK" : "FAIL"}`);
    log("VERIFY", `memo matches: ${memoMatches ? "OK" : "FAIL"}`);
  } else {
    log("VERIFY", "verifyTransfer returned null — tx may still be propagating");
  }

  // Post-balance check
  try {
    const postBalance = await client.getHBDBalance(username);
    evidence.postBalance = postBalance;
    const pre = parseFloat(evidence.preBalance);
    const post = parseFloat(postBalance);
    const delta = post - pre;
    evidence.balanceDelta = delta.toFixed(3) + " HBD";
    // Self-transfer: delta should be 0 (money stays in account)
    log("VERIFY", `Balance: ${evidence.preBalance} → ${postBalance} (delta: ${evidence.balanceDelta})`);
    if (Math.abs(delta) > 0.0005) {
      log("VERIFY", `WARNING: Non-zero balance delta on self-transfer`);
    }
  } catch {
    evidence.postBalance = "unknown";
    evidence.balanceDelta = "unknown";
  }

  // ── Final classification ────────────────────────────────────
  const writeOk = (cjResult.outcome === "confirmed" || cjResult.outcome === "included")
    && (txResult.outcome === "confirmed" || txResult.outcome === "included");
  const ledgerOk = senderEqualsReceiver && amountExact && memoMatches;
  const passed = writeOk && ledgerOk;

  evidence.result = passed ? "PASS" : "FAIL";
  if (!passed && !evidence.failReason) {
    const reasons: string[] = [];
    if (!writeOk) reasons.push(`tx outcomes: cj=${cjResult.outcome}, xfer=${txResult.outcome}`);
    if (!ledgerOk) reasons.push(`ledger: sender=recv=${senderEqualsReceiver}, amt=${amountExact}, memo=${memoMatches}`);
    evidence.failReason = reasons.join("; ");
  }

  evidence.completedAt = new Date().toISOString();

  console.log(`\n  Cycle ${cycleNum}: ${evidence.result}${evidence.failReason ? " — " + evidence.failReason : ""}`);

  return evidence as CycleEvidence;
}

async function main() {
  const { cycles: totalCycles } = parseArgs();
  const commitSha = getCommitSha();
  const nodeList = [
    "https://api.hive.blog",
    "https://api.openhive.network",
    "https://anyx.io",
    "https://hived.emre.sh",
  ];

  console.log(SEPARATOR);
  console.log("  Hive Mainnet Burn-In — Production Validation");
  console.log(`  Cycles: ${totalCycles} | Commit: ${commitSha.slice(0, 12)}`);
  console.log(SEPARATOR);

  // Guard: must be real client
  const hive = createHiveClient();
  if (hive instanceof MockHiveClient) {
    log("INIT", "FAIL: MockHiveClient active — set HIVE_USERNAME, HIVE_POSTING_KEY, HIVE_ACTIVE_KEY");
    process.exit(1);
  }
  const client = hive as HiveClient;
  const username = process.env.HIVE_USERNAME!;
  log("INIT", `Real HiveClient for @${username}`);

  const evidence: BurnInEvidence = {
    version: "v1",
    commitSha,
    account: username,
    nodeList,
    totalCycles,
    passedCycles: 0,
    failedCycles: 0,
    startedAt: new Date().toISOString(),
    completedAt: "",
    duplicateTransferCheck: { allTrxIds: [], hasDuplicates: false },
    cycles: [],
  };

  // Run cycles
  for (let i = 1; i <= totalCycles; i++) {
    const cycleResult = await runCycle(client, username, i, totalCycles);
    evidence.cycles.push(cycleResult);
    if (cycleResult.result === "PASS") evidence.passedCycles++;
    else evidence.failedCycles++;

    // Collect all transfer trx_ids for duplicate check
    if (cycleResult.transfer?.trxId) {
      evidence.duplicateTransferCheck.allTrxIds.push(cycleResult.transfer.trxId);
    }

    // Brief pause between cycles (let Hive breathe)
    if (i < totalCycles) {
      log("WAIT", `Pausing 5s before cycle ${i + 1}...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Duplicate transfer check
  const trxIds = evidence.duplicateTransferCheck.allTrxIds;
  const uniqueIds = new Set(trxIds);
  evidence.duplicateTransferCheck.hasDuplicates = uniqueIds.size !== trxIds.length;

  evidence.completedAt = new Date().toISOString();

  // ── Save Evidence ───────────────────────────────────────────
  const evidencePath = path.join(__dirname, "burn-in-evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  log("SAVE", `Evidence saved to ${evidencePath}`);

  // ── Final Summary ──────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("  BURN-IN FINAL SUMMARY");
  console.log(`${"═".repeat(60)}`);
  console.log(`  Account:      @${username}`);
  console.log(`  Commit:       ${commitSha}`);
  console.log(`  Cycles:       ${evidence.passedCycles}/${totalCycles} passed`);
  console.log(`  Duplicates:   ${evidence.duplicateTransferCheck.hasDuplicates ? "YES — PROBLEM" : "none"}`);

  for (const c of evidence.cycles) {
    const cjId = c.customJson?.trxId?.slice(0, 12) || "n/a";
    const xfId = c.transfer?.trxId?.slice(0, 12) || "n/a";
    console.log(`  Cycle ${c.cycle}: ${c.result} | cj=${cjId}…→${c.customJson?.outcome || "?"} | xf=${xfId}…→${c.transfer?.outcome || "?"}`);
  }

  console.log(`${"═".repeat(60)}`);

  const allPassed = evidence.failedCycles === 0 && !evidence.duplicateTransferCheck.hasDuplicates;
  if (allPassed) {
    console.log("  RESULT: ALL CYCLES PASSED — safe to freeze v1 baseline");
    console.log(`  Next: git tag v1.0.0 && git push origin v1.0.0`);
  } else {
    console.log("  RESULT: FAILURES DETECTED — review evidence before proceeding");
  }
  console.log(`${"═".repeat(60)}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
