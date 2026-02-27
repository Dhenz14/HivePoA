import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { logIPFS } from "../logger";

export interface IPFSManagerConfig {
  repoPath: string;
  apiPort: number;
  gatewayPort: number;
  swarmPort: number;
  offline: boolean;
  autoStart: boolean;
}

export class IPFSManager {
  private daemon: ChildProcess | null = null;
  private isReady: boolean = false;
  private isStarting: boolean = false;
  private config: IPFSManagerConfig;
  private restartAttempts: number = 0;
  private maxRestartAttempts: number = 3;

  constructor(config?: Partial<IPFSManagerConfig>) {
    this.config = {
      repoPath: config?.repoPath || process.env.IPFS_PATH || ".ipfs-data",
      apiPort: config?.apiPort || parseInt(process.env.IPFS_API_PORT || "5001"),
      gatewayPort: config?.gatewayPort || parseInt(process.env.IPFS_GATEWAY_PORT || "8081"),
      swarmPort: config?.swarmPort || parseInt(process.env.IPFS_SWARM_PORT || "4001"),
      offline: config?.offline || process.env.IPFS_OFFLINE === "true",
      autoStart: config?.autoStart ?? true,
    };
  }

  private log(message: string) {
    logIPFS.info(`[IPFS Manager] ${message}`);
  }

  private error(message: string) {
    logIPFS.error(`[IPFS Manager] ERROR: ${message}`);
  }

  private async initializeRepo(): Promise<boolean> {
    const repoPath = path.resolve(this.config.repoPath);
    
    if (existsSync(path.join(repoPath, "config"))) {
      this.log(`Repository already exists at ${repoPath}`);
      return true;
    }

    this.log(`Initializing new IPFS repository at ${repoPath}`);
    
    try {
      mkdirSync(repoPath, { recursive: true });
      
      const env = { ...process.env, IPFS_PATH: repoPath };
      
      execSync("ipfs init --profile=server", { env, stdio: "pipe" });
      this.log("Repository initialized");

      execSync('ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin \'["*"]\'', { env, stdio: "pipe" });
      execSync('ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods \'["PUT", "POST", "GET"]\'', { env, stdio: "pipe" });
      execSync('ipfs config --json API.HTTPHeaders.Access-Control-Allow-Headers \'["Authorization", "X-Requested-With", "Range", "Content-Range"]\'', { env, stdio: "pipe" });
      this.log("CORS configured");

      execSync('ipfs config Datastore.StorageMax "5GB"', { env, stdio: "pipe" });
      this.log("Storage limits set");

      execSync(`ipfs config Addresses.API "/ip4/0.0.0.0/tcp/${this.config.apiPort}"`, { env, stdio: "pipe" });
      execSync(`ipfs config Addresses.Gateway "/ip4/0.0.0.0/tcp/${this.config.gatewayPort}"`, { env, stdio: "pipe" });
      this.log("Ports configured");

      return true;
    } catch (err: any) {
      this.error(`Failed to initialize repository: ${err.message}`);
      return false;
    }
  }

  private async waitForReady(timeout: number = 30000): Promise<boolean> {
    const startTime = Date.now();
    const apiUrl = `http://127.0.0.1:${this.config.apiPort}/api/v0/id`;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(apiUrl, { method: "POST" });
        if (response.ok) {
          this.isReady = true;
          return true;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }

  async start(): Promise<boolean> {
    if (this.isReady && this.daemon) {
      this.log("Daemon already running");
      return true;
    }

    if (this.isStarting) {
      this.log("Daemon is already starting...");
      return false;
    }

    this.isStarting = true;

    // Check if an external IPFS daemon is already running (e.g. user started Kubo separately)
    try {
      const apiUrl = `http://127.0.0.1:${this.config.apiPort}/api/v0/id`;
      const response = await fetch(apiUrl, { method: "POST", signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        this.log(`External IPFS daemon detected on port ${this.config.apiPort} — using existing daemon`);
        this.isReady = true;
        this.isStarting = false;
        return true;
      }
    } catch {
      // No existing daemon, proceed to start one
    }

    this.log("Starting IPFS daemon...");

    const initialized = await this.initializeRepo();
    if (!initialized) {
      this.isStarting = false;
      return false;
    }

    const repoPath = path.resolve(this.config.repoPath);
    const env = { ...process.env, IPFS_PATH: repoPath };
    const args = this.config.offline ? ["daemon", "--offline"] : ["daemon"];

    try {
      this.daemon = spawn("ipfs", args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      this.daemon.stdout?.on("data", (data) => {
        const output = data.toString();
        if (output.includes("Daemon is ready")) {
          this.log("Daemon is ready!");
        }
      });

      this.daemon.stderr?.on("data", (data) => {
        const output = data.toString();
        if (!output.includes("failed to sufficiently increase receive buffer")) {
          logIPFS.info(`[IPFS] ${output.trim()}`);
        }
      });

      this.daemon.on("exit", (code) => {
        this.isReady = false;
        this.daemon = null;
        
        if (code !== 0 && code !== null) {
          this.error(`Daemon exited with code ${code}`);
          this.attemptRestart();
        }
      });

      this.daemon.on("error", (err) => {
        this.error(`Daemon error: ${err.message}`);
        this.isReady = false;
        this.daemon = null;
      });

      const ready = await this.waitForReady();
      this.isStarting = false;

      if (ready) {
        this.restartAttempts = 0;
        this.log(`Daemon running - API: http://0.0.0.0:${this.config.apiPort}, Gateway: http://0.0.0.0:${this.config.gatewayPort}`);
        return true;
      } else {
        this.error("Daemon failed to become ready");
        this.stop();
        return false;
      }
    } catch (err: any) {
      this.error(`Failed to start daemon: ${err.message}`);
      this.isStarting = false;
      return false;
    }
  }

  private attemptRestart() {
    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts++;
      this.log(`Attempting restart (${this.restartAttempts}/${this.maxRestartAttempts})...`);
      setTimeout(() => this.start(), 2000);
    } else {
      this.error("Max restart attempts reached");
    }
  }

  async stop(): Promise<void> {
    if (this.daemon) {
      this.log("Stopping IPFS daemon...");
      this.daemon.kill("SIGTERM");
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.daemon) {
            this.daemon.kill("SIGKILL");
          }
          resolve();
        }, 5000);

        this.daemon?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.daemon = null;
      this.isReady = false;
      this.log("Daemon stopped");
    }
  }

  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  getStatus(): {
    running: boolean;
    ready: boolean;
    starting: boolean;
    apiUrl: string;
    gatewayUrl: string;
    repoPath: string;
    offline: boolean;
  } {
    return {
      running: this.daemon !== null,
      ready: this.isReady,
      starting: this.isStarting,
      apiUrl: `http://127.0.0.1:${this.config.apiPort}`,
      gatewayUrl: `http://127.0.0.1:${this.config.gatewayPort}`,
      repoPath: path.resolve(this.config.repoPath),
      offline: this.config.offline,
    };
  }

  isRunning(): boolean {
    return this.isReady && this.daemon !== null;
  }

  registerShutdownHandlers() {
    const shutdown = async () => {
      this.log("Received shutdown signal, stopping daemon...");
      await this.stop();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("beforeExit", shutdown);
  }

  getApiUrl(): string {
    return `http://127.0.0.1:${this.config.apiPort}`;
  }
}

export const ipfsManager = new IPFSManager();
