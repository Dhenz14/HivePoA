import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Play, Pin, Search, Eye, Clock, User, TrendingUp, Sparkles, Loader2 } from "lucide-react";

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
  tags: string[];
}

interface VideoResponse {
  videos: Video[];
  total: number;
  page: number;
  hasMore: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatViews(views: number): string {
  if (views >= 1000000) return `${(views / 1000000).toFixed(1)}M`;
  if (views >= 1000) return `${(views / 1000).toFixed(1)}K`;
  return views.toString();
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return `${Math.floor(diffDays / 30)} months ago`;
}

function VideoCard({ video, onPin, isPinning }: { video: Video; onPin: (cid: string) => void; isPinning: boolean }) {
  return (
    <Card data-testid={`video-card-${video.id}`} className="overflow-hidden hover:border-primary/50 transition-colors">
      <div className="relative aspect-video bg-muted">
        <img
          src={video.thumbnail}
          alt={video.title}
          className="w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).src = "https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=400";
          }}
        />
        <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-1 rounded">
          {formatDuration(video.duration)}
        </div>
        <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/40">
          <a
            href={`https://3speak.tv/watch?v=${video.author}/${video.permlink}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-primary text-primary-foreground rounded-full p-4"
            data-testid={`play-button-${video.id}`}
          >
            <Play className="h-8 w-8" />
          </a>
        </div>
      </div>
      <CardContent className="p-4">
        <h3 className="font-semibold text-sm line-clamp-2 mb-2" title={video.title}>
          {video.title}
        </h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          <div className="flex items-center gap-1">
            <User className="h-3 w-3" />
            <span>@{video.author}</span>
          </div>
          <span>•</span>
          <div className="flex items-center gap-1">
            <Eye className="h-3 w-3" />
            <span>{formatViews(video.views)}</span>
          </div>
          <span>•</span>
          <span>{formatDate(video.created)}</span>
        </div>
        <div className="flex flex-wrap gap-1 mb-3">
          {video.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
        <Button
          data-testid={`pin-button-${video.id}`}
          onClick={() => onPin(video.ipfs)}
          disabled={!video.ipfs || isPinning}
          className="w-full"
          size="sm"
        >
          {isPinning ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Pin className="h-4 w-4 mr-2" />
          )}
          {isPinning ? "Pinning..." : "Pin to My Node"}
        </Button>
        {video.ipfs && (
          <p className="text-xs text-muted-foreground mt-2 font-mono truncate" title={video.ipfs}>
            CID: {video.ipfs}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Browse() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("trending");
  const [pinningCid, setPinningCid] = useState<string | null>(null);
  const { toast } = useToast();

  const trendingQuery = useQuery<VideoResponse>({
    queryKey: ["/api/threespeak/trending"],
    enabled: activeTab === "trending",
  });

  const newQuery = useQuery<VideoResponse>({
    queryKey: ["/api/threespeak/new"],
    enabled: activeTab === "new",
  });

  const searchQueryResult = useQuery<VideoResponse>({
    queryKey: ["/api/threespeak/search", searchQuery],
    queryFn: async () => {
      const res = await fetch(`/api/threespeak/search?q=${encodeURIComponent(searchQuery)}`);
      return res.json();
    },
    enabled: activeTab === "search" && searchQuery.length > 0,
  });

  const pinMutation = useMutation({
    mutationFn: async (cid: string) => {
      const res = await fetch("/api/threespeak/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ipfs: cid }),
      });
      if (!res.ok) throw new Error("Pin failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Video Pinned!",
        description: `Successfully pinned to your IPFS node. CID: ${data.cid.slice(0, 12)}...`,
      });
      setPinningCid(null);
    },
    onError: (error: any) => {
      toast({
        title: "Pin Failed",
        description: error.message || "Could not pin video to IPFS",
        variant: "destructive",
      });
      setPinningCid(null);
    },
  });

  const handlePin = (cid: string) => {
    setPinningCid(cid);
    pinMutation.mutate(cid);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setActiveTab("search");
    }
  };

  const getVideos = () => {
    if (activeTab === "trending") return trendingQuery.data?.videos || [];
    if (activeTab === "new") return newQuery.data?.videos || [];
    if (activeTab === "search") return searchQueryResult.data?.videos || [];
    return [];
  };

  const isLoading = activeTab === "trending" ? trendingQuery.isLoading : 
                    activeTab === "new" ? newQuery.isLoading : 
                    searchQueryResult.isLoading;

  const videos = getVideos();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2" data-testid="browse-title">
            <Play className="h-8 w-8 text-primary" />
            Browse Network
          </h1>
          <p className="text-muted-foreground mt-1">
            Discover and pin 3Speak videos to your local IPFS node
          </p>
        </div>
        <form onSubmit={handleSearch} className="flex gap-2 w-full md:w-auto">
          <Input
            data-testid="search-input"
            placeholder="Search videos..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full md:w-64"
          />
          <Button type="submit" data-testid="search-button">
            <Search className="h-4 w-4" />
          </Button>
        </form>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="trending" data-testid="tab-trending" className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Trending
          </TabsTrigger>
          <TabsTrigger value="new" data-testid="tab-new" className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            New
          </TabsTrigger>
          {searchQuery && (
            <TabsTrigger value="search" data-testid="tab-search" className="flex items-center gap-2">
              <Search className="h-4 w-4" />
              Search Results
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value={activeTab} className="mt-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="ml-2">Loading videos...</span>
            </div>
          ) : videos.length === 0 ? (
            <Card className="p-12 text-center">
              <p className="text-muted-foreground">No videos found</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {videos.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  onPin={handlePin}
                  isPinning={pinningCid === video.ipfs}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Card className="mt-8 bg-muted/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Pin className="h-5 w-5" />
            How Pinning Works
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            When you pin a video, your local IPFS node downloads and stores the content. This:
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Helps preserve content on the decentralized network</li>
            <li>Makes the video available even if original host goes offline</li>
            <li>Earns you HBD rewards when others access content through your node</li>
            <li>Contributes to the SPK Network's storage redundancy</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
