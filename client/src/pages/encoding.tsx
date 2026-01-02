import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { 
  Video, 
  Upload, 
  Settings, 
  RefreshCw, 
  Monitor, 
  Globe, 
  Cpu,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  Server,
  Activity,
  Users,
  Timer,
  Zap,
  WifiOff,
  Wifi,
  ChevronRight,
  ChevronLeft,
  FileVideo,
  DollarSign,
  Star,
  Check,
  X
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BrowserEncoder } from "@/lib/browser-encoder";
import { detectDesktopAgent, type DesktopAgentStatus } from "@/lib/desktop-agent";

interface EncodingJob {
  id: string;
  owner: string;
  permlink: string;
  inputCid: string;
  outputCid?: string;
  status: string;
  progress: number;
  stage?: string;
  encodingMode: string;
  encoderType?: string;
  isShort: boolean;
  qualitiesEncoded?: string;
  videoUrl?: string;
  hbdCost?: string;
  errorMessage?: string;
  originalFilename?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  processingTimeSec?: number;
  createdAt: string;
  completedAt?: string;
  estimatedWaitSec?: number;
}

interface QueueStats {
  queued: number;
  assigned: number;
  processing: number;
  completed: number;
  failed: number;
  totalPending: number;
}

interface EncoderNode {
  id: string;
  peerId: string;
  hiveUsername: string;
  endpoint?: string;
  encoderType: string;
  availability: string;
  jobsCompleted: number;
  jobsInProgress: number;
  hardwareAcceleration?: string;
  rating?: number;
  price1080p: string;
  price720p: string;
  price480p: string;
  priceAllQualities: string;
  reputationScore: number;
  successRate: number;
  minOfferHbd: string;
  effectivePrice?: string;
}

interface EncodingOffer {
  id: string;
  jobId: string;
  owner: string;
  inputCid: string;
  qualitiesRequested: string;
  videoDurationSec: number;
  offeredHbd: string;
  marketPriceHbd: string;
  status: string;
  acceptedEncoderId?: string;
  acceptedAt?: string;
  expiresAt: string;
  createdAt: string;
}

interface EncoderStatus {
  desktop: {
    available: boolean;
    status: DesktopAgentStatus | null;
    checking: boolean;
  };
  browser: {
    supported: boolean;
    missing: string[];
  };
  community: {
    count: number;
    available: number;
  };
}

type WizardStep = 1 | 2 | 3 | 4;
type PricingMode = "market" | "custom";

interface WizardState {
  file: File | null;
  videoDuration: number;
  qualities: { "1080p": boolean; "720p": boolean; "480p": boolean };
  pricingMode: PricingMode;
  selectedEncoder: EncoderNode | null;
  customPrice: string;
  owner: string;
  permlink: string;
}

export default function EncodingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [wizardState, setWizardState] = useState<WizardState>({
    file: null,
    videoDuration: 0,
    qualities: { "1080p": true, "720p": true, "480p": true },
    pricingMode: "market",
    selectedEncoder: null,
    customPrice: "",
    owner: "",
    permlink: "",
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const [newJobForm, setNewJobForm] = useState({
    owner: "",
    permlink: "",
    inputCid: "",
    isShort: false,
    useBrowserEncoder: false,
  });
  const [testEndpoint, setTestEndpoint] = useState("http://localhost:3002");
  
  const [encoderStatus, setEncoderStatus] = useState<EncoderStatus>({
    desktop: { available: false, status: null, checking: false },
    browser: { supported: false, missing: [] },
    community: { count: 0, available: 0 },
  });

  const { data: queueStats } = useQuery<QueueStats>({
    queryKey: ["/api/encoding/queue/stats"],
    refetchInterval: 3000,
  });

  const { data: jobs = [] } = useQuery<EncodingJob[]>({
    queryKey: ["/api/encoding/jobs", username],
    queryFn: async () => {
      const url = username 
        ? `/api/encoding/jobs?owner=${encodeURIComponent(username)}`
        : "/api/encoding/jobs";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json();
    },
    refetchInterval: 2000,
  });

  const { data: encoders = [] } = useQuery<EncoderNode[]>({
    queryKey: ["/api/encoding/encoders"],
    refetchInterval: 10000,
  });

  const { data: marketEncoders = [] } = useQuery<EncoderNode[]>({
    queryKey: ["/api/encoding/encoders/market"],
    queryFn: async () => {
      const res = await fetch("/api/encoding/encoders/market?quality=all&sortBy=reputation");
      if (!res.ok) throw new Error("Failed to fetch market encoders");
      return res.json();
    },
    enabled: wizardOpen,
    refetchInterval: 30000,
  });

  const { data: userOffers = [], refetch: refetchOffers } = useQuery<EncodingOffer[]>({
    queryKey: ["/api/encoding/offers/user", wizardState.owner],
    queryFn: async () => {
      if (!wizardState.owner) return [];
      const res = await fetch(`/api/encoding/offers/user/${encodeURIComponent(wizardState.owner)}`);
      if (!res.ok) throw new Error("Failed to fetch offers");
      return res.json();
    },
    enabled: !!wizardState.owner,
    refetchInterval: 10000,
  });

  useEffect(() => {
    const browserSupport = BrowserEncoder.getSupportInfo();
    setEncoderStatus(prev => ({
      ...prev,
      browser: {
        supported: browserSupport.supported,
        missing: browserSupport.missing,
      },
    }));
  }, []);

  useEffect(() => {
    const available = encoders.filter(e => e.availability === "available").length;
    setEncoderStatus(prev => ({
      ...prev,
      community: {
        count: encoders.length,
        available,
      },
    }));
  }, [encoders]);

  const checkDesktopAgent = async () => {
    setEncoderStatus(prev => ({
      ...prev,
      desktop: { ...prev.desktop, checking: true },
    }));
    
    try {
      const status = await detectDesktopAgent();
      setEncoderStatus(prev => ({
        ...prev,
        desktop: {
          available: status !== null,
          status,
          checking: false,
        },
      }));
      
      if (status) {
        toast({ 
          title: "Desktop Agent Connected", 
          description: `Version: ${status.version || "Unknown"}` 
        });
      }
    } catch {
      setEncoderStatus(prev => ({
        ...prev,
        desktop: { available: false, status: null, checking: false },
      }));
    }
  };

  useEffect(() => {
    checkDesktopAgent();
    const interval = setInterval(checkDesktopAgent, 30000);
    return () => clearInterval(interval);
  }, []);

  const submitJobMutation = useMutation({
    mutationFn: async (job: typeof newJobForm) => {
      const res = await fetch("/api/encoding/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: job.owner,
          permlink: job.permlink,
          inputCid: job.inputCid,
          isShort: job.isShort,
          encodingMode: job.useBrowserEncoder ? "browser" : "auto",
        }),
      });
      if (!res.ok) throw new Error("Failed to submit job");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Job Submitted", description: "Encoding job added to queue" });
      queryClient.invalidateQueries({ queryKey: ["/api/encoding/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/encoding/queue/stats"] });
      setNewJobForm({ owner: "", permlink: "", inputCid: "", isShort: false, useBrowserEncoder: false });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createOfferMutation = useMutation({
    mutationFn: async (data: {
      inputCid: string;
      qualitiesRequested: string[];
      videoDurationSec: number;
      offeredHbd: string;
      owner: string;
      permlink: string;
    }) => {
      const res = await fetch("/api/encoding/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create offer");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Offer Created", description: "Your custom price offer has been submitted" });
      queryClient.invalidateQueries({ queryKey: ["/api/encoding/offers/user"] });
      setWizardOpen(false);
      resetWizard();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const cancelOfferMutation = useMutation({
    mutationFn: async ({ offerId, username }: { offerId: string; username: string }) => {
      const res = await fetch(`/api/encoding/offers/${offerId}?username=${encodeURIComponent(username)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to cancel offer");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Offer Cancelled", description: "Your offer has been cancelled" });
      refetchOffers();
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const checkDesktopAgentMutation = useMutation({
    mutationFn: async (endpoint: string) => {
      const res = await fetch("/api/encoding/check-desktop-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.available) {
        toast({ 
          title: "Desktop Agent Found", 
          description: `Hardware: ${data.hardwareAcceleration || "Software"}` 
        });
      } else {
        toast({ 
          title: "Desktop Agent Not Found", 
          description: "Make sure the agent is running locally",
          variant: "destructive"
        });
      }
    },
  });

  const resetWizard = () => {
    setCurrentStep(1);
    setWizardState({
      file: null,
      videoDuration: 0,
      qualities: { "1080p": true, "720p": true, "480p": true },
      pricingMode: "market",
      selectedEncoder: null,
      customPrice: "",
      owner: "",
      permlink: "",
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setWizardState(prev => ({ ...prev, file }));
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        setWizardState(prev => ({ ...prev, videoDuration: Math.round(video.duration) }));
        URL.revokeObjectURL(video.src);
      };
      video.src = URL.createObjectURL(file);
    }
  };

  const getSelectedQualities = () => {
    return Object.entries(wizardState.qualities)
      .filter(([_, selected]) => selected)
      .map(([quality]) => quality);
  };

  const calculateTotalCost = (encoder: EncoderNode | null) => {
    if (!encoder) return "0.00";
    const qualities = getSelectedQualities();
    // Use minimum 1 minute for pricing when duration unknown
    const durationMinutes = Math.max(wizardState.videoDuration, 60) / 60;
    
    if (qualities.length === 3) {
      return (parseFloat(encoder.priceAllQualities) * durationMinutes).toFixed(4);
    }
    
    let total = 0;
    if (qualities.includes("1080p")) total += parseFloat(encoder.price1080p);
    if (qualities.includes("720p")) total += parseFloat(encoder.price720p);
    if (qualities.includes("480p")) total += parseFloat(encoder.price480p);
    
    return (total * durationMinutes).toFixed(4);
  };

  const getReputationBadge = (score: number) => {
    const percentage = (score / 1000) * 100;
    if (percentage >= 80) {
      return <Badge className="bg-green-500" data-testid="badge-reputation-high">{percentage.toFixed(0)}%</Badge>;
    } else if (percentage >= 60) {
      return <Badge className="bg-yellow-500" data-testid="badge-reputation-medium">{percentage.toFixed(0)}%</Badge>;
    }
    return <Badge className="bg-red-500" data-testid="badge-reputation-low">{percentage.toFixed(0)}%</Badge>;
  };

  const formatDurationDisplay = (seconds: number) => {
    if (seconds === 0) return "Unknown (will estimate)";
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  };

  const canProceedToStep = (step: WizardStep): boolean => {
    switch (step) {
      case 2:
        return !!wizardState.file && !!wizardState.owner;
      case 3:
        return getSelectedQualities().length > 0;
      case 4:
        if (wizardState.pricingMode === "market") {
          return !!wizardState.selectedEncoder;
        }
        return !!wizardState.customPrice && parseFloat(wizardState.customPrice) > 0;
      default:
        return true;
    }
  };

  const handleSubmitWizard = async () => {
    const qualities = getSelectedQualities();
    
    if (wizardState.pricingMode === "custom") {
      await createOfferMutation.mutateAsync({
        inputCid: `mock-cid-${Date.now()}`,
        qualitiesRequested: qualities,
        videoDurationSec: wizardState.videoDuration,
        offeredHbd: wizardState.customPrice,
        owner: wizardState.owner,
        permlink: wizardState.permlink || `video-${Date.now()}`,
      });
    } else if (wizardState.selectedEncoder) {
      await submitJobMutation.mutateAsync({
        owner: wizardState.owner,
        permlink: wizardState.permlink || `video-${Date.now()}`,
        inputCid: `mock-cid-${Date.now()}`,
        isShort: qualities.length === 1 && qualities[0] === "480p",
        useBrowserEncoder: false,
      });
      setWizardOpen(false);
      resetWizard();
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600" data-testid="badge-status-completed">completed</Badge>;
      case "failed":
        return <Badge variant="destructive" data-testid="badge-status-failed">failed</Badge>;
      case "queued":
        return <Badge className="bg-yellow-500 hover:bg-yellow-600" data-testid="badge-status-queued">queued</Badge>;
      case "assigned":
        return <Badge className="bg-orange-500 hover:bg-orange-600" data-testid="badge-status-assigned">assigned</Badge>;
      case "downloading":
      case "encoding":
      case "uploading":
        return <Badge className="bg-blue-500 hover:bg-blue-600" data-testid="badge-status-encoding">{status}</Badge>;
      case "pending":
        return <Badge className="bg-purple-500 hover:bg-purple-600" data-testid="badge-status-pending">pending</Badge>;
      case "accepted":
        return <Badge className="bg-green-500 hover:bg-green-600" data-testid="badge-status-accepted">accepted</Badge>;
      case "cancelled":
        return <Badge variant="secondary" data-testid="badge-status-cancelled">cancelled</Badge>;
      case "expired":
        return <Badge variant="secondary" data-testid="badge-status-expired">expired</Badge>;
      default:
        return <Badge variant="secondary" data-testid="badge-status-unknown">{status}</Badge>;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "queued":
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case "downloading":
      case "encoding":
      case "uploading":
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      default:
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getEncoderTypeIcon = (type?: string) => {
    switch (type) {
      case "desktop":
        return <Monitor className="h-4 w-4" />;
      case "browser":
        return <Globe className="h-4 w-4" />;
      case "community":
        return <Server className="h-4 w-4" />;
      default:
        return <Cpu className="h-4 w-4" />;
    }
  };

  const getStageLabel = (status: string, stage?: string) => {
    if (stage) return stage;
    switch (status) {
      case "downloading": return "Downloading source...";
      case "encoding": return "Encoding video...";
      case "uploading": return "Uploading to IPFS...";
      default: return status;
    }
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDuration = (sec?: number) => {
    if (!sec) return "—";
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  const formatWaitTime = (seconds?: number) => {
    if (!seconds || seconds <= 0) return "Ready to start";
    if (seconds < 60) return `~${seconds}s wait`;
    if (seconds < 3600) return `~${Math.ceil(seconds / 60)}min wait`;
    return `~${Math.ceil(seconds / 3600)}h wait`;
  };

  const activeJobs = jobs.filter(j => ["downloading", "encoding", "uploading", "assigned"].includes(j.status));
  const pendingOffers = userOffers.filter(o => o.status === "pending");

  const renderWizardStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <FileVideo className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold">Upload Your Video</h3>
              <p className="text-sm text-muted-foreground">Select a video file to encode for streaming</p>
            </div>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="wizard-owner">Hive Username</Label>
                <Input
                  id="wizard-owner"
                  placeholder="your-hive-username"
                  value={wizardState.owner}
                  onChange={(e) => setWizardState(prev => ({ ...prev, owner: e.target.value }))}
                  data-testid="input-wizard-owner"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="wizard-permlink">Permlink (optional)</Label>
                <Input
                  id="wizard-permlink"
                  placeholder="my-awesome-video"
                  value={wizardState.permlink}
                  onChange={(e) => setWizardState(prev => ({ ...prev, permlink: e.target.value }))}
                  data-testid="input-wizard-permlink"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="video-file">Video File</Label>
                <div className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary transition-colors">
                  <input
                    type="file"
                    id="video-file"
                    accept="video/*"
                    onChange={handleFileSelect}
                    className="hidden"
                    data-testid="input-video-file"
                  />
                  <label htmlFor="video-file" className="cursor-pointer block">
                    {wizardState.file ? (
                      <div className="space-y-2">
                        <CheckCircle className="h-10 w-10 mx-auto text-green-500" />
                        <p className="font-medium">{wizardState.file.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatBytes(wizardState.file.size)} • Duration: {formatDurationDisplay(wizardState.videoDuration)}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Upload className="h-10 w-10 mx-auto text-muted-foreground" />
                        <p className="font-medium">Click to select video</p>
                        <p className="text-sm text-muted-foreground">MP4, WebM, MOV, AVI supported</p>
                      </div>
                    )}
                  </label>
                </div>
              </div>
              
              {wizardState.videoDuration > 0 && (
                <div className="flex items-center gap-2 p-3 bg-green-500/10 rounded-lg">
                  <Clock className="h-5 w-5 text-green-500" />
                  <span className="text-sm" data-testid="text-video-duration">
                    Video duration: {formatDurationDisplay(wizardState.videoDuration)}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      
      case 2:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <Settings className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold">Select Output Qualities</h3>
              <p className="text-sm text-muted-foreground">Choose which resolutions to encode</p>
            </div>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="select-all"
                    checked={wizardState.qualities["1080p"] && wizardState.qualities["720p"] && wizardState.qualities["480p"]}
                    onCheckedChange={(checked) => {
                      const isChecked = checked === true;
                      setWizardState(prev => ({
                        ...prev,
                        qualities: { "1080p": isChecked, "720p": isChecked, "480p": isChecked }
                      }));
                    }}
                    data-testid="checkbox-select-all"
                  />
                  <Label htmlFor="select-all" className="font-semibold cursor-pointer">Select All</Label>
                </div>
                <Badge variant="secondary">Bundle discount</Badge>
              </div>
              
              <Separator />
              
              {(["1080p", "720p", "480p"] as const).map((quality) => (
                <div key={quality} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <Checkbox
                      id={`quality-${quality}`}
                      checked={wizardState.qualities[quality]}
                      onCheckedChange={(checked) => {
                        setWizardState(prev => ({
                          ...prev,
                          qualities: { ...prev.qualities, [quality]: checked === true }
                        }));
                      }}
                      data-testid={`checkbox-quality-${quality}`}
                    />
                    <Label htmlFor={`quality-${quality}`} className="cursor-pointer">
                      <span className="font-medium">{quality}</span>
                      <span className="text-muted-foreground ml-2">
                        ({quality === "1080p" ? "1920×1080" : quality === "720p" ? "1280×720" : "854×480"})
                      </span>
                    </Label>
                  </div>
                </div>
              ))}
              
              {getSelectedQualities().length === 0 && (
                <div className="text-sm text-red-500 text-center">
                  Please select at least one quality
                </div>
              )}
            </div>
          </div>
        );
      
      case 3:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <DollarSign className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold">Choose Pricing Option</h3>
              <p className="text-sm text-muted-foreground">Select an encoder or name your price</p>
            </div>
            
            <RadioGroup
              value={wizardState.pricingMode}
              onValueChange={(value: PricingMode) => setWizardState(prev => ({ ...prev, pricingMode: value, selectedEncoder: null }))}
              className="space-y-4"
            >
              <div className={`p-4 border rounded-lg cursor-pointer transition-colors ${wizardState.pricingMode === "market" ? "border-primary bg-primary/5" : ""}`}>
                <div className="flex items-center gap-3">
                  <RadioGroupItem value="market" id="pricing-market" data-testid="radio-pricing-market" />
                  <Label htmlFor="pricing-market" className="cursor-pointer flex-1">
                    <div className="font-semibold">Market Price</div>
                    <div className="text-sm text-muted-foreground">Choose from community encoders</div>
                  </Label>
                </div>
              </div>
              
              <div className={`p-4 border rounded-lg cursor-pointer transition-colors ${wizardState.pricingMode === "custom" ? "border-primary bg-primary/5" : ""}`}>
                <div className="flex items-center gap-3">
                  <RadioGroupItem value="custom" id="pricing-custom" data-testid="radio-pricing-custom" />
                  <Label htmlFor="pricing-custom" className="cursor-pointer flex-1">
                    <div className="font-semibold">Name Your Price</div>
                    <div className="text-sm text-muted-foreground">Submit a custom offer and wait for acceptance</div>
                  </Label>
                </div>
              </div>
            </RadioGroup>
            
            {wizardState.pricingMode === "market" && (
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                <Label>Available Encoders</Label>
                {marketEncoders.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
                    Loading encoders...
                  </div>
                ) : (
                  marketEncoders.filter(e => e.availability === "available").map((encoder) => (
                    <div
                      key={encoder.id}
                      onClick={() => setWizardState(prev => ({ ...prev, selectedEncoder: encoder }))}
                      className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                        wizardState.selectedEncoder?.id === encoder.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                      }`}
                      data-testid={`encoder-card-${encoder.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                            wizardState.selectedEncoder?.id === encoder.id ? "border-primary" : "border-muted-foreground"
                          }`}>
                            {wizardState.selectedEncoder?.id === encoder.id && (
                              <div className="w-2 h-2 rounded-full bg-primary" />
                            )}
                          </div>
                          <div>
                            <div className="font-medium flex items-center gap-2">
                              {encoder.hiveUsername}
                              {getReputationBadge(encoder.reputationScore)}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {encoder.jobsCompleted} jobs • {encoder.successRate.toFixed(0)}% success
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-primary">
                            {calculateTotalCost(encoder)} HBD
                          </div>
                          <div className="text-xs text-muted-foreground">
                            for {formatDurationDisplay(wizardState.videoDuration)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            
            {wizardState.pricingMode === "custom" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="custom-price">Your Offer (HBD)</Label>
                  <Input
                    id="custom-price"
                    type="number"
                    step="0.001"
                    min="0"
                    placeholder="0.00"
                    value={wizardState.customPrice}
                    onChange={(e) => setWizardState(prev => ({ ...prev, customPrice: e.target.value }))}
                    data-testid="input-custom-price"
                  />
                  <p className="text-sm text-muted-foreground">
                    Enter a price below market rate. Encoders will see your offer and may accept it.
                  </p>
                </div>
                
                {marketEncoders.length > 0 && (
                  <div className="p-3 bg-muted rounded-lg text-sm">
                    <div className="flex justify-between">
                      <span>Lowest market price:</span>
                      <span className="font-medium">{calculateTotalCost(marketEncoders[0])} HBD</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      
      case 4:
        return (
          <div className="space-y-6">
            <div className="text-center">
              <CheckCircle className="h-16 w-16 mx-auto text-green-500 mb-4" />
              <h3 className="text-lg font-semibold">Review & Submit</h3>
              <p className="text-sm text-muted-foreground">Confirm your encoding request</p>
            </div>
            
            <div className="space-y-4">
              <div className="p-4 border rounded-lg space-y-3">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Video</span>
                  <span className="font-medium">{wizardState.file?.name}</span>
                </div>
                <Separator />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-medium" data-testid="review-duration">{formatDurationDisplay(wizardState.videoDuration)}</span>
                </div>
                <Separator />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Qualities</span>
                  <span className="font-medium" data-testid="review-qualities">{getSelectedQualities().join(", ")}</span>
                </div>
                <Separator />
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Pricing</span>
                  <span className="font-medium">
                    {wizardState.pricingMode === "market" ? "Market Price" : "Custom Offer"}
                  </span>
                </div>
                {wizardState.pricingMode === "market" && wizardState.selectedEncoder && (
                  <>
                    <Separator />
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Encoder</span>
                      <span className="font-medium">{wizardState.selectedEncoder.hiveUsername}</span>
                    </div>
                  </>
                )}
                <Separator />
                <div className="flex justify-between text-lg">
                  <span className="font-semibold">Total Cost</span>
                  <span className="font-bold text-primary" data-testid="review-total-cost">
                    {wizardState.pricingMode === "market" 
                      ? `${calculateTotalCost(wizardState.selectedEncoder)} HBD`
                      : `${wizardState.customPrice || "0"} HBD`
                    }
                  </span>
                </div>
              </div>
              
              {wizardState.pricingMode === "custom" && (
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm">
                  <AlertCircle className="h-4 w-4 inline mr-2 text-yellow-500" />
                  Your offer will be visible to all encoders. The first encoder to accept will process your video.
                </div>
              )}
            </div>
          </div>
        );
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Video className="h-8 w-8 text-red-500" />
            Hybrid Encoding
          </h1>
          <p className="text-muted-foreground">
            Self-encode with desktop agent, browser, or use community encoders
          </p>
        </div>
        <div className="flex gap-2">
          <Dialog open={wizardOpen} onOpenChange={(open) => { setWizardOpen(open); if (!open) resetWizard(); }}>
            <DialogTrigger asChild>
              <Button data-testid="button-upload-video">
                <Upload className="h-4 w-4 mr-2" />
                Upload New Video
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Upload Video Wizard</DialogTitle>
                <DialogDescription>
                  Step {currentStep} of 4
                </DialogDescription>
              </DialogHeader>
              
              <div className="flex justify-center mb-6">
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4].map((step) => (
                    <div key={step} className="flex items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                          step === currentStep
                            ? "bg-primary text-primary-foreground"
                            : step < currentStep
                            ? "bg-green-500 text-white"
                            : "bg-muted text-muted-foreground"
                        }`}
                        data-testid={`wizard-step-${step}`}
                      >
                        {step < currentStep ? <Check className="h-4 w-4" /> : step}
                      </div>
                      {step < 4 && (
                        <div className={`w-8 h-1 mx-1 ${step < currentStep ? "bg-green-500" : "bg-muted"}`} />
                      )}
                    </div>
                  ))}
                </div>
              </div>
              
              {renderWizardStep()}
              
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => setCurrentStep(prev => Math.max(1, prev - 1) as WizardStep)}
                  disabled={currentStep === 1}
                  data-testid="button-wizard-back"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
                
                {currentStep < 4 ? (
                  <Button
                    onClick={() => setCurrentStep(prev => Math.min(4, prev + 1) as WizardStep)}
                    disabled={!canProceedToStep(currentStep + 1 as WizardStep)}
                    data-testid="button-wizard-next"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                ) : (
                  <Button
                    onClick={handleSubmitWizard}
                    disabled={createOfferMutation.isPending || submitJobMutation.isPending}
                    data-testid="button-wizard-submit"
                  >
                    {(createOfferMutation.isPending || submitJobMutation.isPending) ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 mr-2" />
                    )}
                    {wizardState.pricingMode === "custom" ? "Submit Offer" : "Start Encoding"}
                  </Button>
                )}
              </div>
            </DialogContent>
          </Dialog>
          
          <Button 
            variant="outline" 
            onClick={() => {
              queryClient.invalidateQueries();
              checkDesktopAgent();
            }}
            data-testid="button-refresh-encoding"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {pendingOffers.length > 0 && (
        <Card data-testid="panel-pending-offers">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Your Pending Offers
            </CardTitle>
            <CardDescription>Custom price offers waiting for encoder acceptance</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {pendingOffers.map((offer) => (
                <div key={offer.id} className="flex items-center justify-between p-4 border rounded-lg" data-testid={`offer-card-${offer.id}`}>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{offer.qualitiesRequested}</span>
                      {getStatusBadge(offer.status)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Duration: {formatDuration(offer.videoDurationSec)} • 
                      Offered: {offer.offeredHbd} HBD • 
                      Market: {offer.marketPriceHbd} HBD
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Expires: {new Date(offer.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => cancelOfferMutation.mutate({ offerId: offer.id, username: offer.owner })}
                    disabled={cancelOfferMutation.isPending}
                    data-testid={`button-cancel-offer-${offer.id}`}
                  >
                    {cancelOfferMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <X className="h-4 w-4" />
                    )}
                    Cancel
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card data-testid="panel-encoder-status">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Encoder Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Desktop Agent</span>
              </div>
              {encoderStatus.desktop.checking ? (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking
                </Badge>
              ) : encoderStatus.desktop.available ? (
                <Badge className="bg-green-500 flex items-center gap-1" data-testid="status-desktop-connected">
                  <Wifi className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="secondary" className="flex items-center gap-1" data-testid="status-desktop-disconnected">
                  <WifiOff className="h-3 w-3" />
                  Disconnected
                </Badge>
              )}
            </div>
            
            <Separator />
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Browser WebCodecs</span>
              </div>
              {encoderStatus.browser.supported ? (
                <Badge className="bg-green-500" data-testid="status-browser-supported">
                  Supported
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="status-browser-unsupported">
                  Unsupported
                </Badge>
              )}
            </div>
            
            <Separator />
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Community Encoders</span>
              </div>
              <Badge 
                variant={encoderStatus.community.available > 0 ? "default" : "secondary"}
                data-testid="status-community-count"
              >
                {encoderStatus.community.available}/{encoderStatus.community.count} available
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="panel-queue-stats">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Timer className="h-5 w-5" />
              Queue Statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-2 rounded-lg bg-yellow-500/10">
                <div className="text-2xl font-bold text-yellow-500" data-testid="stat-queued">
                  {queueStats?.queued || 0}
                </div>
                <div className="text-xs text-muted-foreground">Queued</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-blue-500/10">
                <div className="text-2xl font-bold text-blue-500" data-testid="stat-processing">
                  {queueStats?.processing || 0}
                </div>
                <div className="text-xs text-muted-foreground">Processing</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-green-500/10">
                <div className="text-2xl font-bold text-green-500" data-testid="stat-completed">
                  {queueStats?.completed || 0}
                </div>
                <div className="text-xs text-muted-foreground">Completed</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-red-500/10">
                <div className="text-2xl font-bold text-red-500" data-testid="stat-failed">
                  {queueStats?.failed || 0}
                </div>
                <div className="text-xs text-muted-foreground">Failed</div>
              </div>
            </div>
            {queueStats?.totalPending && queueStats.totalPending > 0 && (
              <div className="mt-3 text-center text-sm text-muted-foreground">
                <span data-testid="text-estimated-wait">
                  Est. wait: {formatWaitTime(queueStats.totalPending * 60)}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="panel-active-jobs">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Active Jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeJobs.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground text-sm">
                No active encoding jobs
              </div>
            ) : (
              <div className="space-y-3">
                {activeJobs.slice(0, 3).map((job) => (
                  <div key={job.id} className="space-y-1" data-testid={`active-job-${job.id}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium truncate max-w-[120px]">{job.permlink}</span>
                      {getStatusBadge(job.status)}
                    </div>
                    <Progress value={job.progress} className="h-2" data-testid={`progress-bar-${job.id}`} />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span data-testid={`stage-label-${job.id}`}>{getStageLabel(job.status, job.stage)}</span>
                      <span data-testid={`progress-percent-${job.id}`}>{job.progress}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="jobs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="jobs" data-testid="tab-jobs">
            Jobs History
            {jobs.length > 0 && (
              <Badge variant="secondary" className="ml-2">{jobs.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="submit" data-testid="tab-submit">Submit Job</TabsTrigger>
          <TabsTrigger value="encoders" data-testid="tab-encoders">
            Encoders
            {encoders.length > 0 && (
              <Badge variant="secondary" className="ml-2">{encoders.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Encoding Jobs</CardTitle>
                  <CardDescription>Job history and real-time status</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Filter by username..."
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-48"
                    data-testid="input-filter-username"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {jobs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Video className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No encoding jobs yet</p>
                  <p className="text-sm mt-1">Submit a video to get started</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {jobs.map((job) => (
                    <div
                      key={job.id}
                      className="border rounded-lg p-4 space-y-3"
                      data-testid={`card-job-${job.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(job.status)}
                          <span className="font-medium">{job.owner}/{job.permlink}</span>
                          {job.isShort && <Badge variant="secondary">Short</Badge>}
                        </div>
                        <div className="flex items-center gap-2">
                          {job.encoderType && (
                            <Badge variant="outline" className="flex items-center gap-1">
                              {getEncoderTypeIcon(job.encoderType)}
                              {job.encoderType}
                            </Badge>
                          )}
                          {getStatusBadge(job.status)}
                        </div>
                      </div>

                      {["downloading", "encoding", "uploading", "assigned"].includes(job.status) && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-sm text-muted-foreground">
                            <span data-testid={`job-stage-${job.id}`}>
                              {getStageLabel(job.status, job.stage)}
                            </span>
                            <span data-testid={`job-progress-${job.id}`}>{job.progress}%</span>
                          </div>
                          <Progress value={job.progress} data-testid={`job-progress-bar-${job.id}`} />
                        </div>
                      )}

                      {job.status === "queued" && (
                        <div className="flex items-center gap-2 text-sm text-yellow-600 bg-yellow-500/10 p-2 rounded">
                          <Clock className="h-4 w-4" />
                          <span data-testid={`job-wait-${job.id}`}>
                            {formatWaitTime(job.estimatedWaitSec)}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                        <span>Input: {job.inputCid.substring(0, 12)}...</span>
                        {job.outputCid && (
                          <span>Output: {job.outputCid.substring(0, 12)}...</span>
                        )}
                        {job.qualitiesEncoded && (
                          <span>Qualities: {job.qualitiesEncoded}</span>
                        )}
                        {job.inputSizeBytes && (
                          <span>Size: {formatBytes(job.inputSizeBytes)}</span>
                        )}
                        {job.processingTimeSec && (
                          <span>Time: {formatDuration(job.processingTimeSec)}</span>
                        )}
                        {job.hbdCost && parseFloat(job.hbdCost) > 0 && (
                          <span className="text-orange-500">Cost: {job.hbdCost} HBD</span>
                        )}
                      </div>

                      {job.errorMessage && (
                        <div className="text-sm text-red-500 bg-red-500/10 p-2 rounded flex items-start gap-2">
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                          <span data-testid={`job-error-${job.id}`}>{job.errorMessage}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="submit" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Submit Encoding Job</CardTitle>
              <CardDescription>
                Submit a video for encoding. Uses desktop agent if available, otherwise falls back to browser or community encoders.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="owner">Hive Username</Label>
                  <Input
                    id="owner"
                    placeholder="your-hive-username"
                    value={newJobForm.owner}
                    onChange={(e) => setNewJobForm({ ...newJobForm, owner: e.target.value })}
                    data-testid="input-owner"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="permlink">Permlink</Label>
                  <Input
                    id="permlink"
                    placeholder="my-video-post"
                    value={newJobForm.permlink}
                    onChange={(e) => setNewJobForm({ ...newJobForm, permlink: e.target.value })}
                    data-testid="input-permlink"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="inputCid">Input CID</Label>
                <Input
                  id="inputCid"
                  placeholder="Qm... or bafy..."
                  value={newJobForm.inputCid}
                  onChange={(e) => setNewJobForm({ ...newJobForm, inputCid: e.target.value })}
                  data-testid="input-cid"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="isShort"
                    checked={newJobForm.isShort}
                    onCheckedChange={(checked) => setNewJobForm({ ...newJobForm, isShort: checked })}
                    data-testid="switch-is-short"
                  />
                  <Label htmlFor="isShort">Short video (480p only, faster encoding)</Label>
                </div>

                {encoderStatus.browser.supported && (
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="useBrowserEncoder"
                      checked={newJobForm.useBrowserEncoder}
                      onCheckedChange={(checked) => setNewJobForm({ ...newJobForm, useBrowserEncoder: checked, isShort: checked ? true : newJobForm.isShort })}
                      data-testid="switch-browser-encoder"
                    />
                    <div>
                      <Label htmlFor="useBrowserEncoder">Use browser encoding (WebCodecs)</Label>
                      <p className="text-xs text-muted-foreground">
                        Encode in your browser - works for videos under 2 minutes
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {newJobForm.useBrowserEncoder && !encoderStatus.browser.supported && (
                <div className="text-sm text-yellow-600 bg-yellow-500/10 p-3 rounded">
                  <AlertCircle className="h-4 w-4 inline mr-2" />
                  Browser encoding not supported. Missing: {encoderStatus.browser.missing.join(", ")}
                </div>
              )}

              <Button 
                onClick={() => submitJobMutation.mutate(newJobForm)}
                disabled={!newJobForm.owner || !newJobForm.permlink || !newJobForm.inputCid || submitJobMutation.isPending}
                className="w-full"
                data-testid="button-submit-job"
              >
                {submitJobMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Submit Encoding Job
              </Button>

              <div className="rounded-lg border p-4 space-y-2">
                <h4 className="font-medium text-sm">Encoding Priority</h4>
                <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                  <li className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 inline" />
                    <span><strong>Desktop Agent</strong> - Fastest, GPU acceleration, free</span>
                    {encoderStatus.desktop.available && <Badge className="bg-green-500 ml-auto">Available</Badge>}
                  </li>
                  <li className="flex items-center gap-2">
                    <Globe className="h-4 w-4 inline" />
                    <span><strong>Browser (WebCodecs)</strong> - Short videos only, free</span>
                    {encoderStatus.browser.supported && <Badge className="bg-green-500 ml-auto">Supported</Badge>}
                  </li>
                  <li className="flex items-center gap-2">
                    <Server className="h-4 w-4 inline" />
                    <span><strong>Community Encoders</strong> - Reliable, costs HBD</span>
                    {encoderStatus.community.available > 0 && (
                      <Badge variant="secondary" className="ml-auto">{encoderStatus.community.available} online</Badge>
                    )}
                  </li>
                </ol>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="encoders" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Available Encoders</CardTitle>
              <CardDescription>
                Desktop agents, browser encoders, and community nodes
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 mb-4">
                <Input
                  placeholder="http://localhost:3002"
                  value={testEndpoint}
                  onChange={(e) => setTestEndpoint(e.target.value)}
                  className="max-w-sm"
                  data-testid="input-test-endpoint"
                />
                <Button
                  variant="outline"
                  onClick={() => checkDesktopAgentMutation.mutate(testEndpoint)}
                  disabled={checkDesktopAgentMutation.isPending}
                  data-testid="button-test-agent"
                >
                  {checkDesktopAgentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Monitor className="h-4 w-4 mr-2" />
                  )}
                  Test Desktop Agent
                </Button>
              </div>

              {encoders.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Server className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No community encoders registered yet</p>
                  <p className="text-sm mt-1">Run the desktop agent to become an encoder</p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {encoders.map((encoder) => (
                    <div
                      key={encoder.id}
                      className="border rounded-lg p-4 space-y-2"
                      data-testid={`card-encoder-${encoder.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {getEncoderTypeIcon(encoder.encoderType)}
                          <span className="font-medium">{encoder.hiveUsername}</span>
                        </div>
                        <Badge 
                          className={encoder.availability === "available" ? "bg-green-500" : ""}
                          variant={encoder.availability === "available" ? "default" : "secondary"}
                        >
                          {encoder.availability}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground space-y-1">
                        <div>Type: {encoder.encoderType}</div>
                        {encoder.hardwareAcceleration && (
                          <div>Hardware: {encoder.hardwareAcceleration}</div>
                        )}
                        <div>Jobs: {encoder.jobsCompleted} completed, {encoder.jobsInProgress} active</div>
                        {encoder.rating && <div>Rating: {encoder.rating.toFixed(1)}/5.0</div>}
                        <div className="flex items-center gap-2">
                          <span>Reputation:</span>
                          {getReputationBadge(encoder.reputationScore || 0)}
                        </div>
                        <div>Success Rate: {(encoder.successRate || 0).toFixed(0)}%</div>
                      </div>
                      <Separator />
                      <div className="text-sm">
                        <div className="font-medium mb-1">Pricing (per minute):</div>
                        <div className="grid grid-cols-2 gap-1 text-muted-foreground">
                          <span>1080p: {encoder.price1080p || "0.02"} HBD</span>
                          <span>720p: {encoder.price720p || "0.01"} HBD</span>
                          <span>480p: {encoder.price480p || "0.005"} HBD</span>
                          <span>Bundle: {encoder.priceAllQualities || "0.03"} HBD</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Encoding Preferences
              </CardTitle>
              <CardDescription>
                Configure your default encoding settings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="border-t pt-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Desktop Agent Auto-Detection</Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically use local encoding when agent is running
                      </p>
                    </div>
                    <Switch defaultChecked data-testid="switch-auto-detect" />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Browser Encoding Fallback</Label>
                      <p className="text-sm text-muted-foreground">
                        Use browser-based encoding for short videos if agent unavailable
                      </p>
                    </div>
                    <Switch defaultChecked data-testid="switch-browser-fallback" />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Community Encoder Fallback</Label>
                      <p className="text-sm text-muted-foreground">
                        Use community encoders if local options unavailable (costs HBD)
                      </p>
                    </div>
                    <Switch defaultChecked data-testid="switch-community-fallback" />
                  </div>
                </div>

                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                  <h4 className="font-medium flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-blue-500" />
                    Desktop Agent Benefits
                  </h4>
                  <ul className="text-sm text-muted-foreground mt-2 space-y-1">
                    <li>• Free encoding (no HBD cost)</li>
                    <li>• GPU acceleration (NVENC, VAAPI, QSV)</li>
                    <li>• Multi-quality HLS output (1080p/720p/480p)</li>
                    <li>• Direct IPFS upload to your node</li>
                    <li>• Earn HBD by encoding for others</li>
                  </ul>
                </div>

                {encoderStatus.browser.supported && (
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                    <h4 className="font-medium flex items-center gap-2">
                      <Globe className="h-4 w-4 text-green-500" />
                      Browser Encoding Available
                    </h4>
                    <p className="text-sm text-muted-foreground mt-2">
                      Your browser supports WebCodecs. You can encode short videos (under 2 minutes) 
                      directly in your browser at 480p quality for free.
                    </p>
                  </div>
                )}

                {!encoderStatus.browser.supported && encoderStatus.browser.missing.length > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
                    <h4 className="font-medium flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-yellow-500" />
                      Browser Encoding Unavailable
                    </h4>
                    <p className="text-sm text-muted-foreground mt-2">
                      Missing features: {encoderStatus.browser.missing.join(", ")}. 
                      Use Chrome 94+ or Edge 94+ for browser encoding support.
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
