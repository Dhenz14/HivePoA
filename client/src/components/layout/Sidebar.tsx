import { Link, useLocation } from "wouter";
import { LayoutDashboard, HardDrive, Wallet, Server, Settings, Globe, Hexagon, Play, Wifi, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNodeConfig } from "@/contexts/NodeConfigContext";

export function Sidebar() {
  const [location] = useLocation();
  const { config } = useNodeConfig();

  const links = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/connect", label: "Connect Node", icon: Wifi },
    { href: "/storage", label: "Storage", icon: HardDrive },
    { href: "/browse", label: "Browse Network", icon: Play },
    { href: "/wallet", label: "Wallet", icon: Wallet },
    { href: "/node", label: "Node Status", icon: Server },
    { href: "/validators", label: "Validators", icon: Globe },
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

      <nav className="flex-1 p-4 space-y-1">
        {links.map((link) => {
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
