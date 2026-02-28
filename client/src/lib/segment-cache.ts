/**
 * Segment Cache — Persists HLS video segments in IndexedDB
 *
 * When a viewer watches a video, segments are cached locally.
 * On future visits, cached segments can be served to the P2P swarm,
 * making returning viewers act as CDN nodes.
 *
 * Uses raw IndexedDB (not Helia) for performance — segments are stored
 * as ArrayBuffers keyed by URL.
 */

const DB_NAME = 'hivepoa-segment-cache';
const DB_VERSION = 1;
const STORE_NAME = 'segments';
const INDEX_KEY = 'hivepoa_segment_index';
const MAX_CACHE_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SegmentMeta {
  url: string;
  size: number;
  videoCid: string;
  cachedAt: number;
}

export class SegmentCache {
  private db: IDBDatabase | null = null;
  private index: Map<string, SegmentMeta> = new Map();
  private totalSize: number = 0;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      this.db = await this.openDB();
      this.loadIndex();
      await this.pruneExpired();
      this.initialized = true;
      console.log(`[SegmentCache] Ready — ${this.index.size} segments, ${this.formatBytes(this.totalSize)}`);
    } catch (err) {
      console.warn('[SegmentCache] Failed to initialize:', err);
      this.initPromise = null;
    }
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async cacheSegment(url: string, data: ArrayBuffer, videoCid: string): Promise<void> {
    if (!this.db || !this.initialized) return;
    if (this.index.has(url)) return; // Already cached

    const size = data.byteLength;
    if (size === 0) return;

    // Evict if adding this would exceed budget
    while (this.totalSize + size > MAX_CACHE_SIZE_BYTES && this.index.size > 0) {
      await this.evictOldest();
    }

    try {
      await this.putToDB(url, data);

      const meta: SegmentMeta = { url, size, videoCid, cachedAt: Date.now() };
      this.index.set(url, meta);
      this.totalSize += size;
      this.saveIndex();
    } catch {
      // IndexedDB write failed — not critical
    }
  }

  async getSegment(url: string): Promise<ArrayBuffer | null> {
    if (!this.db || !this.initialized) return null;
    if (!this.index.has(url)) return null;

    try {
      return await this.getFromDB(url);
    } catch {
      // Entry in index but not in DB — remove stale index entry
      this.index.delete(url);
      this.saveIndex();
      return null;
    }
  }

  hasSegment(url: string): boolean {
    return this.index.has(url);
  }

  getStats(): { totalSegments: number; totalSizeBytes: number; totalSizeFormatted: string; videoCids: string[] } {
    const videoCids = Array.from(new Set(Array.from(this.index.values()).map(m => m.videoCid)));
    return {
      totalSegments: this.index.size,
      totalSizeBytes: this.totalSize,
      totalSizeFormatted: this.formatBytes(this.totalSize),
      videoCids,
    };
  }

  private putToDB(key: string, data: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('DB not open'));
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private getFromDB(key: string): Promise<ArrayBuffer | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('DB not open'));
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  private deleteFromDB(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('DB not open'));
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async evictOldest(): Promise<void> {
    let oldest: SegmentMeta | null = null;
    const values = Array.from(this.index.values());
    for (const meta of values) {
      if (!oldest || meta.cachedAt < oldest.cachedAt) {
        oldest = meta;
      }
    }
    if (!oldest) return;

    try {
      await this.deleteFromDB(oldest.url);
    } catch {}
    this.totalSize -= oldest.size;
    this.index.delete(oldest.url);
  }

  private async pruneExpired(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];
    for (const [url, meta] of Array.from(this.index.entries())) {
      if (now - meta.cachedAt > MAX_CACHE_AGE_MS) {
        expired.push(url);
      }
    }
    for (const url of expired) {
      const meta = this.index.get(url);
      if (meta) this.totalSize -= meta.size;
      this.index.delete(url);
      try {
        await this.deleteFromDB(url);
      } catch {}
    }
    if (expired.length > 0) {
      this.saveIndex();
      console.log(`[SegmentCache] Pruned ${expired.length} expired segments`);
    }
  }

  private saveIndex(): void {
    try {
      const entries = Array.from(this.index.values());
      localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
    } catch {}
  }

  private loadIndex(): void {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      if (!raw) return;
      const entries: SegmentMeta[] = JSON.parse(raw);
      this.index.clear();
      this.totalSize = 0;
      for (const meta of entries) {
        this.index.set(meta.url, meta);
        this.totalSize += meta.size;
      }
    } catch {}
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

let instance: SegmentCache | null = null;

export function getSegmentCache(): SegmentCache {
  if (!instance) {
    instance = new SegmentCache();
  }
  return instance;
}
