import Store from 'electron-store';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { safeStorage } from 'electron';

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
  // Auto-pin popular content
  autoPinPopular: boolean;    // Auto-pin popular content from network
  autoPinMaxGB: number;       // Max storage for auto-pinned content (GB)
}

export interface EarningsData {
  totalHbd: number;
  challengesPassed: number;
  challengesFailed: number;
  consecutivePasses: number;
  lastChallengeTime: string | null;
}

export class ConfigStore {
  private store: Store;
  private configPath: string;
  private earningsPath: string;

  constructor() {
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
      challengeIntervalMs: this.store.get('challengeIntervalMs', 300000) as number,
      minPeerReputation: this.store.get('minPeerReputation', 25) as number,
      autoPinPopular: this.store.get('autoPinPopular', true) as boolean,
      autoPinMaxGB: this.store.get('autoPinMaxGB', 10) as number,
    };
  }

  /**
   * Store Hive posting key encrypted via OS credential store (DPAPI/Keychain/libsecret).
   * The raw key never touches disk in plaintext.
   */
  setPostingKey(key: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key);
      this.store.set('encryptedPostingKey', encrypted.toString('base64'));
    } else {
      // Fallback: store as-is (warn user in UI)
      console.warn('[Config] OS encryption unavailable — posting key stored without encryption');
      this.store.set('encryptedPostingKey', Buffer.from(key).toString('base64'));
    }
  }

  getPostingKey(): string | null {
    const stored = this.store.get('encryptedPostingKey') as string | undefined;
    if (!stored) return null;

    try {
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = Buffer.from(stored, 'base64');
        return safeStorage.decryptString(encrypted);
      } else {
        return Buffer.from(stored, 'base64').toString('utf-8');
      }
    } catch (err) {
      console.error('[Config] Failed to decrypt posting key:', err);
      return null;
    }
  }

  hasPostingKey(): boolean {
    return !!this.store.get('encryptedPostingKey');
  }

  clearPostingKey(): void {
    this.store.delete('encryptedPostingKey');
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
