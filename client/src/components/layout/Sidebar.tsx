import { Link, useLocation } from "wouter";
import { LayoutDashboard, HardDrive, Wallet, Server, Settings, Globe, Hexagon, Play, Wifi, Download, Coins, ShoppingBag, BarChart3, Shield, Zap, AlertTriangle, LogOut, FileText, Landmark, Users, Video, Key } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNodeConfig } from "@/contexts/NodeConfigContext";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

export function Sidebar() {
  const [location] = useLocation();
  const { config } = useNodeConfig();
  const { user, isAuthenticated, isValidator, logout } = useValidatorAuth();

  const mainLinks = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/connect", label: "Connect Node", icon: Wifi },
    { href: "/storage", label: "Storage", icon: HardDrive },
    { href: "/browse", label: "Browse Network", icon: Play },
    { href: "/wallet", label: "Wallet", icon: Wallet },
    { href: "/wallet-dashboard", label: "Network Wallet", icon: Landmark },
    { href: "/p2p-network", label: "P2P Network", icon: Users },
    { href: "/encoding", label: "Encoding", icon: Video },
    { href: "/earnings", label: "Earnings", icon: Coins },
    { href: "/analytics", label: "Analytics", icon: BarChart3 },
    { href: "/marketplace", label: "Marketplace", icon: ShoppingBag },
    { href: "/node", label: "Node Status", icon: Server },
  ];

  const validatorLinks = [
    { href: "/validator-dashboard", label: "Validator Ops", icon: Shield },
    { href: "/challenge-queue", label: "Challenges", icon: Zap },
    { href: "/node-monitoring", label: "Node Monitor", icon: Server },
    { href: "/fraud-detection", label: "Fraud Detection", icon: AlertTriangle },
    { href: "/payout-generator", label: "Payout Reports", icon: FileText },
    { href: "/validators", label: "Validators", icon: Globe },
  ];

  const settingsLinks = [
    { href: "/download", label: "Desktop Agent", icon: Download },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="w-64 border-r border-border bg-sidebar h-screen flex flex-col">
      <div className="p-6 flex items-center gap-3 border-b border-border/40">
        <div className="relative flex items-center justify-center w-8 h-8 bg-primary/10 rounded-lg text-primary">
          <Hexagon className="w-6 h-6 fill-primary/20" />
        </div>
        <span className="font-display font-bold text-xl tracking-tight">HivePoA</span>
      </div>

      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {/* Login / User section at the top */}
        {!isAuthenticated ? (
          <Link
            href="/validator-login"
            className="block mb-3"
            data-testid="link-validator-login"
          >
            <div className="rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-all duration-200 p-3 space-y-2 cursor-pointer group">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-primary/20 text-primary">
                  <Key className="w-4 h-4" />
                </div>
                <span className="text-sm font-semibold text-primary">Login with Keychain</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Sign in with your Hive account to earn rewards
              </p>
            </div>
          </Link>
        ) : (
          <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3 mb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500" />
                <span className="text-sm font-semibold text-foreground">@{user!.username}</span>
              </div>
              <button
                type="button"
                title="Logout"
                onClick={logout}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-validator-logout"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
            {(user!.isTopWitness || user!.isVouched) && (
              <div className="mt-1.5 flex items-center gap-1">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/30 font-semibold">
                  {user!.isTopWitness ? `WITNESS #${user!.witnessRank}` : "VOUCHED"}
                </span>
              </div>
            )}
          </div>
        )}

        {mainLinks.map((link) => {
          const Icon = link.icon;
          const isActive = location === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 group",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <Icon className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
              {link.label}
            </Link>
          );
        })}

        {/* Validator section - only shown for witnesses/vouched users */}
        {isValidator && (
          <>
            <div className="pt-4 pb-2">
              <span className="px-3 text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
                Validator
              </span>
            </div>
            {validatorLinks.map((link) => {
              const Icon = link.icon;
              const isActive = location === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 group",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                >
                  <Icon className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                  {link.label}
                </Link>
              );
            })}
          </>
        )}

        <div className="pt-4 pb-2">
          <span className="px-3 text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
            System
          </span>
        </div>
        {settingsLinks.map((link) => {
          const Icon = link.icon;
          const isActive = location === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 group",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
            >
              <Icon className={cn("w-4 h-4", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-border/40">
        <div className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground">
          <div className={cn(
            "w-2 h-2 rounded-full",
            config.isConnected ? "bg-green-500 animate-pulse" : "bg-yellow-500"
          )} />
          <span>
            {config.mode === "demo"
              ? "Demo Mode"
              : config.isConnected
                ? "IPFS: Connected"
                : "IPFS: Disconnected"}
          </span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground/50 px-3 font-mono">
          v0.1.0-alpha
        </div>
      </div>
    </div>
  );
}
