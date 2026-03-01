import { PubSubBridge } from './pubsub';
import { ConfigStore } from './config';
import { AgentHiveClient } from './hive';
import { computeProofHash, getBlockCids, computeBlockListHash, isValidCid } from './poa-crypto';

export interface ChallengeMessage {
  type: 'challenge';
  targetPeer: string;      // Hive username of target
  validatorPeer: string;   // Hive username of validator
  cid: string;
  salt: string;
  blockHash: string;       // First 16 chars of Hive block hash (for verification)
  timestamp: number;
  nonce: string;            // Random nonce to prevent replay
}

export interface ChallengeResponse {
  type: 'response';
  targetPeer: string;
  validatorPeer: string;
  cid: string;
  salt: string;
  proofHash: string;
  elapsed: number;
  status: 'success' | 'fail';
  error?: string;
  nonce: string;           // Must match challenge nonce
}

/** Protocol v2: Two-phase commitment — proves data is stored locally (not fetched on-demand). */
export interface CommitmentRequest {
  type: 'commitment-request';
  targetPeer: string;
  validatorPeer: string;
  cid: string;
  timestamp: number;
  nonce: string;
  protocolVersion: 2;
}

export interface CommitmentResponse {
  type: 'commitment-response';
  targetPeer: string;
  validatorPeer: string;
  cid: string;
  blockCount: number;
  blockListHash: string;
  elapsed: number;
  status: 'success' | 'fail';
  error?: string;
  nonce: string;
  protocolVersion: 2;
}

const CHALLENGE_TOPIC = 'hivepoa-challenges';
const CHALLENGE_TIMEOUT = 24000; // 24s (1s buffer for 25s server-side limit)
const COMMITMENT_TIMEOUT = 1800; // 1.8s (200ms buffer for 2s validator-side limit)
const MAX_CONCURRENT = 5;
const MAX_PER_VALIDATOR_PER_30S = 1;

/**
 * Handles incoming challenges from other validators via IPFS PubSub.
 * Computes proof and publishes response.
 */
export class ChallengeHandler {
  private kuboApiUrl: string;
  private pubsub: PubSubBridge;
  private myUsername: string;
  private config: ConfigStore;
  private hive: AgentHiveClient;
  private activeChallenges = 0;
  private seenNonces: Map<string, number> = new Map(); // nonce → timestamp
  private validatorTimestamps: Map<string, number> = new Map(); // validator → last challenge timestamp
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(kuboApiUrl: string, pubsub: PubSubBridge, myUsername: string, config: ConfigStore, hive: AgentHiveClient) {
    this.kuboApiUrl = kuboApiUrl;
    this.pubsub = pubsub;
    this.myUsername = myUsername;
    this.config = config;
    this.hive = hive;

    // Clean up old nonces and timestamps every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  /** Handle an incoming challenge from PubSub. */
  async handleChallenge(challenge: ChallengeMessage): Promise<void> {
    // Validation checks
    if (!this.validateChallenge(challenge)) return;

    // Rate limiting
    if (this.activeChallenges >= MAX_CONCURRENT) {
      console.log(`[ChallengeHandler] Dropping challenge from ${challenge.validatorPeer} — at capacity`);
      return;
    }

    // Check per-validator rate limit
    const lastFromValidator = this.validatorTimestamps.get(challenge.validatorPeer) || 0;
    if (Date.now() - lastFromValidator < 30000) {
      console.log(`[ChallengeHandler] Rate limited: ${challenge.validatorPeer} challenged too recently`);
      return;
    }

    this.validatorTimestamps.set(challenge.validatorPeer, Date.now());
    this.seenNonces.set(challenge.nonce, Date.now());
    this.activeChallenges++;

    const startTime = Date.now();

    try {
      // Race proof computation against timeout
      const proofPromise = (async () => {
        const blockCids = await getBlockCids(this.kuboApiUrl, challenge.cid);
        return await computeProofHash(this.kuboApiUrl, challenge.salt, challenge.cid, blockCids);
      })();

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('PROOF_TIMEOUT')), CHALLENGE_TIMEOUT);
      });

      const proofHash = await Promise.race([proofPromise, timeoutPromise]);
      const elapsed = Date.now() - startTime;

      console.log(`[ChallengeHandler] Proof computed in ${elapsed}ms for ${challenge.cid.slice(0, 12)}...`);

      // Send response via PubSub
      const response: ChallengeResponse = {
        type: 'response',
        targetPeer: this.myUsername,
        validatorPeer: challenge.validatorPeer,
        cid: challenge.cid,
        salt: challenge.salt,
        proofHash,
        elapsed,
        status: 'success',
        nonce: challenge.nonce,
      };

      const signer = (payload: string) => this.hive.signMessage(payload);
      await this.pubsub.publish(CHALLENGE_TOPIC, response, signer);
      this.config.recordChallenge(true, 0.001);

    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      console.error(`[ChallengeHandler] Challenge failed: ${err.message}`);

      const response: ChallengeResponse = {
        type: 'response',
        targetPeer: this.myUsername,
        validatorPeer: challenge.validatorPeer,
        cid: challenge.cid,
        salt: challenge.salt,
        proofHash: '',
        elapsed,
        status: 'fail',
        error: err.message,
        nonce: challenge.nonce,
      };

      const signer = (payload: string) => this.hive.signMessage(payload);
      await this.pubsub.publish(CHALLENGE_TOPIC, response, signer);
      this.config.recordChallenge(false, 0);
    } finally {
      this.activeChallenges = Math.max(0, this.activeChallenges - 1);
    }
  }

  /** Validate an incoming challenge message. */
  private validateChallenge(challenge: ChallengeMessage & { __signature?: string; __signerUsername?: string }): boolean {
    // Must be addressed to us
    if (challenge.targetPeer !== this.myUsername) return false;

    // SECURITY: Reduced timestamp window from 60s to 30s
    if (Math.abs(Date.now() - challenge.timestamp) > 30000) {
      console.log(`[ChallengeHandler] Stale challenge from ${challenge.validatorPeer}`);
      return false;
    }

    // Nonce must not have been seen before (replay protection)
    if (this.seenNonces.has(challenge.nonce)) {
      console.log(`[ChallengeHandler] Replay detected from ${challenge.validatorPeer}`);
      return false;
    }

    // Must have required fields with valid formats
    if (!challenge.cid || !challenge.salt || !challenge.validatorPeer) {
      return false;
    }

    // Validate CID format to prevent injection
    if (!isValidCid(challenge.cid)) {
      console.log(`[ChallengeHandler] Invalid CID format from ${challenge.validatorPeer}`);
      return false;
    }

    // SECURITY: Verify PubSub message signature if present
    // During rollout, unsigned messages are accepted with a warning (backward compatibility)
    if (challenge.__signature && challenge.__signerUsername) {
      // Async verification — but validateChallenge is sync, so log for now
      // Full async verification will be added in protocol v2
      console.log(`[ChallengeHandler] Signed challenge from ${challenge.validatorPeer}`);
    } else {
      console.log(`[ChallengeHandler] Unsigned challenge from ${challenge.validatorPeer} (legacy)`);
    }

    return true;
  }

  /** Handle a protocol v2 commitment request — prove data is stored locally. */
  async handleCommitmentRequest(request: CommitmentRequest): Promise<void> {
    // Basic validation (reuse same checks as challenges)
    if (request.targetPeer !== this.myUsername) return;
    if (Math.abs(Date.now() - request.timestamp) > 30000) return;
    if (this.seenNonces.has(request.nonce)) return;
    if (!request.cid || !isValidCid(request.cid)) return;

    if (this.activeChallenges >= MAX_CONCURRENT) return;

    this.seenNonces.set(request.nonce, Date.now());
    this.activeChallenges++;

    const startTime = Date.now();

    try {
      // Race commitment computation against tight timeout
      const commitPromise = computeBlockListHash(this.kuboApiUrl, request.cid);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('COMMITMENT_TIMEOUT')), COMMITMENT_TIMEOUT);
      });

      const result = await Promise.race([commitPromise, timeoutPromise]);
      const elapsed = Date.now() - startTime;

      console.log(`[ChallengeHandler] Commitment computed in ${elapsed}ms for ${request.cid.slice(0, 12)}...`);

      const response: CommitmentResponse = {
        type: 'commitment-response',
        targetPeer: this.myUsername,
        validatorPeer: request.validatorPeer,
        cid: request.cid,
        blockCount: result.blockCount,
        blockListHash: result.blockListHash,
        elapsed,
        status: 'success',
        nonce: request.nonce,
        protocolVersion: 2,
      };

      const signer = (payload: string) => this.hive.signMessage(payload);
      await this.pubsub.publish(CHALLENGE_TOPIC, response, signer);
    } catch (err: any) {
      const elapsed = Date.now() - startTime;
      console.error(`[ChallengeHandler] Commitment failed: ${err.message}`);

      const response: CommitmentResponse = {
        type: 'commitment-response',
        targetPeer: this.myUsername,
        validatorPeer: request.validatorPeer,
        cid: request.cid,
        blockCount: 0,
        blockListHash: '',
        elapsed,
        status: 'fail',
        error: err.message,
        nonce: request.nonce,
        protocolVersion: 2,
      };

      const signer = (payload: string) => this.hive.signMessage(payload);
      await this.pubsub.publish(CHALLENGE_TOPIC, response, signer);
    } finally {
      this.activeChallenges = Math.max(0, this.activeChallenges - 1);
    }
  }

  /** Check if handler has capacity for more challenges. */
  hasCapacity(): boolean {
    return this.activeChallenges < MAX_CONCURRENT;
  }

  /** Get active challenge count. */
  getActiveChallengeCount(): number {
    return this.activeChallenges;
  }

  /** Clean up old nonces and rate limit timestamps. */
  private cleanup(): void {
    const cutoff = Date.now() - 60000; // 60s retention (matches cleanup interval)
    for (const [nonce, ts] of this.seenNonces) {
      if (ts < cutoff) this.seenNonces.delete(nonce);
    }
    for (const [validator, ts] of this.validatorTimestamps) {
      if (ts < cutoff) this.validatorTimestamps.delete(validator);
    }
  }

  /** Stop the handler. */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
