import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell, Notification } from 'electron';
import * as path from 'path';
import { KuboManager } from './kubo';
import { ApiServer } from './api';
import { ConfigStore } from './config';
import { AutoUpdater } from './updater';
import { AgentWSClient } from './agent-ws';
import { AgentHiveClient } from './hive';
import { PeerDiscovery } from './peer-discovery';
import { PubSubBridge } from './pubsub';
import { ChallengeHandler, ChallengeMessage, ChallengeResponse, CommitmentRequest, CommitmentResponse } from './challenge-handler';
import { LocalValidator } from './validator';
import { AutoPinner } from './auto-pinner';
import { TreasurySigner } from './treasury-signer';
import { WalletManager } from './wallet-manager';
import { initializeFullServer, shutdownFullServer } from './server-init';
import { GpuContributionManager } from './gpu-contribution';
import { createGpuRoutes } from './gpu-api';

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
let walletManager: WalletManager;
let gpuManager: GpuContributionManager | null = null;

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

  const gpuState = gpuManager ? (gpuManager as any).state as string : 'stopped';
  const gpuRunning = gpuState === 'running';
  const gpuPaused = gpuState === 'paused' || gpuState === 'gaming_mode';
  const gpuStopped = gpuState === 'stopped' || gpuState === 'error';

  const gpuLabels: Record<string, string> = {
    running: 'GPU: Contributing',
    paused: 'GPU: Paused',
    gaming_mode: 'GPU: Gaming Mode',
    starting: 'GPU: Starting...',
    draining: 'GPU: Draining...',
    error: 'GPU: Error',
    stopped: 'GPU: Stopped',
    checking_deps: 'GPU: Checking...',
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: `Status: ${status}`, enabled: false },
    { label: gpuLabels[gpuState] || 'GPU: Unknown', enabled: false },
    { type: 'separator' },
  ];

  // GPU control actions
  if (gpuStopped) {
    template.push({
      label: 'Start GPU',
      click: () => { gpuManager?.start().catch(() => {}); },
    });
  }
  if (gpuRunning) {
    template.push(
      { label: 'Pause GPU', click: () => { gpuManager?.pause().catch(() => {}); } },
      { label: 'Gaming Mode', click: () => { gpuManager?.enterGamingMode().catch(() => {}); } },
    );
  }
  if (gpuPaused) {
    template.push({
      label: 'Resume GPU',
      click: () => { gpuManager?.resume().catch(() => {}); },
    });
  }
  if (gpuRunning || gpuPaused) {
    template.push({
      label: 'Stop GPU',
      click: () => { gpuManager?.stop().catch(() => {}); },
    });
  }

  template.push(
    { type: 'separator' },
    { label: 'Show Dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Check for Updates', click: () => { autoUpdater?.checkForUpdates(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  );

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);

  // Update tooltip with earnings if available
  const tooltip = gpuRunning ? `Spirit Bomb — ${status} | GPU Active` : `Spirit Bomb — ${status}`;
  tray.setToolTip(tooltip);
}

async function initializeP2P(): Promise<void> {
  const cfg = configStore.getConfig();

  if (!cfg.hiveUsername) {
    console.log('[SPK] P2P mode: no Hive username configured, running in standalone mode');
    updateTrayMenu('Running (Standalone)');
    return;
  }

  // SECURITY: Use on-demand key retrieval — plaintext key only exists in memory briefly
  // during signing/broadcasting, not permanently held in the AgentHiveClient instance
  const hasKey = configStore.hasPostingKey();

  // Initialize Hive client with on-demand key callback
  hiveClient = new AgentHiveClient({
    username: cfg.hiveUsername,
    getPostingKey: () => walletManager.getPostingKey(),
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
    kuboManager.getApiUrl(), pubsub, cfg.hiveUsername, configStore, hiveClient
  );

  // Subscribe to challenge topic (handles both v1 and v2 protocol messages)
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
      hasKey, // Only broadcast if posting key is available
      cfg.requireSignedMessages
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

  // Initialize treasury signer if wallet has an active key
  if (walletManager.isInitialized() && walletManager.hasActiveKey()) {
    const treasurySigner = new TreasurySigner(configStore, walletManager);
    agentWS.setTreasurySigner(treasurySigner);
    console.log('[SPK] Treasury signer initialized — auto-signing enabled');
  }

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

  // Initialize encrypted wallet for key management
  walletManager = new WalletManager();
  const walletDir = path.join(require('os').homedir(), '.spk-ipfs', 'wallet');
  const walletPassword = configStore.getWalletPassword();
  if (walletPassword) {
    try {
      await walletManager.init(walletDir, walletPassword);
      console.log('[SPK] Wallet unlocked —', walletManager.hasActiveKey() ? 'active key loaded' : 'no active key');
    } catch (err: any) {
      console.error('[SPK] Failed to unlock wallet:', err.message);
    }
  } else {
    console.log('[SPK] No wallet password configured — wallet not initialized');
  }

  kuboManager = new KuboManager(configStore);
  apiServer = new ApiServer(kuboManager, configStore, walletManager);
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

    // Initialize the full server backend (SQLite + 154 endpoints)
    // Agent-specific routes are already mounted and take priority
    const httpServer = apiServer.getHttpServer();
    const expressApp = apiServer.getExpressApp();
    if (httpServer && expressApp) {
      try {
        await initializeFullServer(httpServer, expressApp);
        console.log('[SPK] Full server backend ready — one-stop-shop mode active');
      } catch (err: any) {
        console.error('[SPK] Full server init failed (agent-only endpoints still work):', err.message);
      }
    }
  } catch (error) {
    console.error('[SPK] Failed to start API server:', error);
  }

  // Initialize GPU Contribution Manager (Spirit Bomb)
  const gpuCfg = configStore.getConfig();
  gpuManager = new GpuContributionManager({
    enabled: gpuCfg.gpuContributionEnabled,
    mode: gpuCfg.gpuContributionMode,
    vramUtilization: gpuCfg.gpuVramUtilization,
    model: gpuCfg.gpuModel,
    maxModelLen: gpuCfg.gpuMaxModelLen,
    autoGamingMode: gpuCfg.gpuAutoGamingMode,
    scheduleEnabled: gpuCfg.gpuScheduleEnabled,
    scheduleStart: gpuCfg.gpuScheduleStart,
    scheduleEnd: gpuCfg.gpuScheduleEnd,
    hivePoaUrl: gpuCfg.serverUrl,
    hiveUsername: gpuCfg.hiveUsername,
    lendTargetIp: gpuCfg.gpuLendTargetIp,
  });

  // Mount GPU API routes
  const expressApp = apiServer.getExpressApp();
  if (expressApp) {
    expressApp.use('/api/gpu', createGpuRoutes(gpuManager));
    console.log('[SPK] GPU API routes mounted at /api/gpu/*');
  }

  // Wire GPU notifications → Electron system notifications + tray updates
  gpuManager.on('notification', (data: { type: string; message: string }) => {
    console.log(`[GPU] ${data.type}: ${data.message}`);

    if (Notification.isSupported()) {
      const notif = new Notification({
        title: 'Spirit Bomb',
        body: data.message,
        icon: path.join(__dirname, '../../assets/icon.png'),
      });
      notif.show();
    }

    // Forward to renderer
    mainWindow?.webContents.send('gpu-notification', data);
  });

  gpuManager.on('state-change', ({ from, to }: { from: string; to: string }) => {
    console.log(`[GPU] State: ${from} → ${to}`);
    updateTrayMenu(kuboManager?.isRunning() ? 'Running' : 'Stopped');

    // Notify renderer of state change
    mainWindow?.webContents.send('gpu-state-change', { from, to });

    // Milestone notifications
    if (to === 'running' && from === 'starting') {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Spirit Bomb',
          body: 'GPU is live and earning! Your GPU is now serving the community.',
          icon: path.join(__dirname, '../../assets/icon.png'),
        }).show();
      }
    }
  });

  gpuManager.on('metrics', (metrics: any) => {
    // Temperature warning at 85°C
    if (metrics.temperatureC >= 85) {
      if (Notification.isSupported()) {
        new Notification({
          title: 'Spirit Bomb — Temperature Warning',
          body: `GPU temperature is ${metrics.temperatureC}°C. Consider pausing contribution.`,
          icon: path.join(__dirname, '../../assets/icon.png'),
        }).show();
      }
    }
  });

  // Start schedule checker if schedule is enabled
  if (gpuCfg.gpuScheduleEnabled) {
    gpuManager.startScheduleChecker();
    console.log(`[SPK] GPU schedule active: ${gpuCfg.gpuScheduleStart} — ${gpuCfg.gpuScheduleEnd}`);
  }

  // Auto-start GPU if enabled and no schedule (or within schedule window)
  if (gpuCfg.gpuContributionEnabled && (!gpuCfg.gpuScheduleEnabled || gpuManager.isWithinSchedule())) {
    console.log('[SPK] Auto-starting GPU contribution...');
    gpuManager.start().catch((err: any) => {
      console.error('[SPK] GPU auto-start failed:', err.message);
    });
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

  // SECURITY: Expose local auth token to renderer via IPC (required for mutation endpoints)
  ipcMain.handle('get-api-auth-token', () => apiServer?.getAuthToken());

  // GPU Contribution IPC handlers
  ipcMain.handle('gpu-get-status', async () => gpuManager?.getStatus() || null);
  ipcMain.handle('gpu-start', async () => { await gpuManager?.start(); return true; });
  ipcMain.handle('gpu-stop', async () => { await gpuManager?.stop(); return true; });
  ipcMain.handle('gpu-pause', async () => { await gpuManager?.pause(); return true; });
  ipcMain.handle('gpu-resume', async () => { await gpuManager?.resume(); return true; });
  ipcMain.handle('gpu-gaming-mode', async () => { await gpuManager?.enterGamingMode(); return true; });
  ipcMain.handle('gpu-update-config', async (_event, updates) => {
    gpuManager?.updateConfig(updates);
    // Also persist to config store
    const mappings: Record<string, string> = {
      vramUtilization: 'gpuVramUtilization',
      scheduleEnabled: 'gpuScheduleEnabled',
      scheduleStart: 'gpuScheduleStart',
      scheduleEnd: 'gpuScheduleEnd',
      autoGamingMode: 'gpuAutoGamingMode',
      mode: 'gpuContributionMode',
      model: 'gpuModel',
      maxModelLen: 'gpuMaxModelLen',
    };
    const persistUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (mappings[key]) persistUpdates[mappings[key]] = value;
    }
    if (Object.keys(persistUpdates).length > 0) {
      configStore?.setConfig(persistUpdates as any);
    }
    return true;
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

  // GPU cleanup
  gpuManager?.destroy();

  // Legacy cleanup
  agentWS?.disconnect();

  // Close SQLite database
  shutdownFullServer();

  await kuboManager?.stop();
  await apiServer?.stop();
  app.exit(0);
});
