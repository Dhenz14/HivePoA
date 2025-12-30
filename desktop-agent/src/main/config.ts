import Store from 'electron-store';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface AgentConfig {
  hiveUsername: string | null;
  ipfsRepoPath: string;
  apiPort: number;
  autoStart: boolean;
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
    };
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
