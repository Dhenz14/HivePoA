import crypto from "crypto";

export interface IPFSClient {
  cat(cid: string): Promise<Buffer>;
  refs(cid: string): Promise<string[]>;
  add(content: Buffer | string): Promise<string>;
  addWithPin(content: Buffer | string): Promise<string>;
  pin(cid: string): Promise<void>;
  objectStat(cid: string): Promise<{ CumulativeSize: number }>;
  isOnline(): Promise<boolean>;
}

export class IPFSHttpClient implements IPFSClient {
  private baseUrl: string;
  
  constructor(apiUrl: string = "http://127.0.0.1:5001") {
    this.baseUrl = apiUrl + "/api/v0";
  }

  async isOnline(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/id`, { method: "POST" });
      return response.ok;
    } catch {
      return false;
    }
  }

  async cat(cid: string): Promise<Buffer> {
    const response = await fetch(`${this.baseUrl}/cat?arg=${cid}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`IPFS cat failed: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async refs(cid: string): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/refs?arg=${cid}&recursive=true&format=json`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`IPFS refs failed: ${response.statusText}`);
    }
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);
    const cids: string[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.Ref) {
          cids.push(obj.Ref);
        }
      } catch {
        const trimmed = line.trim();
        if (trimmed.startsWith("Qm") || trimmed.startsWith("bafy")) {
          cids.push(trimmed);
        }
      }
    }
    return cids;
  }

  async add(content: Buffer | string): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([content]);
    formData.append("file", blob);
    
    const response = await fetch(`${this.baseUrl}/add`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(`IPFS add failed: ${response.statusText}`);
    }
    const result = await response.json();
    return result.Hash;
  }

  async addWithPin(content: Buffer | string): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([content]);
    formData.append("file", blob);
    
    const response = await fetch(`${this.baseUrl}/add?pin=true`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(`IPFS add failed: ${response.statusText}`);
    }
    const result = await response.json();
    return result.Hash;
  }

  async pin(cid: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/pin/add?arg=${cid}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`IPFS pin failed: ${response.statusText}`);
    }
  }

  async objectStat(cid: string): Promise<{ CumulativeSize: number }> {
    const response = await fetch(`${this.baseUrl}/object/stat?arg=${cid}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`IPFS object/stat failed: ${response.statusText}`);
    }
    return await response.json();
  }
}

export class MockIPFSClient implements IPFSClient {
  private storage: Map<string, Buffer> = new Map();
  private refs_map: Map<string, string[]> = new Map();

  async isOnline(): Promise<boolean> {
    return true;
  }

  async cat(cid: string): Promise<Buffer> {
    const content = this.storage.get(cid);
    if (!content) {
      throw new Error(`CID not found: ${cid}`);
    }
    return content;
  }

  async refs(cid: string): Promise<string[]> {
    return this.refs_map.get(cid) || [];
  }

  async add(content: Buffer | string): Promise<string> {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const cid = `Qm${hash.slice(0, 44)}`;
    this.storage.set(cid, buffer);
    
    const blockCids: string[] = [];
    const blockSize = 256 * 1024;
    for (let i = 0; i < buffer.length; i += blockSize) {
      const block = buffer.slice(i, i + blockSize);
      const blockHash = crypto.createHash("sha256").update(block).digest("hex");
      const blockCid = `Qm${blockHash.slice(0, 44)}`;
      this.storage.set(blockCid, block);
      blockCids.push(blockCid);
    }
    this.refs_map.set(cid, blockCids);
    
    return cid;
  }

  async addWithPin(content: Buffer | string): Promise<string> {
    return this.add(content);
  }

  async pin(cid: string): Promise<void> {
    // No-op for mock
  }

  async objectStat(cid: string): Promise<{ CumulativeSize: number }> {
    const content = this.storage.get(cid);
    return { CumulativeSize: content?.length || 0 };
  }

  setContent(cid: string, content: Buffer, blockCids?: string[]) {
    this.storage.set(cid, content);
    if (blockCids) {
      this.refs_map.set(cid, blockCids);
    }
  }
}

let ipfsClientInstance: IPFSClient | null = null;
let lastApiUrl: string | undefined = undefined;

export function getIPFSClient(): IPFSClient {
  const ipfsUrl = process.env.IPFS_API_URL;
  
  if (ipfsClientInstance && lastApiUrl === ipfsUrl) {
    return ipfsClientInstance;
  }
  
  if (ipfsUrl) {
    ipfsClientInstance = new IPFSHttpClient(ipfsUrl);
    lastApiUrl = ipfsUrl;
  } else {
    ipfsClientInstance = new MockIPFSClient();
    lastApiUrl = undefined;
  }
  
  return ipfsClientInstance;
}

export function resetIPFSClient(): void {
  ipfsClientInstance = null;
  lastApiUrl = undefined;
}
