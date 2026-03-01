import * as crypto from 'crypto';
import axios from 'axios';
import { AgentHiveClient } from './hive';
import { PeerDiscovery, PeerInfo } from './peer-discovery';
import { PubSubBridge } from './pubsub';
import { ChallengeMessage, ChallengeResponse, CommitmentRequest, CommitmentResponse } from './challenge-handler';
import { createSaltWithEntropy, verifyProof, computeBlockListHash } from './poa-crypto';

const CHALLENGE_TOPIC = 'hivepoa-challenges';
const CHALLENGE_TIMEOUT_MS = 25000; // 25 second anti-cheat window
const COMMITMENT_TIMEOUT_MS = 2000; // 2 second commitment window (proves local storage)

export interface ValidatorStats {
  issued: number;
  passed: number;
  failed: number;
  timeouts: number;
}

interface PendingChallenge {
  resolve: (response: ChallengeResponse) => void;
  timeout: NodeJS.Timeout;
  startTime: number;
}

interface PendingCommitment {
  resolve: (response: CommitmentResponse) => void;
  timeout: NodeJS.Timeout;
  startTime: number;
}

/**
 * Local PoA validation engine.
 * Periodically challenges random peers and verifies their storage proofs.
 * Results are broadcast to Hive blockchain as custom_json.
 */
export class LocalValidator {
  private hive: AgentHiveClient;
  private peerDiscovery: PeerDiscovery;
  private pubsub: PubSubBridge;
  private kuboApiUrl: string;
  private myUsername: string;
  private challengeIntervalMs: number;
  private broadcastResults: boolean;
  private requireSignedMessages: boolean;

  private challengeTimer: NodeJS.Timeout | null = null;
  private blockHashTimer: NodeJS.Timeout | null = null;
  private currentBlockHash: string = '';
  private pendingChallenges: Map<string, PendingChallenge> = new Map(); // nonce → pending
  private pendingCommitments: Map<string, PendingCommitment> = new Map(); // nonce → pending
  private cachedPins: string[] = [];
  private pinsCacheTime: number = 0;
  private static readonly PIN_CACHE_TTL_MS = 300000; // 5 minutes

  private stats: ValidatorStats = {
    issued: 0,
    passed: 0,
    failed: 0,
    timeouts: 0,
  };

  constructor(
    hive: AgentHiveClient,
    peerDiscovery: PeerDiscovery,
    pubsub: PubSubBridge,
    kuboApiUrl: string,
    myUsername: string,
    challengeIntervalMs: number = 7200000, // 2 hours (was 5 min)
    broadcastResults: boolean = true,
    requireSignedMessages: boolean = false
  ) {
    this.hive = hive;
    this.peerDiscovery = peerDiscovery;
    this.pubsub = pubsub;
    this.kuboApiUrl = kuboApiUrl;
    this.myUsername = myUsername;
    this.challengeIntervalMs = challengeIntervalMs;
    this.broadcastResults = broadcastResults;
    this.requireSignedMessages = requireSignedMessages;
  }

  /** Start the validator engine. */
  async start(): Promise<void> {
    console.log(`[Validator] Starting (interval: ${this.challengeIntervalMs / 1000}s)`);

    // Get initial block hash
    await this.updateBlockHash();

    // Refresh block hash every 5 minutes (challenges are 2h apart, no need to refresh often)
    this.blockHashTimer = setInterval(() => this.updateBlockHash(), 300000);

    // Run first challenge after a short delay (let peer discovery populate)
    setTimeout(() => this.runChallengeRound(), 15000);

    // Run challenge rounds with jitter (±20% of interval) to prevent synchronized behavior
    this.scheduleNextChallenge();
  }

  /** Schedule next challenge round with random jitter. */
  private scheduleNextChallenge(): void {
    const jitter = Math.floor(this.challengeIntervalMs * 0.2 * (Math.random() * 2 - 1));
    const interval = this.challengeIntervalMs + jitter;

    this.challengeTimer = setTimeout(() => {
      this.runChallengeRound().finally(() => this.scheduleNextChallenge());
    }, interval);
  }

  /** Stop the validator engine. */
  stop(): void {
    if (this.challengeTimer) {
      clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
    }
    if (this.blockHashTimer) {
      clearInterval(this.blockHashTimer);
      this.blockHashTimer = null;
    }

    // Clear pending challenges and commitments
    for (const [nonce, pending] of this.pendingChallenges) {
      clearTimeout(pending.timeout);
    }
    this.pendingChallenges.clear();
    for (const [nonce, pending] of this.pendingCommitments) {
      clearTimeout(pending.timeout);
    }
    this.pendingCommitments.clear();

    console.log('[Validator] Stopped');
  }

  /** Run a single challenge round — select a peer and challenge them. */
  private async runChallengeRound(): Promise<void> {
    const peer = this.peerDiscovery.selectRandomPeer();
    if (!peer) {
      // No eligible peers — normal when network is small
      return;
    }

    try {
      await this.challengePeer(peer);
    } catch (err: any) {
      console.error(`[Validator] Challenge round error:`, err.message);
    }
  }

  /**
   * Issue a two-phase challenge to a specific peer (protocol v2).
   *
   * Phase 1 (Commitment, 2s): Send CID only — peer must respond with block count
   * and block list hash. This proves data is stored locally (fetching from IPFS
   * network would take seconds, not milliseconds).
   *
   * Phase 2 (Challenge, 25s): Send salt — peer computes full proof hash.
   * Validator verifies both the commitment and the proof independently.
   *
   * Backward compat: If commitment times out (peer runs old agent), falls back
   * to single-phase v1 challenge automatically.
   */
  private async challengePeer(peer: PeerInfo): Promise<void> {
    // Select a CID to challenge from our own pin list (we need the data to verify)
    const cid = await this.selectChallengeCid();
    if (!cid) {
      console.log('[Validator] No CIDs available to challenge');
      return;
    }

    this.stats.issued++;
    const signer = (payload: string) => this.hive.signMessage(payload);

    // ── Phase 1: Commitment ──────────────────────────────────────────────
    const commitNonce = crypto.randomBytes(16).toString('hex');

    const commitRequest: CommitmentRequest = {
      type: 'commitment-request',
      targetPeer: peer.hiveUsername,
      validatorPeer: this.myUsername,
      cid,
      timestamp: Date.now(),
      nonce: commitNonce,
      protocolVersion: 2,
    };

    console.log(`[Validator] Phase 1: Commitment request to ${peer.hiveUsername} for CID ${cid.slice(0, 12)}...`);

    // Set up commitment response handler
    const commitPromise = new Promise<CommitmentResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingCommitments.delete(commitNonce);
        resolve(null); // Timeout → fall back to v1
      }, COMMITMENT_TIMEOUT_MS);

      this.pendingCommitments.set(commitNonce, {
        resolve,
        timeout,
        startTime: Date.now(),
      });
    });

    const commitPublished = await this.pubsub.publish(CHALLENGE_TOPIC, commitRequest, signer);
    if (!commitPublished) {
      this.pendingCommitments.delete(commitNonce);
      console.error('[Validator] Failed to publish commitment request');
      return;
    }

    const commitResponse = await commitPromise;

    // Verify commitment if received
    let commitmentVerified = false;
    if (commitResponse && commitResponse.status === 'success') {
      // Independently compute our own block list hash to compare
      try {
        const ourCommitment = await computeBlockListHash(this.kuboApiUrl, cid);
        if (commitResponse.blockListHash === ourCommitment.blockListHash &&
            commitResponse.blockCount === ourCommitment.blockCount) {
          commitmentVerified = true;
          console.log(`[Validator] Phase 1 PASSED: ${peer.hiveUsername} commitment verified (${commitResponse.elapsed}ms)`);
        } else {
          // Block list mismatch — peer has different/corrupted data
          this.stats.failed++;
          this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
          console.log(`[Validator] Phase 1 FAILED: ${peer.hiveUsername} commitment mismatch (blocks: ${commitResponse.blockCount} vs ${ourCommitment.blockCount})`);
          await this.recordResult(peer, cid, false, '', commitResponse.elapsed);
          return;
        }
      } catch (err: any) {
        // Can't verify commitment (our IPFS issue) — proceed to phase 2 anyway
        console.log(`[Validator] Phase 1: Can't verify commitment locally, proceeding to phase 2`);
      }
    } else if (commitResponse && commitResponse.status === 'fail') {
      this.stats.failed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] Phase 1 FAILED: ${peer.hiveUsername} reported error: ${commitResponse.error}`);
      await this.recordResult(peer, cid, false, '', commitResponse.elapsed);
      return;
    } else {
      // Commitment timeout — peer may be running old agent, fall back to v1
      console.log(`[Validator] Phase 1: ${peer.hiveUsername} did not respond (v1 fallback)`);
    }

    // ── Phase 2: Challenge (same as v1) ─────────────────────────────────
    const salt = createSaltWithEntropy(this.currentBlockHash);
    const challengeNonce = crypto.randomBytes(16).toString('hex');

    const challenge: ChallengeMessage = {
      type: 'challenge',
      targetPeer: peer.hiveUsername,
      validatorPeer: this.myUsername,
      cid,
      salt,
      blockHash: this.currentBlockHash.slice(0, 16),
      timestamp: Date.now(),
      nonce: challengeNonce,
    };

    console.log(`[Validator] Phase 2: Challenge to ${peer.hiveUsername} for CID ${cid.slice(0, 12)}...`);

    // Set up response handler with timeout
    const responsePromise = new Promise<ChallengeResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingChallenges.delete(challengeNonce);
        resolve(null); // Timeout
      }, CHALLENGE_TIMEOUT_MS);

      this.pendingChallenges.set(challengeNonce, {
        resolve,
        timeout,
        startTime: Date.now(),
      });
    });

    const published = await this.pubsub.publish(CHALLENGE_TOPIC, challenge, signer);
    if (!published) {
      this.pendingChallenges.delete(challengeNonce);
      console.error('[Validator] Failed to publish challenge');
      return;
    }

    // Wait for response
    const response = await responsePromise;

    if (!response) {
      this.stats.timeouts++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] Phase 2: Challenge to ${peer.hiveUsername} timed out`);
      return;
    }

    // Verify the proof independently
    const pending = this.pendingChallenges.get(challengeNonce);
    const serverElapsed = Date.now() - (pending?.startTime || Date.now());

    // Anti-cheat: check elapsed time (our measurement, not theirs)
    if (serverElapsed >= CHALLENGE_TIMEOUT_MS) {
      this.stats.failed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] ${peer.hiveUsername} too slow (${serverElapsed}ms)`);
      await this.recordResult(peer, cid, false, '', serverElapsed);
      return;
    }

    if (response.status === 'fail') {
      this.stats.failed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] Phase 2: ${peer.hiveUsername} reported failure: ${response.error}`);
      await this.recordResult(peer, cid, false, '', serverElapsed);
      return;
    }

    // Independently verify the proof hash
    const verification = await verifyProof(this.kuboApiUrl, salt, cid, response.proofHash);

    if (verification.valid) {
      this.stats.passed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, true);
      const phase = commitmentVerified ? 'v2' : 'v1-fallback';
      console.log(`[Validator] ${peer.hiveUsername} PASSED [${phase}] (${serverElapsed}ms)`);
      await this.recordResult(peer, cid, true, response.proofHash, serverElapsed);
    } else {
      this.stats.failed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] ${peer.hiveUsername} FAILED — proof mismatch`);
      await this.recordResult(peer, cid, false, response.proofHash, serverElapsed);
    }
  }

  /** Handle an incoming commitment response (protocol v2 phase 1). */
  handleCommitmentResponse(response: CommitmentResponse & { __signature?: string; __signerUsername?: string }): void {
    if (response.validatorPeer !== this.myUsername) return;

    const pending = this.pendingCommitments.get(response.nonce);
    if (!pending) return;

    // SECURITY: Verify signature on commitment responses
    if (response.__signature && response.__signerUsername) {
      if (response.__signerUsername !== response.targetPeer) {
        console.log(`[Validator] Commitment signature mismatch: signer=${response.__signerUsername} != peer=${response.targetPeer}`);
        return; // Discard spoofed response
      }
      console.log(`[Validator] Signed commitment response from ${response.targetPeer}`);
    } else if (this.requireSignedMessages) {
      console.log(`[Validator] Rejected unsigned commitment from ${response.targetPeer} (enforcement enabled)`);
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingCommitments.delete(response.nonce);
    pending.resolve(response);
  }

  /** Handle an incoming challenge response from PubSub. */
  handleChallengeResponse(response: ChallengeResponse & { __signature?: string; __signerUsername?: string }): void {
    // Must be addressed to us
    if (response.validatorPeer !== this.myUsername) return;

    const pending = this.pendingChallenges.get(response.nonce);
    if (!pending) return; // No matching pending challenge (already timed out or not ours)

    // SECURITY: Verify signature on challenge responses
    if (response.__signature && response.__signerUsername) {
      if (response.__signerUsername !== response.targetPeer) {
        console.log(`[Validator] Response signature mismatch: signer=${response.__signerUsername} != peer=${response.targetPeer}`);
        return; // Discard spoofed response
      }
      console.log(`[Validator] Signed response from ${response.targetPeer}`);
    } else if (this.requireSignedMessages) {
      console.log(`[Validator] Rejected unsigned response from ${response.targetPeer} (enforcement enabled)`);
      return;
    } else {
      console.log(`[Validator] Unsigned response from ${response.targetPeer} (legacy)`);
    }

    clearTimeout(pending.timeout);
    this.pendingChallenges.delete(response.nonce);
    pending.resolve(response);
  }

  /** Select a CID to challenge from our own pin list (cached for 5 minutes). */
  private async selectChallengeCid(): Promise<string | null> {
    const now = Date.now();
    if (this.cachedPins.length === 0 || now - this.pinsCacheTime > LocalValidator.PIN_CACHE_TTL_MS) {
      try {
        const response = await axios.post(
          `${this.kuboApiUrl}/api/v0/pin/ls?type=recursive`,
          null,
          { timeout: 5000 }
        );
        this.cachedPins = Object.keys(response.data.Keys || {});
        this.pinsCacheTime = now;
      } catch {
        // Use stale cache if available
        if (this.cachedPins.length === 0) return null;
      }
    }

    if (this.cachedPins.length === 0) return null;
    return this.cachedPins[Math.floor(Math.random() * this.cachedPins.length)];
  }

  /** Record and optionally broadcast a challenge result to Hive. */
  private async recordResult(
    peer: PeerInfo,
    cid: string,
    success: boolean,
    proofHash: string,
    latencyMs: number
  ): Promise<void> {
    if (this.broadcastResults && this.hive.hasPostingKey()) {
      await this.hive.broadcastPoAResult(
        peer.hiveUsername,
        cid,
        success,
        proofHash,
        latencyMs
      );
    }
  }

  /** Update cached Hive block hash for challenge entropy. */
  private async updateBlockHash(): Promise<void> {
    try {
      this.currentBlockHash = await this.hive.getLatestBlockHash();
    } catch (err: any) {
      // Keep using previous hash on failure
      if (!this.currentBlockHash) {
        this.currentBlockHash = crypto.randomBytes(32).toString('hex');
      }
    }
  }

  /** Get validator statistics. */
  getStats(): ValidatorStats {
    return { ...this.stats };
  }

  /** Update the challenge interval. */
  setChallengeInterval(ms: number): void {
    this.challengeIntervalMs = ms;
    if (this.challengeTimer) {
      clearTimeout(this.challengeTimer);
      this.scheduleNextChallenge();
    }
  }
}
