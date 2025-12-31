import { useState, useEffect, useCallback } from "react";

interface KeychainResponse {
  success: boolean;
  error?: string;
  result?: string;
  message?: string;
  data?: {
    username: string;
    type: string;
  };
  publicKey?: string;
}

interface HiveKeychain {
  requestHandshake: (callback: () => void) => void;
  requestSignBuffer: (
    username: string,
    message: string,
    keyType: "Posting" | "Active" | "Memo",
    callback: (response: KeychainResponse) => void
  ) => void;
}

declare global {
  interface Window {
    hive_keychain?: HiveKeychain;
  }
}

export interface UseHiveKeychainResult {
  isAvailable: boolean;
  isChecking: boolean;
  requestSignature: (username: string, message: string) => Promise<{ success: boolean; signature?: string; error?: string }>;
}

export function useHiveKeychain(): UseHiveKeychainResult {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const checkKeychain = () => {
      if (window.hive_keychain) {
        window.hive_keychain.requestHandshake(() => {
          setIsAvailable(true);
          setIsChecking(false);
        });
      } else {
        setIsAvailable(false);
        setIsChecking(false);
      }
    };

    const timer = setTimeout(checkKeychain, 500);
    return () => clearTimeout(timer);
  }, []);

  const requestSignature = useCallback(async (username: string, message: string): Promise<{ success: boolean; signature?: string; error?: string }> => {
    return new Promise((resolve) => {
      if (!window.hive_keychain) {
        resolve({ success: false, error: "Hive Keychain not installed" });
        return;
      }

      window.hive_keychain.requestSignBuffer(
        username,
        message,
        "Posting",
        (response: KeychainResponse) => {
          if (response.success && response.result) {
            resolve({ success: true, signature: response.result });
          } else {
            resolve({ success: false, error: response.message || response.error || "Signature failed" });
          }
        }
      );
    });
  }, []);

  return { isAvailable, isChecking, requestSignature };
}
