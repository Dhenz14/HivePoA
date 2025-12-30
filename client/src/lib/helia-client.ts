/**
 * Helia Browser IPFS Client
 * Repurposed from SPK Network patterns - provides in-browser IPFS node
 * that auto-initializes on first use. Data persists in IndexedDB.
 */

import { createHelia, type Helia } from "helia";
import { unixfs, type UnixFS } from "@helia/unixfs";
import { IDBBlockstore } from "blockstore-idb";
import { IDBDatastore } from "datastore-idb";

export interface HeliaNodeStatus {
  initialized: boolean;
  peerId: string | null;
  isOnline: boolean;
  repoSize: number;
  numObjects: number;
}

export interface HeliaClient {
  initialize(): Promise<boolean>;
  stop(): Promise<void>;
  isOnline(): Promise<boolean>;
  getStatus(): Promise<HeliaNodeStatus>;
  add(content: Uint8Array | string): Promise<string>;
  cat(cid: string): Promise<Uint8Array>;
  pin(cid: string): Promise<void>;
  unpin(cid: string): Promise<void>;
  getPeerId(): string | null;
}

class BrowserHeliaClient implements HeliaClient {
  private helia: Helia | null = null;
  private fs: UnixFS | null = null;
  private blockstore: IDBBlockstore | null = null;
  private datastore: IDBDatastore | null = null;
  private peerId: string | null = null;
  private initializing: Promise<boolean> | null = null;

  async initialize(): Promise<boolean> {
    if (this.helia) {
      return true;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = this._doInitialize();
    return this.initializing;
  }

  private async _doInitialize(): Promise<boolean> {
    try {
      console.log("[Helia] Initializing browser IPFS node...");

      this.blockstore = new IDBBlockstore("hivepoa-blocks");
      this.datastore = new IDBDatastore("hivepoa-data");

      await this.blockstore.open();
      await this.datastore.open();

      this.helia = await createHelia({
        blockstore: this.blockstore,
        datastore: this.datastore,
      });

      this.fs = unixfs(this.helia);
      this.peerId = this.helia.libp2p.peerId.toString();

      console.log("[Helia] Browser node ready! PeerId:", this.peerId);
      return true;
    } catch (err: any) {
      console.error("[Helia] Failed to initialize:", err);
      this.initializing = null;
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.helia) {
      await this.helia.stop();
      this.helia = null;
      this.fs = null;
    }
    if (this.blockstore) {
      await this.blockstore.close();
      this.blockstore = null;
    }
    if (this.datastore) {
      await this.datastore.close();
      this.datastore = null;
    }
    this.peerId = null;
    this.initializing = null;
    console.log("[Helia] Browser node stopped");
  }

  async isOnline(): Promise<boolean> {
    return this.helia !== null;
  }

  getPeerId(): string | null {
    return this.peerId;
  }

  async getStatus(): Promise<HeliaNodeStatus> {
    if (!this.helia) {
      return {
        initialized: false,
        peerId: null,
        isOnline: false,
        repoSize: 0,
        numObjects: 0,
      };
    }

    return {
      initialized: true,
      peerId: this.peerId,
      isOnline: true,
      repoSize: 0,
      numObjects: 0,
    };
  }

  async add(content: Uint8Array | string): Promise<string> {
    await this.ensureInitialized();

    const data = typeof content === "string" 
      ? new TextEncoder().encode(content) 
      : content;

    const cid = await this.fs!.addBytes(data);
    console.log("[Helia] Added content:", cid.toString());
    return cid.toString();
  }

  async cat(cid: string): Promise<Uint8Array> {
    await this.ensureInitialized();

    const { CID } = await import("multiformats/cid");
    const parsedCid = CID.parse(cid);

    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs!.cat(parsedCid)) {
      chunks.push(chunk);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  async pin(cid: string): Promise<void> {
    await this.ensureInitialized();

    const { CID } = await import("multiformats/cid");
    const parsedCid = CID.parse(cid);

    await this.helia!.pins.add(parsedCid);
    console.log("[Helia] Pinned:", cid);
  }

  async unpin(cid: string): Promise<void> {
    await this.ensureInitialized();

    const { CID } = await import("multiformats/cid");
    const parsedCid = CID.parse(cid);

    await this.helia!.pins.rm(parsedCid);
    console.log("[Helia] Unpinned:", cid);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.helia) {
      const success = await this.initialize();
      if (!success) {
        throw new Error("Failed to initialize Helia browser node");
      }
    }
  }
}

let browserClient: BrowserHeliaClient | null = null;

export function getHeliaClient(): HeliaClient {
  if (!browserClient) {
    browserClient = new BrowserHeliaClient();
  }
  return browserClient;
}

export async function initializeHeliaNode(): Promise<boolean> {
  const client = getHeliaClient();
  return client.initialize();
}

export async function stopHeliaNode(): Promise<void> {
  if (browserClient) {
    await browserClient.stop();
    browserClient = null;
  }
}
