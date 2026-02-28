import { useBackendMode } from "@/hooks/use-backend-mode";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Loader2, Wifi, WifiOff } from "lucide-react";
import { Link } from "wouter";

interface AgentRequiredProps {
  children: React.ReactNode;
  /** If true, this page needs a full server (not just the desktop agent) */
  serverOnly?: boolean;
}

export function AgentRequired({ children, serverOnly }: AgentRequiredProps) {
  const { mode, isReady } = useBackendMode();

  if (!isReady) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Full server or agent available — render normally
  if (mode === "server" || (mode === "agent" && !serverOnly)) {
    return <>{children}</>;
  }

  // Agent available but page needs full server
  if (mode === "agent" && serverOnly) {
    return (
      <div className="container max-w-lg py-16">
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-6 pb-5 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-500/10 text-amber-500 mx-auto">
              <Wifi className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-semibold">Server Deployment Required</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              This feature requires a full HivePoA server deployment with database access.
              It is not available in desktop agent mode.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Standalone — no backend at all
  return (
    <div className="container max-w-lg py-16">
      <Card className="border-primary/30 bg-primary/5">
        <CardContent className="pt-6 pb-5 text-center space-y-4">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 text-primary mx-auto">
            <WifiOff className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-semibold">Desktop Agent Required</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This feature requires the SPK Desktop Agent running on your computer.
            The agent runs an IPFS node and connects you to the P2P network.
          </p>
          <Link href="/download">
            <Button className="mt-2">
              <Download className="mr-2 h-4 w-4" />
              Download Desktop Agent
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
