import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useDesktopAgent } from "@/hooks/use-desktop-agent";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { P2PVideoPlayer } from "@/components/video/P2PVideoPlayer";
import { getApiBase } from "@/lib/api-mode";
import {
  ArrowLeft,
  Pin,
  CheckCircle2,
  User,
  Eye,
  Calendar,
  Monitor,
  Download,
  ExternalLink,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Video {
  id: string;
  permlink: string;
  author: string;
  title: string;
  description: string;
  thumbnail: string;
  duration: number;
  views: number;
  created: string;
  ipfs: string;
  sourceMap?: Array<{ type: string; url: string }>;
  tags: string[];
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatViews(views: number): string {
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
}

function getVideoUrl(video: Video): string {
  // Try sourceMap for direct playback URL
  const mp4Source = video.sourceMap?.find(
    (s) => s.type === "video/mp4" && s.url
  );
  if (mp4Source) return mp4Source.url;

  // Try HLS manifest from sourceMap
  const hlsSource = video.sourceMap?.find(
    (s) =>
      (s.type === "application/x-mpegURL" ||
        s.type === "application/vnd.apple.mpegurl") &&
      s.url
  );
  if (hlsSource) return hlsSource.url;

  // Fallback: IPFS gateway URL
  if (video.ipfs) {
    return `https://ipfs.3speak.tv/ipfs/${video.ipfs}`;
  }

  return "";
}

export default function Watch() {
  const [, params] = useRoute("/watch/:author/:permlink");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { isRunning: agentRunning, check: checkAgent } = useDesktopAgent();
  const { user } = useValidatorAuth();
  const [isPinned, setIsPinned] = useState(false);
  const [showAgentPrompt, setShowAgentPrompt] = useState(false);

  const author = params?.author || "";
  const permlink = params?.permlink || "";

  const videoQuery = useQuery<Video>({
    queryKey: [`/api/threespeak/video/${author}/${permlink}`],
    enabled: !!author && !!permlink,
  });

  const pinMutation = useMutation({
    mutationFn: async (video: Video) => {
      const res = await fetch(`${getApiBase()}/api/threespeak/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ipfs: video.ipfs,
          title: video.title,
          author: video.author,
        }),
      });
      if (!res.ok) throw new Error("Pin failed");
      return res.json();
    },
    onSuccess: () => {
      setIsPinned(true);
      toast({
        title: "Pin Started",
        description: "Video is being downloaded to your node.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Pin Failed",
        description: error.message || "Could not pin video",
        variant: "destructive",
      });
    },
  });

  const handlePin = async () => {
    if (!videoQuery.data) return;
    const running = await checkAgent();
    if (!running) {
      setShowAgentPrompt(true);
      return;
    }
    pinMutation.mutate(videoQuery.data);
  };

  if (videoQuery.isLoading) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (videoQuery.error || !videoQuery.data) {
    return (
      <div className="container mx-auto p-6">
        <Button
          variant="ghost"
          onClick={() => setLocation("/browse")}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Browse
        </Button>
        <Card className="p-12 text-center">
          <p className="text-muted-foreground">Video not found</p>
        </Card>
      </div>
    );
  }

  const video = videoQuery.data;
  const videoUrl = getVideoUrl(video);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Button
        variant="ghost"
        onClick={() => setLocation("/browse")}
        className="mb-2"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Browse
      </Button>

      {/* Video Player */}
      {videoUrl ? (
        <P2PVideoPlayer
          manifestUrl={videoUrl}
          videoCid={video.ipfs}
          title={video.title}
          poster={video.thumbnail}
          autoPlay
          showStats
          p2pEnabled
          hiveUsername={user?.username}
        />
      ) : (
        <Card className="aspect-video flex items-center justify-center bg-muted">
          <p className="text-muted-foreground">No playback source available</p>
        </Card>
      )}

      {/* Video Info */}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-4">
          <h1 className="text-2xl font-bold">{video.title}</h1>

          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1">
              <User className="h-4 w-4" />
              <span>@{video.author}</span>
            </div>
            <div className="flex items-center gap-1">
              <Eye className="h-4 w-4" />
              <span>{formatViews(video.views)} views</span>
            </div>
            <div className="flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              <span>{formatDate(video.created)}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {video.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>

          {video.description && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {video.description}
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Actions Sidebar */}
        <div className="lg:w-80 space-y-4">
          {/* Pin to Node */}
          {video.ipfs && (
            <Card>
              <CardContent className="p-4 space-y-3">
                <h3 className="font-semibold text-sm">Store on Your Node</h3>
                <p className="text-xs text-muted-foreground">
                  Pin this video to your IPFS node to help distribute it and
                  earn HBD rewards.
                </p>
                {isPinned ? (
                  <Button
                    disabled
                    variant="outline"
                    className="w-full border-green-500 text-green-500"
                  >
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Pinning Started
                  </Button>
                ) : (
                  <Button
                    onClick={handlePin}
                    className="w-full"
                    disabled={pinMutation.isPending}
                  >
                    <Pin className="h-4 w-4 mr-2" />
                    Pin to My Node
                  </Button>
                )}
                <p className="text-xs text-muted-foreground font-mono truncate">
                  CID: {video.ipfs}
                </p>
              </CardContent>
            </Card>
          )}

          {/* View on 3Speak */}
          <Card>
            <CardContent className="p-4">
              <a
                href={`https://3speak.tv/watch?v=${video.author}/${video.permlink}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="h-4 w-4" />
                View on 3Speak
              </a>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Desktop Agent Prompt */}
      <Dialog open={showAgentPrompt} onOpenChange={setShowAgentPrompt}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5 text-primary" />
              Desktop Agent Required
            </DialogTitle>
            <DialogDescription>
              The SPK Desktop Agent must be running to pin content to your local
              IPFS node and earn HBD rewards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="rounded-lg border bg-muted/50 p-4 space-y-2 text-sm">
              <p className="font-medium">The Desktop Agent:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Runs a local IPFS node for content storage</li>
                <li>Responds to Proof-of-Access challenges</li>
                <li>Earns HBD rewards automatically</li>
              </ul>
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowAgentPrompt(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={() => (window.location.href = "/download")}
              >
                <Download className="h-4 w-4 mr-2" />
                Download Agent
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
