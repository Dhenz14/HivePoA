import * as fs from "fs";
import * as path from "path";

export interface VariantStream {
  name: string;
  bandwidth: number;
  resolution: { width: number; height: number };
  codecs: string;
  playlistPath: string;
  segmentCount?: number;
  duration?: number;
}

export interface HLSManifestConfig {
  outputDir: string;
  variants: VariantStream[];
  baseUrl?: string;
}

export interface SegmentInfo {
  index: number;
  filename: string;
  duration: number;
  path: string;
  size: number;
}

export interface MasterPlaylistResult {
  masterPlaylistPath: string;
  masterPlaylistContent: string;
  variants: VariantStream[];
}

export const QUALITY_BANDWIDTH_MAP: Record<string, { bandwidth: number; resolution: { width: number; height: number } }> = {
  "1080p": { bandwidth: 4500000, resolution: { width: 1920, height: 1080 } },
  "720p": { bandwidth: 2500000, resolution: { width: 1280, height: 720 } },
  "480p": { bandwidth: 1000000, resolution: { width: 854, height: 480 } },
  "360p": { bandwidth: 600000, resolution: { width: 640, height: 360 } },
  "240p": { bandwidth: 300000, resolution: { width: 426, height: 240 } },
};

export class HLSProcessor {
  generateMasterPlaylist(config: HLSManifestConfig): MasterPlaylistResult {
    const lines: string[] = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
    ];

    const sortedVariants = [...config.variants].sort((a, b) => b.bandwidth - a.bandwidth);

    for (const variant of sortedVariants) {
      const playlistRelPath = config.baseUrl
        ? `${config.baseUrl}/${variant.name}/playlist.m3u8`
        : `${variant.name}/playlist.m3u8`;

      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.resolution.width}x${variant.resolution.height},CODECS="${variant.codecs}",NAME="${variant.name}"`,
        playlistRelPath
      );
    }

    const content = lines.join("\n") + "\n";
    const masterPath = path.join(config.outputDir, "master.m3u8");

    fs.writeFileSync(masterPath, content, "utf-8");

    return {
      masterPlaylistPath: masterPath,
      masterPlaylistContent: content,
      variants: sortedVariants,
    };
  }

  generateIPFSCompatibleMasterPlaylist(
    outputDir: string,
    variants: VariantStream[],
    cidMap?: Record<string, string>
  ): MasterPlaylistResult {
    const lines: string[] = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-INDEPENDENT-SEGMENTS",
    ];

    const sortedVariants = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);

    for (const variant of sortedVariants) {
      const playlistPath = cidMap && cidMap[variant.name]
        ? cidMap[variant.name]
        : `${variant.name}/playlist.m3u8`;

      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},AVERAGE-BANDWIDTH=${Math.round(variant.bandwidth * 0.8)},RESOLUTION=${variant.resolution.width}x${variant.resolution.height},CODECS="${variant.codecs}",FRAME-RATE=30.000,NAME="${variant.name}"`,
        playlistPath
      );
    }

    const content = lines.join("\n") + "\n";
    const masterPath = path.join(outputDir, "master.m3u8");

    fs.writeFileSync(masterPath, content, "utf-8");

    return {
      masterPlaylistPath: masterPath,
      masterPlaylistContent: content,
      variants: sortedVariants,
    };
  }

  parseVariantPlaylist(playlistPath: string): SegmentInfo[] {
    const content = fs.readFileSync(playlistPath, "utf-8");
    const lines = content.split("\n");
    const segments: SegmentInfo[] = [];
    const playlistDir = path.dirname(playlistPath);

    let currentDuration = 0;
    let index = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXTINF:")) {
        const durationMatch = line.match(/#EXTINF:([\d.]+)/);
        if (durationMatch) {
          currentDuration = parseFloat(durationMatch[1]);
        }
      } else if (line.endsWith(".ts") && !line.startsWith("#")) {
        const segmentPath = path.join(playlistDir, line);
        let size = 0;

        try {
          const stats = fs.statSync(segmentPath);
          size = stats.size;
        } catch { /* segment may not exist yet */ }

        segments.push({
          index,
          filename: line,
          duration: currentDuration,
          path: segmentPath,
          size,
        });

        index++;
        currentDuration = 0;
      }
    }

    return segments;
  }

  rewritePlaylistForIPFS(
    playlistPath: string,
    segmentCidMap: Record<string, string>,
    gatewayUrl?: string
  ): string {
    const content = fs.readFileSync(playlistPath, "utf-8");
    const lines = content.split("\n");
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.endsWith(".ts") && !line.startsWith("#")) {
        const filename = path.basename(line);
        const cid = segmentCidMap[filename];

        if (cid) {
          if (gatewayUrl) {
            newLines.push(`${gatewayUrl}/ipfs/${cid}`);
          } else {
            newLines.push(cid);
          }
        } else {
          newLines.push(line);
        }
      } else {
        newLines.push(line);
      }
    }

    const rewrittenContent = newLines.join("\n");
    fs.writeFileSync(playlistPath, rewrittenContent, "utf-8");

    return rewrittenContent;
  }

  createVariantFromDirectory(qualityDir: string, qualityName: string): VariantStream | null {
    const playlistPath = path.join(qualityDir, "playlist.m3u8");

    if (!fs.existsSync(playlistPath)) {
      return null;
    }

    const segments = this.parseVariantPlaylist(playlistPath);
    const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

    const qualityInfo = QUALITY_BANDWIDTH_MAP[qualityName] || {
      bandwidth: 1000000,
      resolution: { width: 854, height: 480 },
    };

    return {
      name: qualityName,
      bandwidth: qualityInfo.bandwidth,
      resolution: qualityInfo.resolution,
      codecs: "avc1.640028,mp4a.40.2",
      playlistPath,
      segmentCount: segments.length,
      duration: totalDuration,
    };
  }

  generateMasterFromDirectory(outputDir: string): MasterPlaylistResult | null {
    const qualityDirs = fs.readdirSync(outputDir).filter((name) => {
      const fullPath = path.join(outputDir, name);
      return fs.statSync(fullPath).isDirectory() && QUALITY_BANDWIDTH_MAP[name];
    });

    if (qualityDirs.length === 0) {
      return null;
    }

    const variants: VariantStream[] = [];

    for (const qualityName of qualityDirs) {
      const qualityDir = path.join(outputDir, qualityName);
      const variant = this.createVariantFromDirectory(qualityDir, qualityName);

      if (variant) {
        variants.push(variant);
      }
    }

    if (variants.length === 0) {
      return null;
    }

    return this.generateMasterPlaylist({
      outputDir,
      variants,
    });
  }

  calculateTotalSize(outputDir: string): number {
    let totalSize = 0;

    const processDir = (dir: string) => {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          processDir(fullPath);
        } else {
          totalSize += stats.size;
        }
      }
    };

    processDir(outputDir);
    return totalSize;
  }

  getEncodingManifest(outputDir: string): {
    masterPlaylist: string;
    variants: VariantStream[];
    totalSize: number;
    totalDuration: number;
    segmentCount: number;
  } | null {
    const masterPath = path.join(outputDir, "master.m3u8");

    if (!fs.existsSync(masterPath)) {
      const generated = this.generateMasterFromDirectory(outputDir);
      if (!generated) return null;
    }

    const qualityDirs = fs.readdirSync(outputDir).filter((name) => {
      const fullPath = path.join(outputDir, name);
      return fs.statSync(fullPath).isDirectory();
    });

    const variants: VariantStream[] = [];
    let totalSegments = 0;
    let maxDuration = 0;

    for (const qualityName of qualityDirs) {
      const variant = this.createVariantFromDirectory(
        path.join(outputDir, qualityName),
        qualityName
      );

      if (variant) {
        variants.push(variant);
        totalSegments += variant.segmentCount || 0;
        maxDuration = Math.max(maxDuration, variant.duration || 0);
      }
    }

    return {
      masterPlaylist: fs.readFileSync(masterPath, "utf-8"),
      variants,
      totalSize: this.calculateTotalSize(outputDir),
      totalDuration: maxDuration,
      segmentCount: totalSegments,
    };
  }

  generateSegmentNames(
    prefix: string,
    count: number,
    extension = ".ts"
  ): string[] {
    const segments: string[] = [];

    for (let i = 0; i < count; i++) {
      segments.push(`${prefix}_${String(i).padStart(3, "0")}${extension}`);
    }

    return segments;
  }

  validatePlaylist(playlistPath: string): {
    valid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!fs.existsSync(playlistPath)) {
      return { valid: false, errors: ["Playlist file does not exist"], warnings };
    }

    const content = fs.readFileSync(playlistPath, "utf-8");
    const lines = content.split("\n");

    if (!lines[0].includes("#EXTM3U")) {
      errors.push("Missing #EXTM3U header");
    }

    const hasVersion = lines.some((l) => l.startsWith("#EXT-X-VERSION"));
    if (!hasVersion) {
      warnings.push("Missing #EXT-X-VERSION tag");
    }

    const playlistDir = path.dirname(playlistPath);
    let hasSegments = false;

    for (const line of lines) {
      if (line.endsWith(".ts") && !line.startsWith("#")) {
        hasSegments = true;
        const segmentPath = path.join(playlistDir, line);

        if (!fs.existsSync(segmentPath)) {
          errors.push(`Missing segment: ${line}`);
        }
      }
    }

    if (!hasSegments) {
      errors.push("No segments found in playlist");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

export const hlsProcessor = new HLSProcessor();
