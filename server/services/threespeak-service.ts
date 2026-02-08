/**
 * 3Speak Integration Service
 * Fetches videos from 3Speak platform for browsing and pinning
 */

export interface ThreeSpeakVideo {
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

export interface ThreeSpeakResponse {
  videos: ThreeSpeakVideo[];
  total: number;
  page: number;
  hasMore: boolean;
}

class ThreeSpeakService {
  private baseUrl = "https://3speak.tv";
  private apiUrl = "https://legacy.3speak.tv/apiv2";

  async getTrendingVideos(limit: number = 20, page: number = 1): Promise<ThreeSpeakResponse> {
    try {
      const response = await fetch(`${this.apiUrl}/feeds/trending?limit=${limit}&skip=${(page - 1) * limit}`);
      if (!response.ok) {
        console.log("[3Speak] API returned non-ok, using fallback data");
        return this.getFallbackVideos();
      }
      const data = await response.json();
      return this.transformResponse(data, page);
    } catch (error) {
      console.log("[3Speak] API error, using fallback data:", error);
      return this.getFallbackVideos();
    }
  }

  async getNewVideos(limit: number = 20, page: number = 1): Promise<ThreeSpeakResponse> {
    try {
      const response = await fetch(`${this.apiUrl}/feeds/new?limit=${limit}&skip=${(page - 1) * limit}`);
      if (!response.ok) {
        return this.getFallbackVideos();
      }
      const data = await response.json();
      return this.transformResponse(data, page);
    } catch (error) {
      console.log("[3Speak] API error, using fallback data");
      return this.getFallbackVideos();
    }
  }

  async searchVideos(query: string, limit: number = 20): Promise<ThreeSpeakResponse> {
    try {
      const response = await fetch(`${this.apiUrl}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      if (!response.ok) {
        return { videos: [], total: 0, page: 1, hasMore: false };
      }
      const data = await response.json();
      return this.transformResponse(data, 1);
    } catch (error) {
      console.log("[3Speak] Search error");
      return { videos: [], total: 0, page: 1, hasMore: false };
    }
  }

  async getVideoDetails(author: string, permlink: string): Promise<ThreeSpeakVideo | null> {
    try {
      const response = await fetch(`${this.apiUrl}/video/${author}/${permlink}`);
      if (!response.ok) {
        return null;
      }
      const data = await response.json();
      return this.transformVideo(data);
    } catch (error) {
      console.log("[3Speak] Video details error");
      return null;
    }
  }

  private transformResponse(data: any, page: number): ThreeSpeakResponse {
    const videos = Array.isArray(data) ? data : (data.videos || data.posts || []);
    return {
      videos: videos.map((v: any) => this.transformVideo(v)),
      total: data.total || videos.length,
      page,
      hasMore: videos.length >= 20,
    };
  }

  private extractCidFromUrl(url: string): string {
    if (!url) return "";
    const match = url.match(/\/ipfs\/(Qm[a-zA-Z0-9]+|baf[a-zA-Z0-9]+)/);
    return match ? match[1] : "";
  }

  private transformVideo(v: any): ThreeSpeakVideo {
    let ipfsHash = v.video_v2 || v.ipfs || v.video?.ipfs || "";
    
    if (!ipfsHash && v.playUrl) {
      ipfsHash = this.extractCidFromUrl(v.playUrl);
    }
    if (!ipfsHash && v.images?.ipfs_thumbnail) {
      ipfsHash = this.extractCidFromUrl(v.images.ipfs_thumbnail);
    }
    
    return {
      id: v._id || v.permlink || `${v.author}-${v.permlink}`,
      permlink: v.permlink || "",
      author: v.author || v.owner || "",
      title: v.title || "Untitled",
      description: v.description || v.body || "",
      thumbnail: v.thumbUrl || v.thumbnail || v.images?.thumbnail || `https://images.3speak.tv/${v.permlink}/thumbnail.png`,
      duration: v.duration || v.video?.duration || 0,
      views: v.views || v.total_views || 0,
      created: v.created || v.created_at || new Date().toISOString(),
      ipfs: ipfsHash,
      sourceMap: v.sourceMap || [],
      tags: v.tags || [],
    };
  }

  private getFallbackVideos(): ThreeSpeakResponse {
    const fallbackVideos: ThreeSpeakVideo[] = [
      {
        id: "1",
        permlink: "decentralized-web-future",
        author: "threespeak",
        title: "The Future of Decentralized Web",
        description: "Exploring how IPFS and blockchain are changing the internet",
        thumbnail: "https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=400",
        duration: 845,
        views: 12500,
        created: "2024-12-15T10:00:00Z",
        ipfs: "QmenNBhE332Bb9gXfuxULYHHhZYppL5LoWUvKkm51h8Crq",
        tags: ["technology", "web3", "ipfs"],
      },
      {
        id: "2",
        permlink: "hive-blockchain-101",
        author: "hiveblocks",
        title: "Hive Blockchain 101: Getting Started",
        description: "Complete beginner's guide to the Hive ecosystem",
        thumbnail: "https://images.unsplash.com/photo-1642104704074-907c0698b98d?w=400",
        duration: 1230,
        views: 8900,
        created: "2024-12-14T15:30:00Z",
        ipfs: "QmXCTTGyNTxqiUCpwugEvxYFo9t8gQeo4T1xdxxt4A2CYc",
        tags: ["hive", "blockchain", "tutorial"],
      },
      {
        id: "3",
        permlink: "spk-network-deep-dive",
        author: "spknetwork",
        title: "SPK Network Deep Dive",
        description: "Technical overview of SPK Network's decentralized storage",
        thumbnail: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=400",
        duration: 2100,
        views: 5600,
        created: "2024-12-13T09:15:00Z",
        ipfs: "QmdU1V8Eefmv5E77Ct6hNG8A3f9b75dZmVS6ZVvw5ynnrn",
        tags: ["spk", "storage", "ipfs"],
      },
      {
        id: "4",
        permlink: "crypto-art-creation",
        author: "nftcreator",
        title: "Creating Digital Art for Web3",
        description: "Tips and techniques for crypto artists",
        thumbnail: "https://images.unsplash.com/photo-1634986666676-ec8fd927c23d?w=400",
        duration: 1560,
        views: 4200,
        created: "2024-12-12T14:00:00Z",
        ipfs: "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn",
        tags: ["art", "nft", "creative"],
      },
      {
        id: "5",
        permlink: "community-governance",
        author: "hivegov",
        title: "Decentralized Governance Explained",
        description: "How DAOs and community voting works",
        thumbnail: "https://images.unsplash.com/photo-1553028826-f4804a6dba3b?w=400",
        duration: 980,
        views: 3100,
        created: "2024-12-11T11:45:00Z",
        ipfs: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        tags: ["governance", "dao", "community"],
      },
      {
        id: "6",
        permlink: "ipfs-pinning-guide",
        author: "ipfsmaster",
        title: "IPFS Pinning: Keep Your Content Alive",
        description: "Why pinning matters and how to do it right",
        thumbnail: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400",
        duration: 720,
        views: 7800,
        created: "2024-12-10T16:20:00Z",
        ipfs: "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o",
        tags: ["ipfs", "pinning", "storage"],
      },
    ];
    
    return {
      videos: fallbackVideos,
      total: fallbackVideos.length,
      page: 1,
      hasMore: false,
    };
  }
}

export const threespeakService = new ThreeSpeakService();
