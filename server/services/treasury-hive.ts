/**
 * Treasury Hive Primitives — dhive multisig operations.
 *
 * Pure functions for building unsigned transactions, computing digests,
 * assembling signed transactions, broadcasting, and managing on-chain authority.
 * No state, no side effects beyond blockchain interaction.
 */

import {
  Client,
  PrivateKey,
  Asset,
  TransferOperation,
  cryptoUtils,
} from "@hiveio/dhive";
import { logHive } from "../logger";
import { TREASURY_ACCOUNT, THRESHOLD_RATIO, AUTHORITY_UPDATE_THRESHOLD_RATIO } from "../../shared/treasury-types";

// dhive types that may not have explicit exports — use structural typing
interface Transaction {
  ref_block_num: number;
  ref_block_prefix: number;
  expiration: string;
  operations: any[];
  extensions: any[];
}

interface SignedTransaction extends Transaction {
  signatures: string[];
}

interface Authority {
  weight_threshold: number;
  account_auths: [string, number][];
  key_auths: [string, number][];
}

// ============================================================
// Transaction Building
// ============================================================

/**
 * Build an unsigned Hive transaction from a set of operations.
 * Returns the transaction object and its digest (what signers sign).
 */
export async function buildUnsignedTransaction(
  client: Client,
  operations: any[],
): Promise<{ tx: Transaction; digest: Buffer }> {
  const props = await client.database.getDynamicGlobalProperties();

  const ref_block_num = props.head_block_number & 0xFFFF;
  const ref_block_prefix = Buffer.from(props.head_block_id, "hex").readUInt32LE(4);

  // Expire in 50 seconds (Hive max is ~60s; leave margin)
  const expiration = new Date(
    new Date(props.time + "Z").getTime() + 50_000,
  ).toISOString().slice(0, -5);

  const tx: Transaction = {
    ref_block_num,
    ref_block_prefix,
    expiration,
    operations,
    extensions: [],
  };

  // Compute the canonical digest that all signers must sign
  const digest = (cryptoUtils as any).transactionDigest(tx, (client as any).chainId);

  return { tx, digest };
}

/**
 * Assemble a signed transaction from an unsigned tx + collected signatures.
 */
export function assembleSignedTransaction(
  tx: Transaction,
  signatures: string[],
): SignedTransaction {
  return { ...tx, signatures };
}

/**
 * Broadcast a pre-signed multisig transaction to the Hive network.
 */
export async function broadcastMultisig(
  client: Client,
  signedTx: SignedTransaction,
): Promise<{ id: string; block_num: number }> {
  const result = await (client.broadcast as any).send(signedTx);
  logHive.info({ txId: result.id, block: result.block_num }, "Multisig tx broadcast");
  return result;
}

// ============================================================
// Transfer Operations
// ============================================================

/**
 * Build a transfer operation from the treasury account.
 */
export function buildTransferOp(
  to: string,
  amount: string,
  memo: string,
): TransferOperation {
  return [
    "transfer",
    {
      from: TREASURY_ACCOUNT,
      to,
      amount: Asset.fromString(amount).toString(),
      memo,
    },
  ];
}

// ============================================================
// Authority Management
// ============================================================

/**
 * Read the current active authority of the treasury account from the blockchain.
 */
export async function readOnChainAuthority(
  client: Client,
  account: string = TREASURY_ACCOUNT,
): Promise<Authority> {
  const [acc] = await client.database.getAccounts([account]);
  if (!acc) throw new Error(`Account @${account} not found on chain`);
  return acc.active as Authority;
}

/**
 * Build an account_update operation to set a new active authority on the treasury.
 * Reads current memo_key and json_metadata to preserve them.
 *
 * @param signerUsernames - Array of Hive usernames to include in the authority
 * @param threshold - Minimum weight required (ceil(N * 0.6))
 * @param currentMemoKey - Current memo key to preserve (from readOnChainAuthority)
 * @param currentJsonMetadata - Current json_metadata to preserve
 */
export function buildAuthorityUpdateOp(
  signerUsernames: string[],
  threshold: number,
  currentMemoKey?: string,
  currentJsonMetadata?: string,
): any[] {
  // Sort alphabetically for deterministic ordering (Hive requirement)
  const sorted = [...signerUsernames].sort();

  const newAuthority: Authority = {
    weight_threshold: threshold,
    account_auths: sorted.map((u) => [u, 1]),
    key_auths: [],
  };

  return [
    "account_update",
    {
      account: TREASURY_ACCOUNT,
      active: newAuthority,
      // Preserve existing memo key and metadata — omitting these would reset them
      memo_key: currentMemoKey || "STM1111111111111111111111111111111114T1Anm",
      json_metadata: currentJsonMetadata || "",
    },
  ];
}

/**
 * Read account info needed for building authority updates.
 */
export async function readAccountInfo(
  client: Client,
  account: string = TREASURY_ACCOUNT,
): Promise<{ memoKey: string; jsonMetadata: string }> {
  const [acc] = await client.database.getAccounts([account]);
  if (!acc) throw new Error(`Account @${account} not found on chain`);
  return {
    memoKey: (acc as any).memo_key || "STM1111111111111111111111111111111114T1Anm",
    jsonMetadata: (acc as any).json_metadata || "",
  };
}

/**
 * Compare on-chain authority with expected signer set.
 * Returns true if they match (in sync).
 */
export function authorityMatchesSigners(
  onChainAuth: Authority,
  expectedSigners: string[],
  expectedThreshold: number,
): boolean {
  if (onChainAuth.weight_threshold !== expectedThreshold) return false;

  const onChainAccounts = onChainAuth.account_auths
    .map(([name]) => name)
    .sort();
  const expected = [...expectedSigners].sort();

  if (onChainAccounts.length !== expected.length) return false;
  return onChainAccounts.every((name, i) => name === expected[i]);
}

/**
 * Compute the threshold for a given number of signers.
 * Transfers: 60% quorum. Authority updates: 80% quorum.
 */
export function computeThreshold(
  signerCount: number,
  txType: "transfer" | "authority_update" = "transfer",
): number {
  const ratio = txType === "authority_update" ? AUTHORITY_UPDATE_THRESHOLD_RATIO : THRESHOLD_RATIO;
  return Math.ceil(signerCount * ratio);
}

/**
 * Sign a transaction digest with a private key.
 * Used by the desktop agent signer.
 */
export function signDigest(digest: Buffer, activeKeyWif: string): string {
  const key = PrivateKey.fromString(activeKeyWif);
  const sig = key.sign(digest);
  return sig.toString();
}

/**
 * Get the HBD balance of the treasury account.
 */
export async function getTreasuryBalance(client: Client): Promise<string> {
  const [acc] = await client.database.getAccounts([TREASURY_ACCOUNT]);
  if (!acc) return "0.000 HBD";
  return (acc as any).hbd_balance || (acc as any).sbd_balance || "0.000 HBD";
}
