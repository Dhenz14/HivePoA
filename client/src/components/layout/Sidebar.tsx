import { Link, useLocation } from "wouter";
import { LayoutDashboard, HardDrive, Wallet, Server, Settings, Globe, Hexagon, Play, Wifi, Download, Coins, ShoppingBag, BarChart3, Shield, Zap, AlertTriangle, LogIn, LogOut, FileText, Landmark, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNodeConfig } from "@/contexts/NodeConfigContext";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

export function Sidebar() {
  const [location] = useLocation();
  const { config } = useNodeConfig();
  const { user, isAuthenticated, logout } = useValidatorAuth();

  const mainLinks = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/connect", label: "Connect Node", icon: Wifi },
    { href: "/storage", label: "Storage", icon: HardDrive },
    { href: "/browse", label: "Browse Network", icon: Play },
    { href: "/wallet", label: "Wallet", icon: Wallet },
    { href: "/wallet-dashboard", label: "Network Wallet", icon: Landmark },
    { href: "/p2p-network", label: "P2P Network", icon: Users },
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

        <div className="pt-4 pb-2">
          <div className="flex items-center justify-between px-3">
            <span className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
              Validator
            </span>
            {isAuthenticated && user && (
              <span className="text-xs text-primary font-medium">
                @{user.username}
              </span>
            )}
          </div>
        </div>
        
        {!isAuthenticated ? (
          <Link 
            href="/validator-login"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 group",
              location === "/validator-login"
                ? "bg-primary/10 text-primary" 
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
            data-testid="link-validator-login"
          >
            <LogIn className={cn("w-4 h-4", location === "/validator-login" ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
            Validator Login
          </Link>
        ) : (
          <>
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
            <button
              onClick={logout}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-200 group text-muted-foreground hover:text-foreground hover:bg-accent/50 w-full"
              data-testid="button-validator-logout"
            >
              <LogOut className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
              Logout
            </button>
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
