const API_URL = 'http://127.0.0.1:5111';

// Auth token for mutation endpoints — fetched from main process via IPC on startup
let localAuthToken: string | null = null;

async function fetchAuthToken(): Promise<void> {
  try {
    localAuthToken = await (window as any).spkAgent?.getAuthToken() || null;
  } catch {
    localAuthToken = null;
  }
}

function mutationHeaders(): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (localAuthToken) {
    headers['Authorization'] = `Bearer ${localAuthToken}`;
  }
  return headers;
}

interface StatusResponse {
  running: boolean;
  peerId: string | null;
  stats: {
    repoSize: number;
    numObjects: number;
  } | null;
  storageInfo?: {
    usedBytes: number;
    maxBytes: number;
    usedFormatted: string;
    maxFormatted: string;
    percentage: number;
  };
  config: {
    hiveUsername: string | null;
    autoStart: boolean;
    bandwidthLimitUp: number;
    bandwidthLimitDown: number;
    storageMaxGB: number;
    serverUrl: string;
    p2pMode: boolean;
    validatorEnabled: boolean;
    challengeIntervalMs: number;
  };
  network: {
    p2pMode: boolean;
    peerCount: number;
    validatorEnabled: boolean;
    validationStats: {
      issued: number;
      passed: number;
      failed: number;
      timeouts: number;
    };
    hasPostingKey: boolean;
  };
  serverConnection: {
    connected: boolean;
    reconnectAttempts: number;
  };
  earnings: {
    totalHbd: number;
    challengesPassed: number;
    consecutivePasses: number;
  };
}

async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    const response = await fetch(`${API_URL}/api/status`);
    return await response.json();
  } catch (error) {
    console.error('Failed to fetch status:', error);
    return null;
  }
}

async function fetchPins(): Promise<string[]> {
  try {
    const response = await fetch(`${API_URL}/api/pins`);
    const data = await response.json();
    return data.pins || [];
  } catch {
    return [];
  }
}

async function saveConfig(): Promise<void> {
  const usernameInput = document.getElementById('hiveUsername') as HTMLInputElement;
  const postingKeyInput = document.getElementById('postingKey') as HTMLInputElement;
  const username = usernameInput.value.trim();
  const postingKey = postingKeyInput.value.trim();

  try {
    // Save username
    await fetch(`${API_URL}/api/config`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ hiveUsername: username }),
    });

    // Save posting key if provided
    if (postingKey) {
      await fetch(`${API_URL}/api/hive/posting-key`, {
        method: 'POST',
        headers: mutationHeaders(),
        body: JSON.stringify({ key: postingKey }),
      });
      postingKeyInput.value = ''; // Clear after saving
    }

    alert('Configuration saved! The agent will connect to the P2P network.');
  } catch (error) {
    alert('Failed to save configuration');
  }
}

async function saveBandwidth(): Promise<void> {
  const upInput = document.getElementById('bandwidthUp') as HTMLInputElement;
  const downInput = document.getElementById('bandwidthDown') as HTMLInputElement;
  const bandwidthLimitUp = parseInt(upInput.value) || 0;
  const bandwidthLimitDown = parseInt(downInput.value) || 0;

  try {
    const response = await fetch(`${API_URL}/api/config`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ bandwidthLimitUp, bandwidthLimitDown }),
    });
    const data = await response.json();
    if (!response.ok) {
      alert('Failed: ' + (data.error || 'Unknown error'));
    } else if (data.restartDeferred) {
      alert('Bandwidth limits saved! IPFS restart deferred (challenge in progress).');
    } else if (data.success) {
      alert('Bandwidth limits applied!');
    }
  } catch {
    alert('Failed to apply bandwidth limits');
  }
}

async function saveStorage(): Promise<void> {
  const input = document.getElementById('storageMaxGB') as HTMLInputElement;
  const storageMaxGB = parseInt(input.value) || 50;

  try {
    const response = await fetch(`${API_URL}/api/config`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ storageMaxGB }),
    });
    const data = await response.json();
    if (!response.ok) {
      alert('Failed: ' + (data.error || 'Unknown error'));
    } else if (data.restartDeferred) {
      alert('Storage limit saved! IPFS restart deferred (challenge in progress).');
    } else if (data.success) {
      alert('Storage limit applied!');
    }
  } catch {
    alert('Failed to apply storage limit');
  }
}

async function saveValidation(): Promise<void> {
  const enabledInput = document.getElementById('validatorEnabled') as HTMLInputElement;
  const intervalInput = document.getElementById('challengeInterval') as HTMLInputElement;
  const validatorEnabled = enabledInput.checked;
  const challengeIntervalMs = (parseInt(intervalInput.value) || 5) * 60000;

  try {
    await fetch(`${API_URL}/api/config`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ validatorEnabled, challengeIntervalMs }),
    });
    alert('Validation settings applied!');
  } catch {
    alert('Failed to apply validation settings');
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function updateUI(): Promise<void> {
  const status = await fetchStatus();
  const pins = await fetchPins();

  // IPFS status
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const peerIdEl = document.getElementById('peerId');
  const totalHbdEl = document.getElementById('totalHbd');
  const challengesPassedEl = document.getElementById('challengesPassed');
  const streakEl = document.getElementById('streak');
  const pinnedFilesEl = document.getElementById('pinnedFiles');
  const usernameInput = document.getElementById('hiveUsername') as HTMLInputElement;

  if (status) {
    // IPFS status dot
    if (status.running) {
      statusDot?.classList.add('running');
      if (statusText) statusText.textContent = 'IPFS Running';
    } else {
      statusDot?.classList.remove('running');
      if (statusText) statusText.textContent = 'IPFS Stopped';
    }

    if (peerIdEl) {
      peerIdEl.textContent = status.peerId
        ? `Peer ID: ${status.peerId}`
        : 'Peer ID: Not available';
    }

    // Earnings
    if (totalHbdEl) totalHbdEl.textContent = status.earnings.totalHbd.toFixed(3);
    if (challengesPassedEl) challengesPassedEl.textContent = status.earnings.challengesPassed.toString();
    if (streakEl) streakEl.textContent = status.earnings.consecutivePasses.toString();

    // Config fields (only update if not focused to avoid overwriting user input)
    if (status.config.hiveUsername && usernameInput && !usernameInput.matches(':focus')) {
      usernameInput.value = status.config.hiveUsername;
    }

    // Signed-in banner
    const signedInBanner = document.getElementById('signedInBanner');
    const signedInText = document.getElementById('signedInText');
    if (signedInBanner && signedInText) {
      if (status.config.hiveUsername) {
        signedInBanner.style.display = 'flex';
        signedInText.textContent = `Signed in as @${status.config.hiveUsername}`;
      } else {
        signedInBanner.style.display = 'none';
      }
    }

    // P2P Network status
    const networkDot = document.getElementById('networkDot');
    const networkText = document.getElementById('networkText');
    const peerCountEl = document.getElementById('peerCount');
    const validationsIssuedEl = document.getElementById('validationsIssued');

    if (status.network) {
      const net = status.network;
      if (peerCountEl) peerCountEl.textContent = net.peerCount.toString();
      if (validationsIssuedEl) validationsIssuedEl.textContent = net.validationStats.issued.toString();

      if (status.config.hiveUsername) {
        // User is signed in — always show green dot
        networkDot?.classList.add('running');
        if (net.peerCount > 0) {
          if (networkText) networkText.textContent = `@${status.config.hiveUsername} — ${net.peerCount} peer${net.peerCount !== 1 ? 's' : ''} connected`;
        } else if (net.hasPostingKey) {
          if (networkText) networkText.textContent = `@${status.config.hiveUsername} — Scanning for peers...`;
        } else {
          if (networkText) networkText.textContent = `@${status.config.hiveUsername} — Ready`;
        }
      } else {
        networkDot?.classList.remove('running');
        if (networkText) networkText.textContent = 'Sign in with Hive Keychain to get started';
      }

      // Posting key status
      const keyStatus = document.getElementById('keyStatus');
      if (keyStatus) {
        if (net.hasPostingKey) {
          keyStatus.textContent = 'Posting key saved (encrypted). Your node can broadcast to Hive.';
          keyStatus.style.color = '#00d4aa';
        } else {
          keyStatus.textContent = 'Your key is encrypted with OS-level security and never leaves your device.';
          keyStatus.style.color = '#666';
        }
      }
    }

    // Validation settings
    const validatorEnabledInput = document.getElementById('validatorEnabled') as HTMLInputElement;
    const challengeIntervalInput = document.getElementById('challengeInterval') as HTMLInputElement;
    if (validatorEnabledInput && !validatorEnabledInput.matches(':focus')) {
      validatorEnabledInput.checked = status.config.validatorEnabled;
    }
    if (challengeIntervalInput && !challengeIntervalInput.matches(':focus')) {
      challengeIntervalInput.value = Math.round(status.config.challengeIntervalMs / 60000).toString();
    }

    // Storage info
    const storageBar = document.getElementById('storageBar');
    const storageUsed = document.getElementById('storageUsed');
    const storageMax = document.getElementById('storageMax');
    const storageInput = document.getElementById('storageMaxGB') as HTMLInputElement;

    if (status.storageInfo) {
      const info = status.storageInfo;
      if (storageBar) {
        storageBar.style.width = `${Math.min(100, info.percentage)}%`;
        storageBar.className = 'storage-bar' + (info.percentage > 90 ? ' critical' : info.percentage > 75 ? ' warning' : '');
      }
      if (storageUsed) storageUsed.textContent = `${info.usedFormatted} used`;
      if (storageMax) storageMax.textContent = `${info.maxFormatted} limit`;
    }
    if (storageInput && !storageInput.matches(':focus')) {
      storageInput.value = status.config.storageMaxGB?.toString() || '50';
    }

    // Bandwidth
    const bandwidthUpInput = document.getElementById('bandwidthUp') as HTMLInputElement;
    const bandwidthDownInput = document.getElementById('bandwidthDown') as HTMLInputElement;
    if (bandwidthUpInput && !bandwidthUpInput.matches(':focus')) {
      bandwidthUpInput.value = status.config.bandwidthLimitUp?.toString() || '0';
    }
    if (bandwidthDownInput && !bandwidthDownInput.matches(':focus')) {
      bandwidthDownInput.value = status.config.bandwidthLimitDown?.toString() || '0';
    }
  } else {
    statusDot?.classList.remove('running');
    if (statusText) statusText.textContent = 'Connecting...';
    if (peerIdEl) peerIdEl.textContent = 'Unable to connect to agent';
  }

  if (pinnedFilesEl) {
    pinnedFilesEl.textContent = pins.length.toString();
  }
}

async function keychainLogin(): Promise<void> {
  const btn = document.getElementById('keychainLogin') as HTMLButtonElement;
  const statusEl = document.getElementById('keychainAuthStatus');
  btn.disabled = true;
  btn.textContent = 'Opening browser...';

  try {
    await (window as any).spkAgent.openKeychainAuth();
  } catch {
    btn.disabled = false;
    btn.textContent = 'Login with Hive Keychain';
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.borderColor = 'rgba(255,107,107,0.3)';
      statusEl.style.color = '#ff6b6b';
      statusEl.textContent = 'Failed to open browser.';
    }
    return;
  }

  // Poll for auth completion (every 2s for up to 2 minutes)
  btn.textContent = 'Waiting for sign-in...';
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.borderColor = 'rgba(116,185,255,0.3)';
    statusEl.style.color = '#74b9ff';
    statusEl.textContent = 'Complete the sign-in in your browser, then return here.';
  }

  let attempts = 0;
  const pollInterval = setInterval(async () => {
    attempts++;
    if (attempts > 60) { // 2 minutes
      clearInterval(pollInterval);
      btn.disabled = false;
      btn.textContent = 'Login with Hive Keychain';
      if (statusEl) {
        statusEl.style.color = '#ff6b6b';
        statusEl.style.borderColor = 'rgba(255,107,107,0.3)';
        statusEl.textContent = 'Timed out. Try again.';
      }
      return;
    }

    const status = await fetchStatus();
    if (status?.config?.hiveUsername) {
      clearInterval(pollInterval);
      btn.disabled = false;
      btn.textContent = 'Login with Hive Keychain';
      if (statusEl) {
        statusEl.style.color = '#00d4aa';
        statusEl.style.borderColor = 'rgba(0,212,170,0.3)';
        statusEl.textContent = `Signed in as @${status.config.hiveUsername}`;
      }
      updateUI();
    }
  }, 2000);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Fetch auth token from main process before any mutation calls
  await fetchAuthToken();

  document.getElementById('saveConfig')?.addEventListener('click', saveConfig);
  document.getElementById('saveBandwidth')?.addEventListener('click', saveBandwidth);
  document.getElementById('saveStorage')?.addEventListener('click', saveStorage);
  document.getElementById('saveValidation')?.addEventListener('click', saveValidation);
  document.getElementById('keychainLogin')?.addEventListener('click', keychainLogin);

  updateUI();
  setInterval(updateUI, 5000);
});
