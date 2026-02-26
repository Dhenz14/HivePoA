/**
 * Encryption Service
 * Phase 4: End-to-end encryption for private content
 * 
 * Uses AES-GCM for symmetric encryption
 * Keys can be derived from Hive posting key or generated independently
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash, pbkdf2Sync, hkdfSync } from "crypto";
import { storage } from "../storage";
import type { UserKey } from "@shared/schema";

export interface EncryptionResult {
  encryptedData: Buffer;
  nonce: string; // Base64 encoded
  algorithm: string;
}

export interface DecryptionResult {
  success: boolean;
  data?: Buffer;
  error?: string;
}

export class EncryptionService {
  private readonly ALGORITHM = 'aes-256-gcm';
  private readonly KEY_LENGTH = 32; // 256 bits
  private readonly NONCE_LENGTH = 12; // 96 bits for GCM
  private readonly AUTH_TAG_LENGTH = 16;
  private readonly PBKDF2_ITERATIONS = 100000;

  // Generate a new random encryption key
  generateKey(): string {
    return randomBytes(this.KEY_LENGTH).toString('base64');
  }

  // Derive key from password/passphrase using PBKDF2
  deriveKeyFromPassword(password: string, salt?: string): { key: string; salt: string } {
    const actualSalt = salt || randomBytes(16).toString('hex');
    const key = pbkdf2Sync(
      password,
      actualSalt,
      this.PBKDF2_ITERATIONS,
      this.KEY_LENGTH,
      'sha256'
    );
    return {
      key: key.toString('base64'),
      salt: actualSalt,
    };
  }

  // Derive encryption key from Hive posting key using HKDF
  deriveKeyFromHiveKey(hiveUsername: string, postingKey: string): string {
    // HKDF: extract-then-expand key derivation (RFC 5869)
    // Input key material: the Hive posting key
    // Salt: username (provides domain separation per user)
    // Info: application context string
    const ikm = Buffer.from(postingKey, 'utf-8');
    const salt = Buffer.from(hiveUsername, 'utf-8');
    const info = Buffer.from('spk-network-e2e-encryption-v1', 'utf-8');
    const derivedKey = hkdfSync('sha256', ikm, salt, info, this.KEY_LENGTH);
    return Buffer.from(derivedKey).toString('base64');
  }

  // Encrypt data
  encrypt(data: Buffer, keyBase64: string): EncryptionResult {
    const key = Buffer.from(keyBase64, 'base64');
    const nonce = randomBytes(this.NONCE_LENGTH);
    
    const cipher = createCipheriv(this.ALGORITHM, key, nonce);
    
    const encrypted = Buffer.concat([
      cipher.update(data),
      cipher.final(),
      cipher.getAuthTag()
    ]);

    return {
      encryptedData: encrypted,
      nonce: nonce.toString('base64'),
      algorithm: this.ALGORITHM,
    };
  }

  // Decrypt data
  decrypt(encryptedData: Buffer, keyBase64: string, nonceBase64: string): DecryptionResult {
    try {
      const key = Buffer.from(keyBase64, 'base64');
      const nonce = Buffer.from(nonceBase64, 'base64');
      
      // Split encrypted data and auth tag
      const authTag = encryptedData.slice(-this.AUTH_TAG_LENGTH);
      const ciphertext = encryptedData.slice(0, -this.AUTH_TAG_LENGTH);
      
      const decipher = createDecipheriv(this.ALGORITHM, key, nonce);
      decipher.setAuthTag(authTag);
      
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);

      return { success: true, data: decrypted };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  // Store user's public key
  async storePublicKey(username: string, publicKey: string): Promise<UserKey> {
    return storage.createUserKey({
      username,
      keyType: 'public',
      keyValue: publicKey,
      algorithm: 'AES-GCM',
    });
  }

  // Store user's encrypted private key (encrypted with their password)
  async storeEncryptedPrivateKey(username: string, encryptedPrivateKey: string): Promise<UserKey> {
    return storage.createUserKey({
      username,
      keyType: 'encrypted_private',
      keyValue: encryptedPrivateKey,
      algorithm: 'AES-GCM',
    });
  }

  // Get user's keys
  async getUserKeys(username: string): Promise<{ publicKey?: string; hasEncryptedPrivateKey: boolean }> {
    const keys = await storage.getUserKeys(username);
    
    const publicKey = keys.find(k => k.keyType === 'public')?.keyValue;
    const hasEncryptedPrivateKey = keys.some(k => k.keyType === 'encrypted_private');

    return { publicKey, hasEncryptedPrivateKey };
  }

  // Encrypt file for storage
  async encryptFile(data: Buffer, username: string, password?: string): Promise<{
    encryptedData: Buffer;
    nonce: string;
    keySalt?: string;
  }> {
    let key: string;
    let keySalt: string | undefined;

    if (password) {
      // Use password-derived key
      const derived = this.deriveKeyFromPassword(password);
      key = derived.key;
      keySalt = derived.salt;
    } else {
      // Use user's stored key or generate new one
      const userKeys = await this.getUserKeys(username);
      if (userKeys.publicKey) {
        key = userKeys.publicKey;
      } else {
        key = this.generateKey();
        await this.storePublicKey(username, key);
      }
    }

    const result = this.encrypt(data, key);
    
    return {
      encryptedData: result.encryptedData,
      nonce: result.nonce,
      keySalt,
    };
  }

  // Decrypt file from storage
  async decryptFile(
    encryptedData: Buffer,
    nonce: string,
    username: string,
    password?: string,
    keySalt?: string
  ): Promise<DecryptionResult> {
    let key: string;

    if (password && keySalt) {
      // Use password-derived key
      const derived = this.deriveKeyFromPassword(password, keySalt);
      key = derived.key;
    } else {
      // Use user's stored key
      const userKeys = await this.getUserKeys(username);
      if (!userKeys.publicKey) {
        return { success: false, error: 'No encryption key found for user' };
      }
      key = userKeys.publicKey;
    }

    return this.decrypt(encryptedData, key, nonce);
  }

  // Generate a sharing key for a specific file using HKDF
  generateSharingKey(fileKey: string, recipientPublicKey: string): string {
    // HKDF-based key derivation for file sharing
    // Input key material: the file's encryption key
    // Salt: recipient's public key (ensures unique key per recipient)
    // Info: sharing context
    const ikm = Buffer.from(fileKey, 'base64');
    const salt = Buffer.from(recipientPublicKey, 'base64');
    const info = Buffer.from('spk-file-sharing-v1', 'utf-8');
    const derivedKey = hkdfSync('sha256', ikm, salt, info, this.KEY_LENGTH);
    return Buffer.from(derivedKey).toString('base64');
  }
}

// Singleton instance
export const encryptionService = new EncryptionService();
