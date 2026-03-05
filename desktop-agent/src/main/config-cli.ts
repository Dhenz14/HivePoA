/**
 * CLI Config Store — Platform-agnostic configuration for headless/Linux operation.
 *
 * Replaces electron-store and safeStorage with plain JSON files.
 * Wallet password comes from env var SPK_WALLET_PASSWORD or is entered at startup.
 * Data stored in ~/.spk-ipfs/
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { AgentConfig, EarningsData } from './config';

export class CliConfigStore {
  private configPath: string;
  private earningsPath: string;
  private data: Record<string, any>;

  constructor() {
    const spkDir = path.join(os.homedir(), '.spk-ipfs');
    if (!fs.existsSync(spkDir)) {
      fs.mkdirSync(spkDir, { recursive: true });
    }

    this.configPath = path.join(spkDir, 'agent-config.json');
    this.earningsPath = path.join(spkDir, 'earnings.json');

    // Load persisted config
    if (fs.existsSync(this.configPath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      } catch {
        this.data = {};
      }
    } else {
      this.data = {};
    }
  }

  private get(key: string, defaultValue: any): any {
    return this.data[key] !== undefined ? this.data[key] : defaultValue;
  }

  getConfig(): AgentConfig {
    return {
      hiveUsername: this.get('hiveUsername', null) as string | null,
      ipfsRepoPath: this.get('ipfsRepoPath', path.join(os.homedir(), '.spk-ipfs', 'repo')) as string,
      apiPort: this.get('apiPort', 5111) as number,
      autoStart: this.get('autoStart', false) as boolean,
      bandwidthLimitUp: this.get('bandwidthLimitUp', 0) as number,
      bandwidthLimitDown: this.get('bandwidthLimitDown', 0) as number,
      storageMaxGB: this.get('storageMaxGB', 50) as number,
      serverUrl: this.get('serverUrl', 'http://localhost:5000') as string,
      p2pMode: this.get('p2pMode', true) as boolean,
      validatorEnabled: this.get('validatorEnabled', true) as boolean,
      challengeIntervalMs: this.get('challengeIntervalMs', 7200000) as number,
      minPeerReputation: this.get('minPeerReputation', 25) as number,
      requireSignedMessages: this.get('requireSignedMessages', false) as boolean,
      autoPinPopular: this.get('autoPinPopular', true) as boolean,
      autoPinMaxGB: this.get('autoPinMaxGB', 10) as number,
      treasurySignerEnabled: this.get('treasurySignerEnabled', false) as boolean,
    };
  }

  /**
   * Wallet password from environment variable (CLI mode).
   * No OS keychain — password must be provided via SPK_WALLET_PASSWORD env var.
   */
  setWalletPassword(_password: string): void {
    // In CLI mode, password is provided via env var each startup.
    // We don't persist it — that's the point of headless mode.
    console.log('[Config-CLI] Wallet password set for this session (not persisted)');
  }

  getWalletPassword(): string | null {
    return process.env.SPK_WALLET_PASSWORD || null;
  }

  hasWalletPassword(): boolean {
    return !!process.env.SPK_WALLET_PASSWORD;
  }

  clearWalletPassword(): void {
    // No-op in CLI mode
  }

  setActivePublicKey(pubKey: string): void {
    this.data.activePublicKey = pubKey;
    this.save();
  }

  getActivePublicKey(): string | null {
    return (this.data.activePublicKey as string) || null;
  }

  hasActiveKey(): boolean {
    return !!this.data.activePublicKey;
  }

  clearActivePublicKey(): void {
    delete this.data.activePublicKey;
    this.save();
  }

  setPostingPublicKey(pubKey: string): void {
    this.data.postingPublicKey = pubKey;
    this.save();
  }

  getPostingPublicKey(): string | null {
    return (this.data.postingPublicKey as string) || null;
  }

  hasPostingKey(): boolean {
    return !!this.data.postingPublicKey;
  }

  clearPostingPublicKey(): void {
    delete this.data.postingPublicKey;
    this.save();
  }

  setConfig(config: Partial<AgentConfig>): void {
    Object.entries(config).forEach(([key, value]) => {
      this.data[key] = value;
    });
    this.save();
  }

  getEarnings(): EarningsData {
    try {
      if (fs.existsSync(this.earningsPath)) {
        return JSON.parse(fs.readFileSync(this.earningsPath, 'utf-8'));
      }
    } catch (error) {
      console.error('[Config-CLI] Failed to read earnings:', error);
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

  private save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
  }
}
