import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import { KuboManager } from './kubo';
import { ApiServer } from './api';
import { ConfigStore } from './config';
import { AutoUpdater } from './updater';
import { AgentWSClient } from './agent-ws';
import { AgentHiveClient } from './hive';
import { PeerDiscovery } from './peer-discovery';
import { PubSubBridge } from './pubsub';
import { ChallengeHandler, ChallengeMessage, ChallengeResponse } from './challenge-handler';
import { LocalValidator } from './validator';
import { AutoPinner } from './auto-pinner';

// ─── Global error handlers — prevent silent crashes ─────────────────────────
process.on('uncaughtException', (error) => {
  console.error('[SPK] Uncaught exception:', error);
  try {
    dialog.showErrorBox('SPK Desktop Agent', `Unexpected error: ${error.message}\n\nThe app will try to continue.`);
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  console.error('[SPK] Unhandled rejection:', reason);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let kuboManager: KuboManager;
let apiServer: ApiServer;
let configStore: ConfigStore;
let autoUpdater: AutoUpdater;

// Legacy mode
let agentWS: AgentWSClient | null = null;

// P2P mode modules
let hiveClient: AgentHiveClient | null = null;
let peerDiscovery: PeerDiscovery | null = null;
let pubsub: PubSubBridge | null = null;
let challengeHandler: ChallengeHandler | null = null;
let validator: LocalValidator | null = null;
let autoPinner: AutoPinner | null = null;

const CHALLENGE_TOPIC = 'hivepoa-challenges';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  // Use app.isPackaged instead of NODE_ENV to avoid inheriting shell env vars
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:8080');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);

  updateTrayMenu('Starting...');
  tray.setToolTip('SPK Desktop Agent');

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function updateTrayMenu(status: string): void {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Status: ${status}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Check for Updates', click: () => { autoUpdater?.checkForUpdates(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

async function initializeP2P(): Promise<void> {
  const cfg = configStore.getConfig();

  if (!cfg.hiveUsername) {
    console.log('[SPK] P2P mode: no Hive username configured, running in standalone mode');
    updateTrayMenu('Running (Standalone)');
    return;
  }

  const postingKey = configStore.getPostingKey();

  // Initialize Hive client
  hiveClient = new AgentHiveClient({
    username: cfg.hiveUsername,
    postingKey: postingKey || undefined,
  });

  // Get peer ID from IPFS
  const peerId = await kuboManager.getPeerId();
  if (!peerId) {
    console.error('[SPK] P2P mode: no IPFS peer ID available');
    return;
  }

  // Initialize peer discovery
  peerDiscovery = new PeerDiscovery(hiveClient, configStore);
  peerDiscovery.setKuboInfo(kuboManager.getApiUrl(), peerId);

  // Initialize PubSub bridge
  pubsub = new PubSubBridge(kuboManager.getApiUrl(), peerId);

  // Initialize challenge handler (always active — we always respond to challenges)
  challengeHandler = new ChallengeHandler(
    kuboManager.getApiUrl(), pubsub, cfg.hiveUsername, configStore
  );

  // Subscribe to challenge topic
  await pubsub.subscribe(CHALLENGE_TOPIC, (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data.type === 'challenge' && data.targetPeer === cfg.hiveUsername) {
        challengeHandler!.handleChallenge(data as ChallengeMessage);
      } else if (data.type === 'response') {
        validator?.handleChallengeResponse(data as ChallengeResponse);
      }
    } catch {}
  });

  // Start peer discovery
  await peerDiscovery.start();

  // Start validator (if enabled)
  if (cfg.validatorEnabled) {
    validator = new LocalValidator(
      hiveClient,
      peerDiscovery,
      pubsub,
      kuboManager.getApiUrl(),
      cfg.hiveUsername,
      cfg.challengeIntervalMs,
      !!postingKey // Only broadcast if posting key is available
    );
    await validator.start();
  }

  // Start auto-pinner for popular content (if enabled)
  if (cfg.autoPinPopular) {
    autoPinner = new AutoPinner(
      kuboManager.getApiUrl(),
      cfg.serverUrl,
      cfg.autoPinMaxGB
    );
    await autoPinner.start();
  }

  // Wire P2P modules to API server
  apiServer.setP2PModules(peerDiscovery, validator, challengeHandler);

  const peerCount = peerDiscovery.getPeerCount();
  updateTrayMenu(`Running (P2P — ${peerCount} peers)`);
  console.log(`[SPK] P2P mode initialized: ${peerCount} peers, validator=${cfg.validatorEnabled}`);
}

async function initializeLegacy(): Promise<void> {
  const cfg = configStore.getConfig();
  console.log('[SPK] Legacy mode: connecting to central server');

  agentWS = new AgentWSClient(kuboManager, configStore);
  apiServer.setAgentWS(agentWS);

  agentWS.on('connected', () => {
    updateTrayMenu('Running (Connected)');
  });
  agentWS.on('disconnected', () => {
    if (kuboManager.isRunning()) {
      updateTrayMenu('Running');
    }
  });

  // Connect after a short delay to let IPFS fully stabilize
  setTimeout(() => {
    agentWS!.connect();
  }, 2000);
}

async function initialize(): Promise<void> {
  console.log('[SPK] Initializing desktop agent...');

  configStore = new ConfigStore();
  kuboManager = new KuboManager(configStore);
  apiServer = new ApiServer(kuboManager, configStore);
  autoUpdater = new AutoUpdater();
  autoUpdater.setMainWindow(mainWindow);

  try {
    await kuboManager.start();
    updateTrayMenu('Running');
    console.log('[SPK] IPFS daemon started successfully');

    // Auto-restart Kubo if it crashes unexpectedly
    kuboManager.onExit(() => {
      console.log('[SPK] Kubo exited unexpectedly, attempting restart in 5s...');
      updateTrayMenu('IPFS Restarting...');
      setTimeout(async () => {
        try {
          await kuboManager.start();
          updateTrayMenu('Running');
          console.log('[SPK] Kubo restarted successfully');
        } catch (err) {
          console.error('[SPK] Kubo restart failed:', err);
          updateTrayMenu('IPFS Error');
        }
      }, 5000);
    });
  } catch (error) {
    console.error('[SPK] Failed to start IPFS:', error);
    updateTrayMenu('Error');
    dialog.showErrorBox('SPK Desktop Agent', `Failed to start IPFS: ${error}`);
  }

  try {
    await apiServer.start();
    console.log('[SPK] API server started on port 5111');
  } catch (error) {
    console.error('[SPK] Failed to start API server:', error);
  }

  // Choose mode: P2P (default) or Legacy
  const cfg = configStore.getConfig();
  if (cfg.p2pMode) {
    await initializeP2P();
  } else {
    await initializeLegacy();
  }

  // Auto-open Keychain login if no username configured (first launch experience)
  // Small delay so the API server is fully ready to serve the auth page
  if (!configStore.getConfig().hiveUsername) {
    setTimeout(() => {
      // Re-check in case the web app synced the username while we waited
      if (!configStore.getConfig().hiveUsername) {
        console.log('[SPK] No Hive username configured — opening Keychain auth in browser');
        const port = configStore.getConfig().apiPort || 5111;
        shell.openExternal(`http://127.0.0.1:${port}/auth/keychain`);
      }
    }, 3000);
    mainWindow?.show();
  }

  // Check for updates after startup
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 5000);
}

app.whenReady().then(async () => {
  // IPC handlers for secure renderer ↔ main communication
  ipcMain.handle('get-status', async () => {
    const peerId = await kuboManager?.getPeerId();
    const stats = await kuboManager?.getStats();
    return { running: kuboManager?.isRunning(), peerId, stats };
  });
  ipcMain.handle('get-config', () => configStore?.getConfig());
  ipcMain.handle('set-config', (_event, cfg) => {
    configStore?.setConfig(cfg);
    return configStore?.getConfig();
  });
  ipcMain.handle('get-earnings', () => configStore?.getEarnings());

  // New P2P-related IPC handlers
  ipcMain.handle('get-peers', () => peerDiscovery?.getAllPeers() || []);
  ipcMain.handle('get-validation-stats', () => validator?.getStats() || { issued: 0, passed: 0, failed: 0, timeouts: 0 });
  ipcMain.handle('has-posting-key', () => configStore?.hasPostingKey() || false);
  ipcMain.handle('set-posting-key', (_event, key: string) => {
    configStore?.setPostingKey(key);
    return true;
  });
  ipcMain.handle('clear-posting-key', () => {
    configStore?.clearPostingKey();
    return true;
  });
  ipcMain.handle('open-keychain-auth', async () => {
    const port = configStore?.getConfig().apiPort || 5111;
    await shell.openExternal(`http://127.0.0.1:${port}/auth/keychain`);
  });

  try {
    createTray();
    createWindow();
    await initialize();
  } catch (err: any) {
    console.error('[SPK] Init error:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on macOS
});

app.on('before-quit', async () => {
  console.log('[SPK] Shutting down...');

  // P2P cleanup
  autoPinner?.stop();
  validator?.stop();
  challengeHandler?.stop();
  peerDiscovery?.stop();
  await pubsub?.unsubscribeAll();

  // Legacy cleanup
  agentWS?.disconnect();

  await kuboManager?.stop();
  await apiServer?.stop();
  app.exit(0);
});
