import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Monitor, Apple, Terminal, CheckCircle2, Loader2, ExternalLink } from "lucide-react";

type Platform = "windows" | "macos" | "macos-arm" | "linux" | "unknown";

interface DownloadInfo {
  platform: Platform;
  label: string;
  icon: React.ReactNode;
  filename: string;
  description: string;
}

const DOWNLOADS: Record<Platform, DownloadInfo> = {
  windows: {
    platform: "windows",
    label: "Windows",
    icon: <Monitor className="h-6 w-6" />,
    filename: "SPK-Desktop_x64.msi",
    description: "Windows 10/11 (64-bit)",
  },
  macos: {
    platform: "macos",
    label: "macOS (Intel)",
    icon: <Apple className="h-6 w-6" />,
    filename: "SPK-Desktop_x64.dmg",
    description: "macOS 10.15+ (Intel)",
  },
  "macos-arm": {
    platform: "macos-arm",
    label: "macOS (Apple Silicon)",
    icon: <Apple className="h-6 w-6" />,
    filename: "SPK-Desktop_aarch64.dmg",
    description: "macOS 11+ (M1/M2/M3)",
  },
  linux: {
    platform: "linux",
    label: "Linux",
    icon: <Terminal className="h-6 w-6" />,
    filename: "spk-desktop_amd64.deb",
    description: "Ubuntu/Debian (64-bit)",
  },
  unknown: {
    platform: "unknown",
    label: "Unknown",
    icon: <Download className="h-6 w-6" />,
    filename: "",
    description: "",
  },
};

const GITHUB_RELEASES_URL = "https://github.com/spknetwork/spk-desktop/releases";
const GITHUB_REPO_URL = "https://github.com/spknetwork/spk-desktop";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator as any).userAgentData?.platform?.toLowerCase() || navigator.platform?.toLowerCase() || "";
  
  if (platform.includes("win") || ua.includes("windows")) {
    return "windows";
  }
  
  if (platform.includes("mac") || ua.includes("macintosh")) {
    if (ua.includes("arm") || (navigator as any).userAgentData?.architecture === "arm") {
      return "macos-arm";
    }
    return "macos";
  }
  
  if (platform.includes("linux") || ua.includes("linux")) {
    return "linux";
  }
  
  return "unknown";
}

function DownloadCard({ info, recommended, comingSoon }: { info: DownloadInfo; recommended: boolean; comingSoon?: boolean }) {
  const handleDownload = () => {
    window.open(GITHUB_RELEASES_URL, "_blank");
  };

  return (
    <Card 
      data-testid={`download-card-${info.platform}`}
      className={`relative transition-all hover:border-primary/50 ${recommended ? "border-primary ring-2 ring-primary/20" : ""}`}
    >
      {recommended && !comingSoon && (
        <Badge className="absolute -top-2 left-4 bg-primary">Recommended for you</Badge>
      )}
      {comingSoon && (
        <Badge className="absolute -top-2 left-4 bg-amber-500">Coming Soon</Badge>
      )}
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          {info.icon}
          <div>
            <CardTitle className="text-lg">{info.label}</CardTitle>
            <CardDescription>{info.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Button 
          data-testid={`download-button-${info.platform}`}
          onClick={handleDownload}
          className="w-full"
          variant={recommended && !comingSoon ? "default" : "outline"}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          View on GitHub
        </Button>
        {comingSoon && (
          <p className="text-xs text-muted-foreground mt-2 text-center">
            Desktop builds are in development. Star the repo to get notified!
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function DownloadPage() {
  const [detectedPlatform, setDetectedPlatform] = useState<Platform>("unknown");

  useEffect(() => {
    setDetectedPlatform(detectPlatform());
  }, []);

  const features = [
    "One-click install - IPFS auto-initializes",
    "Runs 24/7 in system tray",
    "Earn HBD rewards through Proof of Access",
    "Auto-detected by the web app",
    "No technical setup required",
  ];

  return (
    <div className="container max-w-4xl py-8 space-y-8">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">SPK Desktop Agent</h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
          Run a 24/7 IPFS node and earn HBD rewards. Download, install, and start earning.
        </p>
      </div>

      <Card className="bg-primary/5 border-primary/20">
        <CardContent className="pt-6">
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold mb-3">What you get:</h3>
              <ul className="space-y-2">
                {features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex flex-col justify-center items-center text-center">
              <div className="text-6xl mb-2">🌐</div>
              <p className="text-sm text-muted-foreground">
                Join thousands of nodes powering decentralized storage
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <h2 className="text-2xl font-semibold text-center">Download for your platform</h2>
        
        <div className="grid md:grid-cols-2 gap-4">
          {detectedPlatform !== "unknown" && (
            <DownloadCard 
              info={DOWNLOADS[detectedPlatform]} 
              recommended={true}
              comingSoon={true}
            />
          )}
          
          {Object.values(DOWNLOADS)
            .filter(d => d.platform !== "unknown" && d.platform !== detectedPlatform)
            .map(info => (
              <DownloadCard key={info.platform} info={info} recommended={false} comingSoon={true} />
            ))}
        </div>
      </div>

      <div className="text-center space-y-2">
        <a 
          href={GITHUB_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
          data-testid="link-all-releases"
        >
          View all releases on GitHub
          <ExternalLink className="h-3 w-3" />
        </a>
        <p className="text-xs text-muted-foreground">
          Open source under MIT license
        </p>
      </div>
    </div>
  );
}
