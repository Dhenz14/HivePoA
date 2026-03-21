/**
 * firewall-manager.ts — Cross-platform firewall port management
 *
 * Opens ports for Spirit Bomb services on:
 *   - Windows: netsh advfirewall (triggers UAC popup)
 *   - macOS: socketfilterfw (triggers system Allow prompt)
 *   - Linux: ufw / firewall-cmd / iptables
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

const SPIRIT_BOMB_PORTS = {
  inference: 11435,   // llama-server
  ollama: 11434,      // Ollama
  agent: 5111,        // Desktop agent API
  hivepoa: 5000,      // HivePoA coordinator
};

export interface FirewallResult {
  success: boolean;
  portsOpened: number[];
  method: string;
  userActionRequired?: string;
}

/**
 * Open all Spirit Bomb ports on the local firewall.
 * Returns which ports were opened and if user action is needed.
 */
export async function openFirewallPorts(): Promise<FirewallResult> {
  const platform = os.platform();
  const ports = Object.values(SPIRIT_BOMB_PORTS);

  switch (platform) {
    case 'win32': return openWindowsFirewall(ports);
    case 'darwin': return openMacFirewall(ports);
    case 'linux': return openLinuxFirewall(ports);
    default: return { success: false, portsOpened: [], method: 'unsupported', userActionRequired: `Unsupported platform: ${platform}` };
  }
}

/**
 * Check if a specific port is open (listening allowed).
 */
export async function isPortOpen(port: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      os.platform() === 'win32'
        ? `netstat -ano | findstr ":${port} "`
        : `ss -tln | grep ":${port} "`,
      { timeout: 5000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Windows ────────────────────────────────────────────────────

async function openWindowsFirewall(ports: number[]): Promise<FirewallResult> {
  const opened: number[] = [];
  const ruleName = 'SpiritBomb';

  try {
    // Single rule for all ports
    const portList = ports.join(',');
    await execAsync(
      `powershell -Command "Start-Process powershell -ArgumentList '-Command', 'netsh advfirewall firewall add rule name=${ruleName} dir=in action=allow protocol=tcp localport=${portList}; netsh advfirewall firewall add rule name=${ruleName}-ICMP protocol=icmpv4 dir=in action=allow' -Verb RunAs -Wait"`,
      { timeout: 30000 }
    );
    opened.push(...ports);
  } catch {
    // UAC was denied or failed
    return {
      success: false,
      portsOpened: [],
      method: 'netsh (UAC)',
      userActionRequired: 'Click "Yes" on the Windows admin prompt to allow Spirit Bomb through the firewall.',
    };
  }

  return { success: opened.length > 0, portsOpened: opened, method: 'netsh advfirewall' };
}

// ── macOS ──────────────────────────────────────────────────────

async function openMacFirewall(ports: number[]): Promise<FirewallResult> {
  const opened: number[] = [];

  // macOS app-level firewall allows apps, not ports.
  // When llama-server or node starts listening, macOS shows
  // "Do you want to allow incoming network connections?" automatically.
  // We just need to ensure the firewall is aware of our binary.

  try {
    // Check if firewall is enabled
    const { stdout } = await execAsync('defaults read /Library/Preferences/com.apple.alf globalstate', { timeout: 5000 });
    const state = parseInt(stdout.trim());

    if (state === 0) {
      // Firewall is off — all ports are open
      return { success: true, portsOpened: ports, method: 'macos (firewall disabled)' };
    }

    // Firewall is on — macOS will prompt when the app first listens.
    // We can pre-authorize with socketfilterfw (requires sudo)
    const binaryPaths = [
      '/usr/local/bin/llama-server',
      '/opt/homebrew/bin/ollama',
      process.execPath, // Node.js binary
    ];

    for (const binary of binaryPaths) {
      try {
        await execAsync(`sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "${binary}" --unblockapp "${binary}"`, { timeout: 5000 });
      } catch {
        // sudo failed — macOS will prompt the user when the app listens
      }
    }

    opened.push(...ports);
    return {
      success: true,
      portsOpened: opened,
      method: 'macos socketfilterfw',
      userActionRequired: 'If macOS asks "Allow incoming connections?", click Allow.',
    };
  } catch {
    return {
      success: true,
      portsOpened: ports,
      method: 'macos (auto)',
      userActionRequired: 'If macOS asks "Allow incoming connections?", click Allow.',
    };
  }
}

// ── Linux ──────────────────────────────────────────────────────

async function openLinuxFirewall(ports: number[]): Promise<FirewallResult> {
  const opened: number[] = [];

  // Try ufw first (Ubuntu/Debian)
  try {
    const { stdout } = await execAsync('ufw status', { timeout: 5000 });
    if (stdout.includes('inactive')) {
      // Firewall is off — all ports open
      return { success: true, portsOpened: ports, method: 'ufw (inactive)' };
    }

    for (const port of ports) {
      try {
        await execAsync(`sudo ufw allow ${port}/tcp`, { timeout: 5000 });
        opened.push(port);
      } catch { /* may need sudo password */ }
    }

    if (opened.length > 0) {
      return { success: true, portsOpened: opened, method: 'ufw' };
    }
  } catch { /* ufw not installed */ }

  // Try firewall-cmd (Fedora/CentOS/RHEL)
  try {
    for (const port of ports) {
      try {
        await execAsync(`sudo firewall-cmd --permanent --add-port=${port}/tcp`, { timeout: 5000 });
        opened.push(port);
      } catch { /* may need sudo */ }
    }
    if (opened.length > 0) {
      await execAsync('sudo firewall-cmd --reload', { timeout: 5000 });
      return { success: true, portsOpened: opened, method: 'firewall-cmd' };
    }
  } catch { /* firewalld not installed */ }

  // No firewall detected — common on desktop Linux
  return {
    success: true,
    portsOpened: ports,
    method: 'linux (no firewall detected)',
  };
}
