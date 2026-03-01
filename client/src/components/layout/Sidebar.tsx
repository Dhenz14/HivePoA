import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, HardDrive, Wallet, Server, Settings, Globe, Hexagon, Play, Wifi, Download, Coins, ShoppingBag, BarChart3, Shield, Zap, AlertTriangle, LogOut, FileText, Landmark, Users, Video, Key, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNodeConfig } from "@/contexts/NodeConfigContext";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

function CollapsibleGroup({ group, location }: { group: NavGroup; location: string }) {
  const hasActiveChild = group.items.some((item) => location === item.href);
  const [open, setOpen] = useState(hasActiveChild);

  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium w-full transition-all duration-200 text-muted-foreground hover:text-foreground hover:bg-accent/50"
      >
        <ChevronRight className={cn("w-3.5 h-3.5 transition-transform duration-200", open && "rotate-90")} />
        <span>{group.label}</span>
      </button>
      {open && (
        <div className="ml-3 pl-3 border-l border-border/40 space-y-0.5 mt-0.5">
          {group.items.map((item) => (
            <NavLink key={item.href} item={item} location={location} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavLink({ item, location }: { item: NavItem; location: string }) {
  const Icon = item.icon;
  const isActive = location === item.href;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-3 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 group",
        isActive
          ? "bg-primary/10 text-primary border-l-2 border-primary -ml-px"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
      {item.label}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-5 pb-1.5">
      <span className="px-3 text-[10px] font-bold text-muted-foreground/50 uppercase tracking-[0.15em]">
        {children}
      </span>
    </div>
  );
}

export function Sidebar() {
  const [location] = useLocation();
  const { config } = useNodeConfig();
  const { user, isAuthenticated, isValidator, logout } = useValidatorAuth();

  const navigateLinks: NavItem[] = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/browse", label: "Browse & Watch", icon: Play },
    { href: "/storage", label: "Storage", icon: HardDrive },
  ];

  const earnLinks: NavItem[] = [
    { href: "/earnings", label: "Earnings", icon: Coins },
    { href: "/encoding", label: "Encoding Jobs", icon: Video },
    { href: "/marketplace", label: "Marketplace", icon: ShoppingBag },
  ];

  const nodeGroup: NavGroup = {
    label: "Node Management",
    items: [
      { href: "/connect", label: "Connect Node", icon: Wifi },
      { href: "/node", label: "Node Status", icon: Server },
      { href: "/p2p-network", label: "P2P Network", icon: Users },
    ],
  };

  const walletGroup: NavGroup = {
    label: "Wallets",
    items: [
      { href: "/wallet", label: "My Wallet", icon: Wallet },
      { href: "/wallet-dashboard", label: "Network Treasury", icon: Landmark },
    ],
  };

  const validatorGroup: NavGroup = {
    label: "Validator Tools",
    items: [
      { href: "/validator-dashboard", label: "Validator Ops", icon: Shield },
      { href: "/challenge-queue", label: "Challenges", icon: Zap },
      { href: "/node-monitoring", label: "Node Monitor", icon: Server },
      { href: "/fraud-detection", label: "Fraud Detection", icon: AlertTriangle },
      { href: "/payout-generator", label: "Payout Reports", icon: FileText },
      { href: "/validators", label: "Validators", icon: Globe },
    ],
  };

  const systemLinks: NavItem[] = [
    { href: "/download", label: "Desktop Agent", icon: Download },
    { href: "/settings", label: "Settings", icon: Settings },
    { href: "/analytics", label: "Analytics", icon: BarChart3 },
  ];

  return (
    <div className="w-64 border-r border-white/6 bg-background/80 backdrop-blur-md h-screen flex flex-col relative">
      {/* Top gradient accent */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-linear-to-b from-primary/5 to-transparent pointer-events-none" />

      {/* Logo */}
      <div className="p-5 flex items-center gap-3 border-b border-white/6 relative">
        <div className="relative flex items-center justify-center w-9 h-9 bg-primary/10 rounded-xl text-primary glow-red">
          <Hexagon className="w-6 h-6 fill-primary/20" />
        </div>
        <div>
          <span className="font-display font-bold text-lg tracking-tight">HivePoA</span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="relative w-1.5 h-1.5 rounded-full bg-green-500">
              <span className="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-75" />
            </span>
            <span className="text-[9px] font-mono text-muted-foreground/70 uppercase tracking-wider">Hive Mainnet</span>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto relative">
        {/* Auth card */}
        {!isAuthenticated ? (
          <Link href="/validator-login" className="block mb-2" data-testid="link-validator-login">
            <div className="rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-all duration-300 p-3 cursor-pointer group hover:glow-red">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-lg bg-primary/20 text-primary">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <span className="text-sm font-semibold text-primary">Login with Keychain</span>
                  <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">Sign in to earn rewards</p>
                </div>
              </div>
            </div>
          </Link>
        ) : (
          <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-3 mb-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="relative w-2 h-2 rounded-full bg-green-500">
                  <span className="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-75" />
                </span>
                <span className="text-sm font-semibold text-foreground">@{user!.username}</span>
              </div>
              <button
                type="button"
                title="Logout"
                onClick={logout}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-white/5"
                data-testid="button-validator-logout"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
            {(user!.isTopWitness || user!.isVouched) && (
              <div className="mt-1.5">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/20 font-bold tracking-wide">
                  {user!.isTopWitness ? `WITNESS #${user!.witnessRank}` : "VOUCHED"}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Navigate */}
        <SectionLabel>Navigate</SectionLabel>
        {navigateLinks.map((item) => (
          <NavLink key={item.href} item={item} location={location} />
        ))}

        {/* Earn */}
        <SectionLabel>Earn</SectionLabel>
        {earnLinks.map((item) => (
          <NavLink key={item.href} item={item} location={location} />
        ))}

        {/* Network */}
        <SectionLabel>Network</SectionLabel>
        <CollapsibleGroup group={nodeGroup} location={location} />
        <CollapsibleGroup group={walletGroup} location={location} />

        {/* Validator */}
        {isValidator && (
          <>
            <SectionLabel>Validator</SectionLabel>
            <CollapsibleGroup group={validatorGroup} location={location} />
          </>
        )}

        {/* System */}
        <SectionLabel>System</SectionLabel>
        {systemLinks.map((item) => (
          <NavLink key={item.href} item={item} location={location} />
        ))}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/6">
        <div className="flex items-center gap-2.5 px-2 py-1.5 text-xs text-muted-foreground">
          <div className={cn(
            "w-2 h-2 rounded-full shrink-0",
            config.isConnected ? "bg-green-500" : "bg-yellow-500"
          )} />
          <span className="truncate">
            {config.mode === "demo"
              ? "Demo Mode"
              : config.isConnected
                ? "IPFS Connected"
                : "IPFS Disconnected"}
          </span>
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground/30 px-2 font-mono">
          v0.1.0-alpha
        </div>
      </div>
    </div>
  );
}
