/**
 * Wallet Manager — Encrypted key storage and signing for the SPK desktop agent.
 *
 * Stores private keys encrypted with AES-256-GCM, derived from a user password
 * via PBKDF2. Keys are decrypted only when needed for signing, then held in
 * memory for the session lifetime. Works on all platforms without Electron.
 *
 * Wallet file format (~/.spk-ipfs/wallet.json):
 * {
 *   version: 1,
 *   salt: <hex>,              // PBKDF2 salt
 *   keys: {
 *     active:  { encrypted: <hex>, iv: <hex>, tag: <hex>, publicKey: <string> },
 *     posting: { encrypted: <hex>, iv: <hex>, tag: <hex>, publicKey: <string> },
 *   }
 * }
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PrivateKey } from "@hiveio/dhive";

interface EncryptedKey {
  encrypted: string; // hex
  iv: string;        // hex
  tag: string;       // hex
  publicKey: string;  // STMxxx...
}

interface WalletFile {
  version: 1;
  salt: string; // hex
  keys: {
    active?: EncryptedKey;
    posting?: EncryptedKey;
  };
}

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32; // AES-256
const WALLET_VERSION = 1;

export class WalletManager {
  private walletPath: string = "";
  private derivedKey: Buffer | null = null;
  private walletData: WalletFile | null = null;

  // Cached decrypted keys (in memory for session duration)
  private activeKeyCache: string | null = null;
  private postingKeyCache: string | null = null;

  /**
   * Initialize the wallet. Creates or opens the wallet file.
   * Must be called before any other operations.
   */
  async init(storageDir: string, password: string): Promise<void> {
    this.walletPath = path.join(storageDir, "wallet.json");
    fs.mkdirSync(storageDir, { recursive: true });

    if (fs.existsSync(this.walletPath)) {
      // Open existing wallet
      const raw = fs.readFileSync(this.walletPath, "utf-8");
      this.walletData = JSON.parse(raw) as WalletFile;
      this.derivedKey = this.deriveKey(password, Buffer.from(this.walletData.salt, "hex"));
      // Verify password by trying to decrypt any existing key
      if (this.walletData.keys.active) {
        try {
          this.activeKeyCache = this.decrypt(this.walletData.keys.active);
        } catch {
          this.derivedKey = null;
          this.walletData = null;
          throw new Error("Invalid wallet password");
        }
      }
      if (this.walletData.keys.posting) {
        try {
          this.postingKeyCache = this.decrypt(this.walletData.keys.posting);
        } catch {
          this.derivedKey = null;
          this.walletData = null;
          throw new Error("Invalid wallet password");
        }
      }
    } else {
      // Create new wallet
      const salt = crypto.randomBytes(32);
      this.derivedKey = this.deriveKey(password, salt);
      this.walletData = {
        version: WALLET_VERSION,
        salt: salt.toString("hex"),
        keys: {},
      };
      this.save();
    }
  }

  /**
   * Import an active key. Encrypts and persists to wallet file.
   * Returns the corresponding public key (STM format).
   */
  importActiveKey(privateKey: string): string {
    this.ensureUnlocked();
    const pubKey = PrivateKey.fromString(privateKey).createPublic().toString();
    this.walletData!.keys.active = this.encrypt(privateKey, pubKey);
    this.activeKeyCache = privateKey;
    this.save();
    return pubKey;
  }

  /**
   * Import a posting key. Encrypts and persists to wallet file.
   * Returns the corresponding public key (STM format).
   */
  importPostingKey(privateKey: string): string {
    this.ensureUnlocked();
    const pubKey = PrivateKey.fromString(privateKey).createPublic().toString();
    this.walletData!.keys.posting = this.encrypt(privateKey, pubKey);
    this.postingKeyCache = privateKey;
    this.save();
    return pubKey;
  }

  /**
   * Sign a hex digest using the active key.
   * Returns the signature as a hex string, or null if no active key.
   */
  signDigest(digestHex: string): string | null {
    if (!this.activeKeyCache) return null;
    const digestBuffer = Buffer.from(digestHex, "hex");
    const key = PrivateKey.fromString(this.activeKeyCache);
    return key.sign(digestBuffer).toString();
  }

  hasActiveKey(): boolean {
    return !!this.walletData?.keys.active;
  }

  hasPostingKey(): boolean {
    return !!this.walletData?.keys.posting;
  }

  getActivePublicKey(): string | null {
    return this.walletData?.keys.active?.publicKey ?? null;
  }

  getPostingPublicKey(): string | null {
    return this.walletData?.keys.posting?.publicKey ?? null;
  }

  /** Get the decrypted posting key for Hive broadcast operations. */
  getPostingKey(): string | null {
    return this.postingKeyCache;
  }

  removeActiveKey(): void {
    this.ensureUnlocked();
    delete this.walletData!.keys.active;
    this.activeKeyCache = null;
    this.save();
  }

  removePostingKey(): void {
    this.ensureUnlocked();
    delete this.walletData!.keys.posting;
    this.postingKeyCache = null;
    this.save();
  }

  isInitialized(): boolean {
    return this.walletData !== null && this.derivedKey !== null;
  }

  /**
   * Check if a wallet file exists at the given storage dir.
   */
  static walletExists(storageDir: string): boolean {
    return fs.existsSync(path.join(storageDir, "wallet.json"));
  }

  close(): void {
    // Zero out sensitive data
    if (this.derivedKey) {
      this.derivedKey.fill(0);
      this.derivedKey = null;
    }
    this.activeKeyCache = null;
    this.postingKeyCache = null;
    this.walletData = null;
  }

  // --- Private helpers ---

  private deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
  }

  private encrypt(plaintext: string, publicKey: string): EncryptedKey {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.derivedKey!, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: encrypted.toString("hex"),
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      publicKey,
    };
  }

  private decrypt(entry: EncryptedKey): string {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.derivedKey!,
      Buffer.from(entry.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    return decipher.update(Buffer.from(entry.encrypted, "hex"), undefined, "utf-8") + decipher.final("utf-8");
  }

  private save(): void {
    fs.writeFileSync(this.walletPath, JSON.stringify(this.walletData, null, 2));
  }

  private ensureUnlocked(): void {
    if (!this.derivedKey || !this.walletData) {
      throw new Error("Wallet not initialized — call init() first");
    }
  }
}
