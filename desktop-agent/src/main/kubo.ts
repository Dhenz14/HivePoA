import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';
import { ConfigStore } from './config';

export class KuboManager {
  private process: ChildProcess | null = null;
  private config: ConfigStore;
  private ipfsPath: string;
  private repoPath: string;

  constructor(config: ConfigStore) {
    this.config = config;
    this.repoPath = config.getConfig().ipfsRepoPath;
    this.ipfsPath = this.findIpfsBinary();
  }

  private findIpfsBinary(): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    
    // In production, use the bundled binary from extraResources
    if (app.isPackaged) {
      const resourcePath = path.join(process.resourcesPath, 'kubo-bin', `ipfs${ext}`);
      console.log('[Kubo] Looking for binary at:', resourcePath);
      if (fs.existsSync(resourcePath)) {
        // Make sure it's executable on Unix
        if (process.platform !== 'win32') {
          try { fs.chmodSync(resourcePath, 0o755); } catch {}
        }
        return resourcePath;
      }
    }

    // In development, look for downloaded kubo binary
    const devBinaryPath = path.join(__dirname, '..', '..', 'kubo-bin', `ipfs${ext}`);
    console.log('[Kubo] Dev binary path:', devBinaryPath);
    if (fs.existsSync(devBinaryPath)) {
      return devBinaryPath;
    }

    throw new Error('IPFS binary not found. Run: npm run download-kubo');
  }

  async start(): Promise<void> {
    console.log(`[Kubo] Using binary: ${this.ipfsPath}`);
    console.log(`[Kubo] Repo path: ${this.repoPath}`);

    // Initialize repo if needed
    if (!fs.existsSync(path.join(this.repoPath, 'config'))) {
      console.log('[Kubo] Initializing IPFS repository...');
      await this.initRepo();
    }

    // Start the daemon
    console.log('[Kubo] Starting IPFS daemon...');
    await this.startDaemon();
  }

  private async initRepo(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(this.repoPath, { recursive: true });
        
        const result = execSync(`"${this.ipfsPath}" init`, {
          env: { ...process.env, IPFS_PATH: this.repoPath },
          encoding: 'utf-8',
        });
        
        console.log('[Kubo] Init result:', result);
        
        // Configure for desktop use
        this.configureForDesktop();
        
        resolve();
      } catch (error: any) {
        if (error.message.includes('already initialized')) {
          resolve();
        } else {
          reject(error);
        }
      }
    });
  }

  private configureForDesktop(): void {
    const configPath = path.join(this.repoPath, 'config');
    if (!fs.existsSync(configPath)) return;

    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      
      // Use default ports but make API accessible
      config.Addresses = {
        ...config.Addresses,
        API: '/ip4/127.0.0.1/tcp/5001',
        Gateway: '/ip4/127.0.0.1/tcp/8080',
      };

      // Enable pubsub for real-time features
      config.Pubsub = { Enabled: true };

      // Lower resource usage for desktop
      config.Swarm = {
        ...config.Swarm,
        ConnMgr: {
          LowWater: 50,
          HighWater: 200,
          GracePeriod: '20s',
        },
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('[Kubo] Desktop configuration applied');
    } catch (error) {
      console.error('[Kubo] Failed to configure:', error);
    }
  }

  private async startDaemon(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.ipfsPath, ['daemon', '--enable-gc'], {
        env: { ...process.env, IPFS_PATH: this.repoPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let started = false;

      this.process.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log('[Kubo]', output.trim());
        
        if (output.includes('Daemon is ready') && !started) {
          started = true;
          resolve();
        }
      });

      this.process.stderr?.on('data', (data) => {
        console.error('[Kubo Error]', data.toString().trim());
      });

      this.process.on('error', (error) => {
        console.error('[Kubo] Process error:', error);
        if (!started) reject(error);
      });

      this.process.on('exit', (code) => {
        console.log(`[Kubo] Process exited with code ${code}`);
        this.process = null;
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (!started) {
          reject(new Error('IPFS daemon startup timeout'));
        }
      }, 30000);
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      console.log('[Kubo] Stopping daemon...');
      this.process.kill('SIGTERM');
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getApiUrl(): string {
    return 'http://127.0.0.1:5001';
  }

  async getPeerId(): Promise<string | null> {
    try {
      const axios = require('axios');
      const response = await axios.post(`${this.getApiUrl()}/api/v0/id`);
      return response.data.ID;
    } catch {
      return null;
    }
  }

  async getStats(): Promise<any> {
    try {
      const axios = require('axios');
      const [repoStats, bwStats] = await Promise.all([
        axios.post(`${this.getApiUrl()}/api/v0/repo/stat`).catch(() => ({ data: {} })),
        axios.post(`${this.getApiUrl()}/api/v0/stats/bw`).catch(() => ({ data: {} })),
      ]);

      return {
        repoSize: repoStats.data.RepoSize || 0,
        numObjects: repoStats.data.NumObjects || 0,
        bandwidthIn: bwStats.data.TotalIn || 0,
        bandwidthOut: bwStats.data.TotalOut || 0,
      };
    } catch {
      return null;
    }
  }
}
