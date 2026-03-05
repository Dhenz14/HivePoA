import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Electron modules are optional — CLI mode runs without them
let Store: any;
let safeStorage: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string } | null = null;
try {
  Store = require('electron-store');
  safeStorage = require('electron').safeStorage;
} catch {
  // Running in CLI mode without Electron
}

export interface AgentConfig {
  hiveUsername: string | null;
  ipfsRepoPath: string;
  apiPort: number;
  autoStart: boolean;
  bandwidthLimitUp: number;   // KB/s, 0 = unlimited
  bandwidthLimitDown: number; // KB/s, 0 = unlimited
  storageMaxGB: number;       // GB, 0 = 100GB default, default 50
  serverUrl: string;          // Central server URL for WebSocket registration (legacy mode)
  // P2P mode settings
  p2pMode: boolean;           // true = decentralized P2P, false = legacy central server
  validatorEnabled: boolean;  // Whether this node validates other peers
  challengeIntervalMs: number; // How often to challenge peers (ms)
  minPeerReputation: number;  // Minimum Hive reputation to accept peer
  requireSignedMessages: boolean; // Reject unsigned PubSub challenges/responses (enforce after network migration)
  // Auto-pin popular content
  autoPinPopular: boolean;    // Auto-pin popular content from network
  autoPinMaxGB: number;       // Max storage for auto-pinned content (GB)
  // Multisig Treasury
  treasurySignerEnabled: boolean; // Whether this agent auto-signs treasury transactions
}

export interface EarningsData {
  totalHbd: number;
  challengesPassed: number;
  challengesFailed: number;
  consecutivePasses: number;
  lastChallengeTime: string | null;
}

export class ConfigStore {
  private store: any;
  private configPath: string;
  private earningsPath: string;

  constructor() {
    if (!Store) {
      throw new Error('ConfigStore requires Electron — use CliConfigStore for headless mode');
    }
    this.store = new Store({
      name: 'spk-desktop-agent',
    });

    const spkDir = path.join(os.homedir(), '.spk-ipfs');
    if (!fs.existsSync(spkDir)) {
      fs.mkdirSync(spkDir, { recursive: true });
    }

    this.configPath = path.join(spkDir, 'agent-config.json');
    this.earningsPath = path.join(spkDir, 'earnings.json');
  }

  getConfig(): AgentConfig {
    return {
      hiveUsername: this.store.get('hiveUsername', null) as string | null,
      ipfsRepoPath: this.store.get('ipfsRepoPath', path.join(os.homedir(), '.spk-ipfs', 'repo')) as string,
      apiPort: this.store.get('apiPort', 5111) as number,
      autoStart: this.store.get('autoStart', false) as boolean,
      bandwidthLimitUp: this.store.get('bandwidthLimitUp', 0) as number,
      bandwidthLimitDown: this.store.get('bandwidthLimitDown', 0) as number,
      storageMaxGB: this.store.get('storageMaxGB', 50) as number,
      serverUrl: this.store.get('serverUrl', 'http://localhost:5000') as string,
      p2pMode: this.store.get('p2pMode', true) as boolean,
      validatorEnabled: this.store.get('validatorEnabled', true) as boolean,
      challengeIntervalMs: this.store.get('challengeIntervalMs', 7200000) as number, // 2 hours (was 5 min)
      minPeerReputation: this.store.get('minPeerReputation', 25) as number,
      requireSignedMessages: this.store.get('requireSignedMessages', false) as boolean,
      autoPinPopular: this.store.get('autoPinPopular', true) as boolean,
      autoPinMaxGB: this.store.get('autoPinMaxGB', 10) as number,
      treasurySignerEnabled: this.store.get('treasurySignerEnabled', false) as boolean,
    };
  }

  /**
   * Store wallet password encrypted via OS credential store (DPAPI/Keychain/libsecret).
   * The wallet password unlocks the beekeeper-style encrypted wallet file.
   * For CLI mode (no Electron), password is entered at startup or via env var.
   */
  setWalletPassword(password: string): void {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'OS encryption unavailable — cannot securely store wallet password. ' +
        'Ensure the system keychain/credential manager is accessible and restart the app.'
      );
    }
    const encrypted = safeStorage.encryptString(password);
    this.store.set('encryptedWalletPassword', encrypted.toString('base64'));
  }

  getWalletPassword(): string | null {
    const stored = this.store.get('encryptedWalletPassword') as string | undefined;
    if (!stored) return null;

    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      console.error('[Config] OS encryption unavailable — cannot decrypt wallet password');
      return null;
    }

    try {
      const encrypted = Buffer.from(stored, 'base64');
      return safeStorage.decryptString(encrypted);
    } catch (err) {
      console.error('[Config] Failed to decrypt wallet password:', err);
      return null;
    }
  }

  hasWalletPassword(): boolean {
    return !!this.store.get('encryptedWalletPassword');
  }

  clearWalletPassword(): void {
    this.store.delete('encryptedWalletPassword');
  }

  /** Public key accessors — public keys are not secret, stored in plaintext config */
  setActivePublicKey(pubKey: string): void {
    this.store.set('activePublicKey', pubKey);
  }

  getActivePublicKey(): string | null {
    return this.store.get('activePublicKey', null) as string | null;
  }

  hasActiveKey(): boolean {
    return !!this.store.get('activePublicKey');
  }

  clearActivePublicKey(): void {
    this.store.delete('activePublicKey');
  }

  setPostingPublicKey(pubKey: string): void {
    this.store.set('postingPublicKey', pubKey);
  }

  getPostingPublicKey(): string | null {
    return this.store.get('postingPublicKey', null) as string | null;
  }

  hasPostingKey(): boolean {
    return !!this.store.get('postingPublicKey');
  }

  clearPostingPublicKey(): void {
    this.store.delete('postingPublicKey');
  }

  setConfig(config: Partial<AgentConfig>): void {
    Object.entries(config).forEach(([key, value]) => {
      this.store.set(key, value);
    });

    // Also save to JSON file for external access
    const fullConfig = this.getConfig();
    fs.writeFileSync(this.configPath, JSON.stringify(fullConfig, null, 2));
  }

  getEarnings(): EarningsData {
    try {
      if (fs.existsSync(this.earningsPath)) {
        return JSON.parse(fs.readFileSync(this.earningsPath, 'utf-8'));
      }
    } catch (error) {
      console.error('[Config] Failed to read earnings:', error);
    }

    return {
      totalHbd: 0,
      challengesPassed: 0,
      challengesFailed: 0,
      consecutivePasses: 0,
      lastChallengeTime: null,
    };
  }

  updateEarnings(update: Partial<EarningsData>): EarningsData {
    const current = this.getEarnings();
    const updated = { ...current, ...update };
    fs.writeFileSync(this.earningsPath, JSON.stringify(updated, null, 2));
    return updated;
  }

  /**
   * Record a challenge result. This is synchronous (readFileSync + writeFileSync)
   * which is safe in Node.js single-threaded event loop — no concurrent interleaving.
   */
  recordChallenge(passed: boolean, hbdEarned: number): EarningsData {
    const current = this.getEarnings();

    if (passed) {
      current.challengesPassed++;
      current.consecutivePasses++;
      current.totalHbd += hbdEarned;
    } else {
      current.challengesFailed++;
      current.consecutivePasses = 0;
    }

    current.lastChallengeTime = new Date().toISOString();

    fs.writeFileSync(this.earningsPath, JSON.stringify(current, null, 2));
    return current;
  }
}
