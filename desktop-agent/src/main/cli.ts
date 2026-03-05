#!/usr/bin/env node
/**
 * SPK Desktop Agent — Headless CLI mode for Linux/Ubuntu servers.
 *
 * Runs the full agent (IPFS, API server, P2P, treasury signer) without
 * Electron. Designed for Ubuntu VPS / dedicated server deployment.
 *
 * Usage:
 *   SPK_WALLET_PASSWORD=mypassword node cli.js
 *
 * Environment variables:
 *   SPK_WALLET_PASSWORD  — Wallet password (required for signing)
 *   SPK_HIVE_USERNAME    — Hive username (overrides saved config)
 *   SPK_API_PORT         — API port (default: 5111)
 *   SPK_SERVER_URL       — Central server URL (default: http://localhost:5000)
 */

import * as path from 'path';
import * as os from 'os';
import { CliConfigStore } from './config-cli';
import { KuboManager } from './kubo';
import { ApiServer } from './api';
import { WalletManager } from './wallet-manager';
import { AgentHiveClient } from './hive';
import { PeerDiscovery } from './peer-discovery';
import { PubSubBridge } from './pubsub';
import { ChallengeHandler, ChallengeMessage, ChallengeResponse, CommitmentRequest, CommitmentResponse } from './challenge-handler';
import { LocalValidator } from './validator';
import { AutoPinner } from './auto-pinner';
import { TreasurySigner } from './treasury-signer';
import { AgentWSClient } from './agent-ws';
import { initializeFullServer, shutdownFullServer } from './server-init-cli';

// ─── Global error handlers ─────────────────────────────────────────────
process.on('uncaughtException', (error) => {
  console.error('[SPK-CLI] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SPK-CLI] Unhandled rejection:', reason);
});

const CHALLENGE_TOPIC = 'hivepoa-challenges';

let configStore: CliConfigStore;
let kuboManager: KuboManager;
let apiServer: ApiServer;
let walletManager: WalletManager;

// P2P mode
let hiveClient: AgentHiveClient | null = null;
let peerDiscovery: PeerDiscovery | null = null;
let pubsub: PubSubBridge | null = null;
let challengeHandler: ChallengeHandler | null = null;
let validator: LocalValidator | null = null;
let autoPinner: AutoPinner | null = null;

// Legacy mode
let agentWS: AgentWSClient | null = null;

async function initializeP2P(): Promise<void> {
  const cfg = configStore.getConfig();

  if (!cfg.hiveUsername) {
    console.log('[SPK-CLI] P2P mode: no Hive username configured, running in standalone mode');
    return;
  }

  const hasKey = configStore.hasPostingKey();

  hiveClient = new AgentHiveClient({
    username: cfg.hiveUsername,
    getPostingKey: () => walletManager.getPostingKey(),
  });

  const peerId = await kuboManager.getPeerId();
  if (!peerId) {
    console.error('[SPK-CLI] P2P mode: no IPFS peer ID available');
    return;
  }

  peerDiscovery = new PeerDiscovery(hiveClient, configStore as any);
  peerDiscovery.setKuboInfo(kuboManager.getApiUrl(), peerId);

  pubsub = new PubSubBridge(kuboManager.getApiUrl(), peerId);

  challengeHandler = new ChallengeHandler(
    kuboManager.getApiUrl(), pubsub, cfg.hiveUsername, configStore as any, hiveClient
  );

  await pubsub.subscribe(CHALLENGE_TOPIC, (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type === 'challenge' && data.targetPeer === cfg.hiveUsername) {
        challengeHandler!.handleChallenge(data as ChallengeMessage);
      } else if (data.type === 'response') {
        validator?.handleChallengeResponse(data as ChallengeResponse);
      } else if (data.type === 'commitment-request' && data.targetPeer === cfg.hiveUsername) {
        challengeHandler!.handleCommitmentRequest(data as CommitmentRequest);
      } else if (data.type === 'commitment-response') {
        validator?.handleCommitmentResponse(data as CommitmentResponse);
      }
    } catch {}
  });

  await peerDiscovery.start();

  if (cfg.validatorEnabled) {
    validator = new LocalValidator(
      hiveClient, peerDiscovery, pubsub, kuboManager.getApiUrl(),
      cfg.hiveUsername, cfg.challengeIntervalMs, hasKey, cfg.requireSignedMessages
    );
    await validator.start();
  }

  if (cfg.autoPinPopular) {
    autoPinner = new AutoPinner(kuboManager.getApiUrl(), cfg.serverUrl, cfg.autoPinMaxGB);
    await autoPinner.start();
  }

  apiServer.setP2PModules(peerDiscovery, validator, challengeHandler);

  const peerCount = peerDiscovery.getPeerCount();
  console.log(`[SPK-CLI] P2P mode initialized: ${peerCount} peers, validator=${cfg.validatorEnabled}`);
}

async function initializeLegacy(): Promise<void> {
  console.log('[SPK-CLI] Legacy mode: connecting to central server');

  agentWS = new AgentWSClient(kuboManager, configStore as any);
  apiServer.setAgentWS(agentWS);

  if (walletManager.isInitialized() && walletManager.hasActiveKey()) {
    const treasurySigner = new TreasurySigner(configStore as any, walletManager);
    agentWS.setTreasurySigner(treasurySigner);
    console.log('[SPK-CLI] Treasury signer initialized — auto-signing enabled');
  }

  agentWS.on('connected', () => console.log('[SPK-CLI] WebSocket connected'));
  agentWS.on('disconnected', () => console.log('[SPK-CLI] WebSocket disconnected'));

  setTimeout(() => agentWS!.connect(), 2000);
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  SPK Desktop Agent — CLI / Headless Mode     ║');
  console.log('║  For Linux servers without Electron           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log();

  // Initialize config
  configStore = new CliConfigStore();

  // Apply env var overrides
  if (process.env.SPK_HIVE_USERNAME) {
    configStore.setConfig({ hiveUsername: process.env.SPK_HIVE_USERNAME });
    console.log(`[SPK-CLI] Hive username: ${process.env.SPK_HIVE_USERNAME}`);
  }
  if (process.env.SPK_API_PORT) {
    configStore.setConfig({ apiPort: parseInt(process.env.SPK_API_PORT, 10) });
  }
  if (process.env.SPK_SERVER_URL) {
    configStore.setConfig({ serverUrl: process.env.SPK_SERVER_URL });
  }

  // Initialize wallet
  walletManager = new WalletManager();
  const walletDir = path.join(os.homedir(), '.spk-ipfs', 'wallet');
  const walletPassword = configStore.getWalletPassword();
  if (walletPassword) {
    try {
      await walletManager.init(walletDir, walletPassword);
      console.log('[SPK-CLI] Wallet unlocked —', walletManager.hasActiveKey() ? 'active key loaded' : 'no active key');
    } catch (err: any) {
      console.error('[SPK-CLI] Failed to unlock wallet:', err.message);
    }
  } else {
    console.log('[SPK-CLI] No wallet password — set SPK_WALLET_PASSWORD env var to enable signing');
  }

  // Initialize Kubo (IPFS)
  kuboManager = new KuboManager(configStore as any);
  apiServer = new ApiServer(kuboManager, configStore as any, walletManager);

  try {
    await kuboManager.start();
    console.log('[SPK-CLI] IPFS daemon started');

    kuboManager.onExit(() => {
      console.log('[SPK-CLI] Kubo exited unexpectedly, restarting in 5s...');
      setTimeout(async () => {
        try {
          await kuboManager.start();
          console.log('[SPK-CLI] Kubo restarted');
        } catch (err) {
          console.error('[SPK-CLI] Kubo restart failed:', err);
        }
      }, 5000);
    });
  } catch (error) {
    console.error('[SPK-CLI] Failed to start IPFS:', error);
    console.log('[SPK-CLI] Continuing without IPFS — ensure an external daemon is running on port 5001');
  }

  try {
    await apiServer.start();
    const port = configStore.getConfig().apiPort;
    console.log(`[SPK-CLI] API server started on http://127.0.0.1:${port}`);

    // Initialize full server backend (SQLite)
    const httpServer = apiServer.getHttpServer();
    const expressApp = apiServer.getExpressApp();
    if (httpServer && expressApp) {
      try {
        await initializeFullServer(httpServer, expressApp);
        console.log('[SPK-CLI] Full server backend ready');
      } catch (err: any) {
        console.error('[SPK-CLI] Full server init failed:', err.message);
      }
    }
  } catch (error) {
    console.error('[SPK-CLI] Failed to start API server:', error);
  }

  // Choose mode
  const cfg = configStore.getConfig();
  if (cfg.p2pMode) {
    await initializeP2P();
  } else {
    await initializeLegacy();
  }

  console.log();
  console.log('[SPK-CLI] Agent running. Press Ctrl+C to stop.');
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log('\n[SPK-CLI] Shutting down...');

  autoPinner?.stop();
  validator?.stop();
  challengeHandler?.stop();
  peerDiscovery?.stop();
  await pubsub?.unsubscribeAll();

  agentWS?.disconnect();
  shutdownFullServer();

  await kuboManager?.stop();
  await apiServer?.stop();

  console.log('[SPK-CLI] Goodbye.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[SPK-CLI] Fatal error:', err);
  process.exit(1);
});
