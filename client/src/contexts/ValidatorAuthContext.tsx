import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { getApiBase, getBackendMode, hasBackend, detectBackendMode } from "@/lib/api-mode";

interface ValidatorUser {
  username: string;
  witnessRank: number | null;
  isTopWitness: boolean;
  isVouched: boolean;
  sponsor?: string;
  sessionToken: string;
  validatorOptedIn: boolean | null; // null = not yet chosen, true = opted in, false = declined/resigned
}

interface ValidatorAuthContextType {
  user: ValidatorUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isValidator: boolean;
  isEligibleValidator: boolean;
  needsValidatorChoice: boolean;
  login: (username: string, signature: string, challenge: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  optIn: () => Promise<{ success: boolean; error?: string }>;
  resign: () => Promise<{ success: boolean; error?: string }>;
}

const ValidatorAuthContext = createContext<ValidatorAuthContextType | null>(null);

const STORAGE_KEY = "spk_validator_session";
const DESKTOP_AGENT_URL = "http://127.0.0.1:5111";

/** Sync username to desktop agent if it's running (fire-and-forget).
 *  Only attempts if backend mode is "agent" to avoid ERR_CONNECTION_REFUSED noise. */
function syncToDesktopAgent(username: string): void {
  if (getBackendMode() !== "agent") return;
  fetch(`${DESKTOP_AGENT_URL}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hiveUsername: username }),
  }).catch(() => {});
}

async function validateSession(username: string, sessionToken: string): Promise<ValidatorUser | null> {
  await detectBackendMode();
  if (!hasBackend()) return null;
  try {
    const response = await fetch(`${getApiBase()}/api/validator/validate-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, sessionToken }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.valid) {
      return {
        username: data.username,
        witnessRank: data.witnessRank ?? null,
        isTopWitness: data.isTopWitness || false,
        isVouched: data.isVouched || false,
        sponsor: data.vouchSponsor,
        sessionToken,
        validatorOptedIn: data.validatorOptedIn ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function ValidatorAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ValidatorUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const verifyStoredSession = async () => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          const session = JSON.parse(stored);
          if (session.expiresAt > Date.now() && session.user?.sessionToken) {
            const validatedUser = await validateSession(session.user.username, session.user.sessionToken);
            if (validatedUser) {
              setUser(validatedUser);
              syncToDesktopAgent(validatedUser.username);
            } else {
              localStorage.removeItem(STORAGE_KEY);
            }
          } else {
            localStorage.removeItem(STORAGE_KEY);
          }
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      setIsLoading(false);
    };

    verifyStoredSession();
  }, []);

  /** Persist user to localStorage whenever it changes */
  const updateUser = useCallback((newUser: ValidatorUser) => {
    setUser(newUser);
    const session = {
      user: newUser,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }, []);

  const login = useCallback(async (username: string, signature: string, challenge: string): Promise<{ success: boolean; error?: string }> => {
    try {
      // Ensure backend detection is complete before checking
      await detectBackendMode();
      if (!hasBackend()) {
        return { success: false, error: "Login requires the desktop agent or server to be running" };
      }
      const response = await fetch(`${getApiBase()}/api/validator/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, signature, challenge }),
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || "Login failed" };
      }

      if (!data.sessionToken) {
        return { success: false, error: "Server did not return session token" };
      }

      const validatorUser: ValidatorUser = {
        username: data.username,
        witnessRank: data.witnessRank ?? null,
        isTopWitness: data.isTopWitness || false,
        isVouched: data.isVouched || false,
        sponsor: data.vouchSponsor,
        sessionToken: data.sessionToken,
        validatorOptedIn: data.validatorOptedIn ?? null,
      };

      updateUser(validatorUser);
      syncToDesktopAgent(data.username);

      return { success: true };
    } catch (error) {
      return { success: false, error: "Network error" };
    }
  }, [updateUser]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const optIn = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!user) return { success: false, error: "Not logged in" };
    try {
      const response = await fetch(`${getApiBase()}/api/validator/opt-in`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.sessionToken}`,
        },
      });
      const data = await response.json();
      if (!response.ok) return { success: false, error: data.error || "Failed to opt in" };
      updateUser({ ...user, validatorOptedIn: true });
      return { success: true };
    } catch {
      return { success: false, error: "Network error" };
    }
  }, [user, updateUser]);

  const resign = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!user) return { success: false, error: "Not logged in" };
    try {
      const response = await fetch(`${getApiBase()}/api/validator/resign`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user.sessionToken}`,
        },
      });
      const data = await response.json();
      if (!response.ok) return { success: false, error: data.error || "Failed to resign" };
      updateUser({ ...user, validatorOptedIn: false });
      return { success: true };
    } catch {
      return { success: false, error: "Network error" };
    }
  }, [user, updateUser]);

  const isEligibleValidator = !!user && (user.isTopWitness || user.isVouched);
  const isValidator = isEligibleValidator && user!.validatorOptedIn === true;
  const needsValidatorChoice = isEligibleValidator && user!.validatorOptedIn === null;

  return (
    <ValidatorAuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, isValidator, isEligibleValidator, needsValidatorChoice, login, logout, optIn, resign }}>
      {children}
    </ValidatorAuthContext.Provider>
  );
}

export function useValidatorAuth() {
  const context = useContext(ValidatorAuthContext);
  if (!context) {
    throw new Error("useValidatorAuth must be used within ValidatorAuthProvider");
  }
  return context;
}
