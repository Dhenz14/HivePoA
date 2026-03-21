# GPU Connection UX — "5-Star Restaurant" Standard

## Design Principle

The user never searches for anything. Like a 5-star restaurant: the waiter greets you, shows you to your table, and everything you need is right there. No searching for forks, no reading manuals, no terminal commands.

**If the user has to open a terminal, we failed.**

## The Connection Flow (Grandma-Proof)

### Scenario 1: Same LAN (most common — gaming PCs at home)

```
Computer A opens HivePoA dashboard
    → Sees "Your GPU Pool" section
    → Status: "Scanning your network for GPUs..."
    → mDNS auto-discovers Computer B in 2-3 seconds
    → Popup: "Found: RTX 4070 SUPER (12GB) on your network. Add to pool?"
    → User clicks [Add]
    → Computer B gets a Windows notification: "DESKTOP-A wants to use your GPU. Allow?"
    → User clicks [Allow]
    → Done. Both GPUs in pool. No IPs, no codes, no typing.
```

### Scenario 2: Different Network (friend across town)

```
Computer A opens dashboard
    → Clicks "Invite GPU"
    → Gets a 6-character code: HIVE-7X4K
    → Texts the code to their friend

Computer B opens dashboard
    → Clicks "Contribute My GPU"
    → Enters code: HIVE-7X4K
    → Clicks [Join]
    → Connected. Relay handles everything.
```

### Scenario 3: Public Pool (anyone on Hive can contribute)

```
Computer A opens dashboard
    → Clicks "Open Pool to Community"
    → Pool listed on HivePoA marketplace
    → Anyone with a Hive account can join with one click
    → Auto-matched by region for best latency
```

## Firewall Handling — Zero Manual Steps

### Windows Firewall

When the Desktop Agent starts for the first time:
1. Agent calls `AddFirewallRule()` via Windows API
2. Windows shows its OWN popup: "Allow Spirit Bomb through firewall?"
3. User clicks [Allow]
4. Done. No PowerShell, no admin commands.

The agent triggers this popup — the user just clicks one button that Windows presents.

### Router/NAT

1. **UPnP first**: Agent sends UPnP request to router to open port. Works on 80%+ home routers. Silent, no user action.
2. **STUN/TURN fallback**: If UPnP fails, use STUN to discover public IP, TURN relay for NAT traversal. Like how video calls work (WebRTC).
3. **Never ask user to port-forward.** If direct fails, relay handles it.

### Corporate/University Networks

For restrictive networks where UPnP is blocked:
- Route everything through HTTPS relay on port 443 (always open)
- Slightly higher latency but always works
- User never knows the difference

## Auto-Detection Checklist

Everything below happens silently on first launch:

| Check | How | User Sees |
|-------|-----|-----------|
| GPU present? | nvidia-smi | "RTX 4070 Ti SUPER detected!" |
| Docker installed? | `docker --version` | If missing: "Installing Docker..." (auto-download + install) |
| Firewall open? | Test listen on port | If blocked: Windows popup appears, user clicks Allow |
| UPnP available? | UPnP discovery | Silent — opens port automatically |
| LAN peers? | mDNS broadcast | "Found 1 GPU on your network!" |
| Internet relay? | HTTPS ping to hivepoa.com | Silent — establishes relay tunnel |
| VRAM available? | nvidia-smi query | "14.2 GB available for AI" |
| Bandwidth? | Speed test to relay | "Your connection: 25 Mbps (good for Pool mode)" |

## What The User Actually Sees

### First Launch (takes 60 seconds)

```
┌─────────────────────────────────────────┐
│  🔍 Setting up Spirit Bomb...           │
│                                         │
│  ✅ GPU detected: RTX 4070 Ti SUPER     │
│  ✅ 14.2 GB VRAM available              │
│  ✅ Docker ready                        │
│  ✅ Firewall configured                 │
│  ✅ Network: 192.168.0.101 (LAN)        │
│  ⏳ Scanning for nearby GPUs...         │
│                                         │
│  Found: RTX 4070 SUPER (12GB) nearby!   │
│                                         │
│  [Add to Pool]    [Skip for now]        │
└─────────────────────────────────────────┘
```

### After Setup (the dashboard)

```
┌─────────────────────────────────────────┐
│  Spirit Bomb GPU Pool                   │
│                                         │
│  Pool Status: ● Online (Tier 2)         │
│  Total VRAM: 28 GB (2 GPUs)             │
│  Model: Decided by Hive-AI              │
│                                         │
│  Your GPUs:                             │
│  ├─ RTX 4070 Ti SUPER (16GB) ● Online   │
│  └─ RTX 4070 SUPER (12GB)    ● Online   │
│                                         │
│  Earnings Today: 0.42 HBD              │
│  Earnings Total: 12.85 HBD             │
│                                         │
│  [Invite GPU]  [Settings]  [Pause]      │
└─────────────────────────────────────────┘
```

## Technical Architecture

### mDNS Discovery (LAN)

```
Service name: _spiritbomb._tcp.local
TXT records:
  nodeId=gpu-computer-a-rtx4070ti
  vram=16
  gpu=RTX 4070 Ti SUPER
  pool=open
  version=1.0
```

Every Spirit Bomb node broadcasts this on the LAN. Other nodes see it instantly.

### Pool Code System (cross-network)

```
POST /api/pool/create
  → Returns: { code: "HIVE-7X4K", expiresIn: 300 }

POST /api/pool/join
  Body: { code: "HIVE-7X4K" }
  → Relay exchanges connection info
  → Returns: { poolId: "...", coordinatorIp: "...", status: "connected" }
```

Codes expire after 5 minutes. 6 characters = 2.1 billion combinations. No collisions.

### Relay Protocol

- WebSocket connection to hivepoa.com
- Both nodes connect outbound (no firewall issues)
- Relay forwards inference requests between nodes
- If both on same LAN, auto-upgrades to direct P2P after handshake
- Relay is just a matchmaker — actual GPU work is direct

## Implementation Priority

1. **mDNS auto-discovery** — covers the "2 PCs at home" case (most common)
2. **Pool codes** — covers the "friend across town" case
3. **UPnP port opening** — eliminates firewall friction
4. **WebSocket relay** — works through any network
5. **Hive blockchain matchmaker** — fully decentralized (future)
