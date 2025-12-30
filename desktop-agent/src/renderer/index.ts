const API_URL = 'http://127.0.0.1:5111';

interface Status {
  running: boolean;
  peerId: string | null;
  stats: {
    repoSize: number;
    numObjects: number;
  } | null;
  hiveUsername: string | null;
  earnings: {
    totalHbd: number;
    challengesPassed: number;
    consecutivePasses: number;
  };
}

async function fetchStatus(): Promise<Status | null> {
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
  const username = usernameInput.value.trim();

  try {
    await fetch(`${API_URL}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiveUsername: username }),
    });
    alert('Configuration saved!');
  } catch (error) {
    alert('Failed to save configuration');
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

  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const peerIdEl = document.getElementById('peerId');
  const totalHbdEl = document.getElementById('totalHbd');
  const challengesPassedEl = document.getElementById('challengesPassed');
  const streakEl = document.getElementById('streak');
  const pinnedFilesEl = document.getElementById('pinnedFiles');
  const usernameInput = document.getElementById('hiveUsername') as HTMLInputElement;

  if (status) {
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

    if (totalHbdEl) {
      totalHbdEl.textContent = status.earnings.totalHbd.toFixed(3);
    }

    if (challengesPassedEl) {
      challengesPassedEl.textContent = status.earnings.challengesPassed.toString();
    }

    if (streakEl) {
      streakEl.textContent = status.earnings.consecutivePasses.toString();
    }

    if (status.hiveUsername && usernameInput) {
      usernameInput.value = status.hiveUsername;
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
  const saveButton = document.getElementById('saveConfig');
  saveButton?.addEventListener('click', saveConfig);

  updateUI();
  setInterval(updateUI, 5000);
});
