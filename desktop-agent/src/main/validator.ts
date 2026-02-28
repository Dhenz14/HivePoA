import * as crypto from 'crypto';
import axios from 'axios';
import { AgentHiveClient } from './hive';
import { PeerDiscovery, PeerInfo } from './peer-discovery';
import { PubSubBridge } from './pubsub';
import { ChallengeMessage, ChallengeResponse } from './challenge-handler';
import { createSaltWithEntropy, verifyProof } from './poa-crypto';

const CHALLENGE_TOPIC = 'hivepoa-challenges';
const CHALLENGE_TIMEOUT_MS = 25000; // 25 second anti-cheat window

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

  private challengeTimer: NodeJS.Timeout | null = null;
  private blockHashTimer: NodeJS.Timeout | null = null;
  private currentBlockHash: string = '';
  private pendingChallenges: Map<string, PendingChallenge> = new Map(); // nonce → pending

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
    challengeIntervalMs: number = 300000,
    broadcastResults: boolean = true
  ) {
    this.hive = hive;
    this.peerDiscovery = peerDiscovery;
    this.pubsub = pubsub;
    this.kuboApiUrl = kuboApiUrl;
    this.myUsername = myUsername;
    this.challengeIntervalMs = challengeIntervalMs;
    this.broadcastResults = broadcastResults;
  }

  /** Start the validator engine. */
  async start(): Promise<void> {
    console.log(`[Validator] Starting (interval: ${this.challengeIntervalMs / 1000}s)`);

    // Get initial block hash
    await this.updateBlockHash();

    // Refresh block hash every 60 seconds (was 30s — reduces API calls by half)
    this.blockHashTimer = setInterval(() => this.updateBlockHash(), 60000);

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

    // Clear pending challenges
    for (const [nonce, pending] of this.pendingChallenges) {
      clearTimeout(pending.timeout);
    }
    this.pendingChallenges.clear();

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

  /** Issue a challenge to a specific peer. */
  private async challengePeer(peer: PeerInfo): Promise<void> {
    // Select a CID to challenge from our own pin list (we need the data to verify)
    const cid = await this.selectChallengeCid();
    if (!cid) {
      console.log('[Validator] No CIDs available to challenge');
      return;
    }

    // Generate challenge
    const salt = createSaltWithEntropy(this.currentBlockHash);
    const nonce = crypto.randomBytes(16).toString('hex');

    const challenge: ChallengeMessage = {
      type: 'challenge',
      targetPeer: peer.hiveUsername,
      validatorPeer: this.myUsername,
      cid,
      salt,
      blockHash: this.currentBlockHash.slice(0, 16),
      timestamp: Date.now(),
      nonce,
    };

    this.stats.issued++;
    console.log(`[Validator] Challenging ${peer.hiveUsername} for CID ${cid.slice(0, 12)}...`);

    // Set up response handler with timeout
    const responsePromise = new Promise<ChallengeResponse | null>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingChallenges.delete(nonce);
        resolve(null); // Timeout
      }, CHALLENGE_TIMEOUT_MS);

      this.pendingChallenges.set(nonce, {
        resolve,
        timeout,
        startTime: Date.now(),
      });
    });

    // Publish challenge via PubSub
    const published = await this.pubsub.publish(CHALLENGE_TOPIC, challenge);
    if (!published) {
      this.pendingChallenges.delete(nonce);
      console.error('[Validator] Failed to publish challenge');
      return;
    }

    // Wait for response
    const response = await responsePromise;

    if (!response) {
      // Timeout
      this.stats.timeouts++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] Challenge to ${peer.hiveUsername} timed out`);
      return;
    }

    // Verify the proof independently
    const serverElapsed = Date.now() - (this.pendingChallenges.get(nonce)?.startTime || Date.now());

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
      console.log(`[Validator] ${peer.hiveUsername} reported failure: ${response.error}`);
      await this.recordResult(peer, cid, false, '', serverElapsed);
      return;
    }

    // Independently verify the proof hash
    const verification = await verifyProof(this.kuboApiUrl, salt, cid, response.proofHash);

    if (verification.valid) {
      this.stats.passed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, true);
      console.log(`[Validator] ${peer.hiveUsername} PASSED (${serverElapsed}ms)`);
      await this.recordResult(peer, cid, true, response.proofHash, serverElapsed);
    } else {
      this.stats.failed++;
      this.peerDiscovery.recordChallenge(peer.hiveUsername, false);
      console.log(`[Validator] ${peer.hiveUsername} FAILED — proof mismatch`);
      await this.recordResult(peer, cid, false, response.proofHash, serverElapsed);
    }
  }

  /** Handle an incoming challenge response from PubSub. */
  handleChallengeResponse(response: ChallengeResponse): void {
    // Must be addressed to us
    if (response.validatorPeer !== this.myUsername) return;

    const pending = this.pendingChallenges.get(response.nonce);
    if (!pending) return; // No matching pending challenge (already timed out or not ours)

    clearTimeout(pending.timeout);
    this.pendingChallenges.delete(response.nonce);
    pending.resolve(response);
  }

  /** Select a CID to challenge from our own pin list. */
  private async selectChallengeCid(): Promise<string | null> {
    try {
      const response = await axios.post(
        `${this.kuboApiUrl}/api/v0/pin/ls?type=recursive`,
        null,
        { timeout: 5000 }
      );
      const pins = Object.keys(response.data.Keys || {});
      if (pins.length === 0) return null;

      // Select random CID from our pins
      return pins[Math.floor(Math.random() * pins.length)];
    } catch {
      return null;
    }
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
