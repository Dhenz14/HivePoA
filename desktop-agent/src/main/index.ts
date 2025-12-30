import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron';
import * as path from 'path';
import { KuboManager } from './kubo';
import { ApiServer } from './api';
import { ConfigStore } from './config';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let kuboManager: KuboManager;
let apiServer: ApiServer;
let configStore: ConfigStore;

const isDev = process.env.NODE_ENV === 'development';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  if (isDev) {
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
    { label: 'Open Web App', click: () => { require('electron').shell.openExternal('http://localhost:5000'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
}

async function initialize(): Promise<void> {
  console.log('[SPK] Initializing desktop agent...');

  configStore = new ConfigStore();
  kuboManager = new KuboManager(configStore);
  apiServer = new ApiServer(kuboManager, configStore);

  try {
    await kuboManager.start();
    updateTrayMenu('Running');
    console.log('[SPK] IPFS daemon started successfully');
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
}

app.whenReady().then(async () => {
  createTray();
  createWindow();
  await initialize();

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
  await kuboManager?.stop();
  await apiServer?.stop();
  app.exit(0);
});
