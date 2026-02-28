const API_URL = 'http://127.0.0.1:5111';

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiveUsername: username }),
    });

    // Save posting key if provided
    if (postingKey) {
      await fetch(`${API_URL}/api/hive/posting-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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

    // P2P Network status
    const networkDot = document.getElementById('networkDot');
    const networkText = document.getElementById('networkText');
    const peerCountEl = document.getElementById('peerCount');
    const validationsIssuedEl = document.getElementById('validationsIssued');

    if (status.network) {
      const net = status.network;
      if (peerCountEl) peerCountEl.textContent = net.peerCount.toString();
      if (validationsIssuedEl) validationsIssuedEl.textContent = net.validationStats.issued.toString();

      if (net.peerCount > 0) {
        networkDot?.classList.add('running');
        if (networkText) {
          networkText.textContent = `${net.peerCount} peer${net.peerCount !== 1 ? 's' : ''} discovered`;
        }
      } else if (net.hasPostingKey && status.config.hiveUsername) {
        networkDot?.classList.remove('running');
        if (networkText) networkText.textContent = 'Scanning for peers...';
      } else {
        networkDot?.classList.remove('running');
        if (networkText) networkText.textContent = 'Set Hive username & posting key to join network';
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveConfig')?.addEventListener('click', saveConfig);
  document.getElementById('saveBandwidth')?.addEventListener('click', saveBandwidth);
  document.getElementById('saveStorage')?.addEventListener('click', saveStorage);
  document.getElementById('saveValidation')?.addEventListener('click', saveValidation);

  updateUI();
  setInterval(updateUI, 5000);
});
