import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, Monitor, Apple, Terminal, CheckCircle2, Loader2, HardDrive, Shield, Zap, Clock } from "lucide-react";

const GITHUB_REPO = "Dhenz14/HivePoA";

type Platform = "windows" | "macos" | "macos-arm" | "linux" | "unknown";

interface PlatformInfo {
  platform: Platform;
  label: string;
  icon: React.ReactNode;
  patterns: string[];
  description: string;
  installSteps: string[];
}

const PLATFORMS: Record<Exclude<Platform, "unknown">, PlatformInfo> = {
  windows: {
    platform: "windows",
    label: "Windows",
    icon: <Monitor className="h-8 w-8" />,
    patterns: ["setup", ".exe"],
    description: "Windows 10/11 (64-bit)",
    installSteps: [
      "Run the downloaded .exe installer",
      "Click \"Install\" when prompted",
      "The app appears in your system tray",
      "Enter your Hive username and posting key to join the P2P network",
    ],
  },
  macos: {
    platform: "macos",
    label: "macOS (Intel)",
    icon: <Apple className="h-8 w-8" />,
    patterns: [".dmg", "mac.tar.gz", "mac.zip"],
    description: "macOS 10.15+ (Intel)",
    installSteps: [
      "Open the downloaded .dmg file",
      "Drag the app to Applications",
      "Launch from Applications folder",
      "Look for the icon in your menu bar",
    ],
  },
  "macos-arm": {
    platform: "macos-arm",
    label: "macOS (Apple Silicon)",
    icon: <Apple className="h-8 w-8" />,
    patterns: ["arm64.dmg", "arm.dmg", "arm64.tar.gz"],
    description: "macOS 11+ (M1/M2/M3/M4)",
    installSteps: [
      "Open the downloaded .dmg file",
      "Drag the app to Applications",
      "Launch from Applications folder",
      "Look for the icon in your menu bar",
    ],
  },
  linux: {
    platform: "linux",
    label: "Linux",
    icon: <Terminal className="h-8 w-8" />,
    patterns: [".AppImage", ".deb", "linux.tar.gz"],
    description: "Linux (64-bit)",
    installSteps: [
      "Make the file executable: chmod +x",
      "Double-click the AppImage to run",
      "Or install the .deb package",
      "Look for the icon in your system tray",
    ],
  },
};

interface DownloadFile {
  name: string;
  size: number;
  sizeFormatted: string;
  url: string;
}

interface DownloadListResponse {
  files: DownloadFile[];
  version: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function fetchFromGitHubReleases(): Promise<DownloadListResponse> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) return { files: [], version: null };

  const release = await res.json();
  const version = (release.tag_name || release.name || "").replace(/^v/, "");
  const files: DownloadFile[] = (release.assets || [])
    .filter((a: any) => !a.name.endsWith(".blockmap") && !a.name.endsWith(".yml"))
    .map((a: any) => ({
      name: a.name,
      size: a.size,
      sizeFormatted: formatBytes(a.size),
      url: a.browser_download_url,
    }));
  return { files, version: version || null };
}

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";

  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator as any).userAgentData?.platform?.toLowerCase() || navigator.platform?.toLowerCase() || "";

  if (platform.includes("win") || ua.includes("windows")) return "windows";

  if (platform.includes("mac") || ua.includes("macintosh")) {
    if (ua.includes("arm") || (navigator as any).userAgentData?.architecture === "arm") {
      return "macos-arm";
    }
    return "macos";
  }

  if (platform.includes("linux") || ua.includes("linux")) return "linux";

  return "unknown";
}

function findFileForPlatform(files: DownloadFile[], info: PlatformInfo): DownloadFile | null {
  for (const pattern of info.patterns) {
    const file = files.find(f => f.name.toLowerCase().includes(pattern.toLowerCase()));
    if (file) return file;
  }
  return null;
}

function findPortableFile(files: DownloadFile[]): DownloadFile | null {
  return files.find(f => f.name.toLowerCase().includes("portable") && f.name.toLowerCase().endsWith(".exe")) || null;
}

function PlatformDownloadCard({
  info,
  file,
  altFile,
  recommended,
  expanded,
  onToggle,
}: {
  info: PlatformInfo;
  file: DownloadFile | null;
  altFile?: DownloadFile | null;
  recommended: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Card
      className={`relative transition-all duration-200 hover:shadow-lg ${
        recommended
          ? "border-primary ring-2 ring-primary/20 shadow-md"
          : "hover:border-primary/40"
      }`}
    >
      {recommended && (
        <Badge className="absolute -top-2.5 left-4 bg-primary text-primary-foreground shadow-sm">
          Detected — your platform
        </Badge>
      )}
      <CardHeader className="pb-3">
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-xl ${recommended ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
            {info.icon}
          </div>
          <div className="flex-1">
            <CardTitle className="text-xl">{info.label}</CardTitle>
            <CardDescription className="text-sm">
              {info.description}
              {file && <span className="ml-2 font-medium">({file.sizeFormatted})</span>}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {file ? (
          <a href={file.url} download className="block">
            <Button
              className="w-full h-12 text-base font-semibold"
              variant={recommended ? "default" : "outline"}
              size="lg"
            >
              <Download className="mr-2 h-5 w-5" />
              Download {info.label}
            </Button>
          </a>
        ) : (
          <Button className="w-full h-12" variant="outline" size="lg" disabled>
            Not available yet
          </Button>
        )}

        {altFile && (
          <a href={altFile.url} download className="block">
            <Button
              className="w-full h-9 text-sm"
              variant="ghost"
              size="sm"
            >
              <Download className="mr-2 h-4 w-4" />
              Portable version ({altFile.sizeFormatted}) — no install needed
            </Button>
          </a>
        )}

        <button
          type="button"
          onClick={onToggle}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-center"
        >
          {expanded ? "Hide" : "Show"} install instructions
        </button>

        {expanded && (
          <ol className="space-y-1.5 text-sm text-muted-foreground pl-1">
            {info.installSteps.map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-muted text-xs font-medium shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export default function DownloadPage() {
  const [detectedPlatform, setDetectedPlatform] = useState<Platform>("unknown");
  const [downloads, setDownloads] = useState<DownloadListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedPlatform, setExpandedPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    setDetectedPlatform(detectPlatform());

    fetchFromGitHubReleases()
      .then(data => {
        setDownloads(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to fetch downloads:", err);
        setDownloads({ files: [], version: null });
        setLoading(false);
      });
  }, []);

  const features = [
    {
      icon: <Zap className="h-5 w-5" />,
      title: "Earn HBD Rewards",
      description: "Automatically earn Hive-Backed Dollars by storing and serving content through Proof of Access challenges.",
    },
    {
      icon: <HardDrive className="h-5 w-5" />,
      title: "Bundled IPFS Node",
      description: "No setup required — the agent includes a fully configured IPFS daemon that starts automatically.",
    },
    {
      icon: <Shield className="h-5 w-5" />,
      title: "Configurable Limits",
      description: "Control your bandwidth usage and storage allocation. Set it and forget it — runs silently in system tray.",
    },
    {
      icon: <Clock className="h-5 w-5" />,
      title: "24/7 Passive Income",
      description: "Once running, the agent discovers peers, validates storage, and earns rewards — fully decentralized.",
    },
  ];

  const getFileForPlatform = (platform: Platform): DownloadFile | null => {
    if (!downloads?.files.length || platform === "unknown") return null;
    return findFileForPlatform(downloads.files, PLATFORMS[platform]);
  };

  const hasAnyDownloads = downloads && downloads.files.length > 0;

  const platformOrder: Exclude<Platform, "unknown">[] = detectedPlatform !== "unknown"
    ? [detectedPlatform as Exclude<Platform, "unknown">, ...Object.keys(PLATFORMS).filter(p => p !== detectedPlatform) as Exclude<Platform, "unknown">[]]
    : Object.keys(PLATFORMS) as Exclude<Platform, "unknown">[];

  return (
    <div className="container max-w-5xl py-8 space-y-10">
      {/* Hero */}
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">
          SPK Desktop Agent
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Run a fully decentralized IPFS storage node. Earn HBD rewards through peer-to-peer Proof of Access — no central server needed.
        </p>
        {downloads?.version && (
          <Badge variant="secondary" className="text-sm px-3 py-1">
            v{downloads.version}
          </Badge>
        )}
      </div>

      {/* Features grid */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {features.map((feature, i) => (
          <Card key={i} className="bg-card/50">
            <CardContent className="pt-5 pb-4 space-y-2">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary">
                {feature.icon}
              </div>
              <h3 className="font-semibold text-sm">{feature.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{feature.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Download section */}
      <div className="space-y-5">
        <div className="flex items-center justify-center gap-3">
          <h2 className="text-2xl font-semibold text-center">Download</h2>
          {loading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        </div>

        {!loading && !hasAnyDownloads && (
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-start gap-3">
                <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-amber-500/10 text-amber-500 shrink-0">
                  <Download className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="font-semibold text-amber-600">Builds Coming Soon</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Pre-built installers for all platforms will be available here shortly.
                    The desktop agent source code is ready — builds are being finalized.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid md:grid-cols-2 gap-4">
          {platformOrder.map((platform) => (
            <PlatformDownloadCard
              key={platform}
              info={PLATFORMS[platform]}
              file={getFileForPlatform(platform)}
              altFile={platform === "windows" ? findPortableFile(downloads?.files || []) : null}
              recommended={platform === detectedPlatform}
              expanded={expandedPlatform === platform}
              onToggle={() => setExpandedPlatform(expandedPlatform === platform ? null : platform)}
            />
          ))}
        </div>
      </div>

      {/* How it works */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-4 gap-6 text-center">
            {[
              { step: "1", title: "Install", desc: "Download and run the installer for your platform" },
              { step: "2", title: "Configure", desc: "Enter your Hive username, posting key, and set bandwidth/storage limits" },
              { step: "3", title: "Run", desc: "The agent discovers peers via Hive blockchain and joins the P2P network" },
              { step: "4", title: "Earn", desc: "Pass Proof of Access challenges to earn HBD rewards" },
            ].map((item) => (
              <div key={item.step} className="space-y-2">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground font-bold text-lg mx-auto">
                  {item.step}
                </div>
                <h4 className="font-semibold text-sm">{item.title}</h4>
                <p className="text-xs text-muted-foreground">{item.desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Requirements */}
      <div className="text-center space-y-3">
        <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">System Requirements</h3>
        <div className="flex flex-wrap justify-center gap-3 text-sm text-muted-foreground">
          {[
            "2 GB RAM",
            "50 GB free disk space (configurable)",
            "Stable internet connection",
            "Windows 10+, macOS 10.15+, or Linux",
          ].map((req, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              {req}
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground pt-2">
          Open source under GPL-3.0 license
        </p>
      </div>
    </div>
  );
}
