import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface ValidatorUser {
  username: string;
  witnessRank: number | null;
  isTopWitness: boolean;
  isVouched: boolean;
  sponsor?: string;
  sessionToken: string;
}

interface ValidatorAuthContextType {
  user: ValidatorUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, signature: string, challenge: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

const ValidatorAuthContext = createContext<ValidatorAuthContextType | null>(null);

const STORAGE_KEY = "spk_validator_session";

async function validateSession(username: string, sessionToken: string): Promise<ValidatorUser | null> {
  try {
    const response = await fetch("/api/validator/validate-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, sessionToken }),
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data.valid && (data.isTopWitness || data.isVouched)) {
      return {
        username: data.username,
        witnessRank: data.witnessRank ?? null,
        isTopWitness: data.isTopWitness,
        isVouched: data.isVouched || false,
        sponsor: data.vouchSponsor,
        sessionToken,
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

  const login = useCallback(async (username: string, signature: string, challenge: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await fetch("/api/validator/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, signature, challenge }),
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || "Login failed" };
      }

      if (!data.isTopWitness && !data.isVouched) {
        return { success: false, error: `Not in top 150 witnesses and no active vouch` };
      }

      if (!data.sessionToken) {
        return { success: false, error: "Server did not return session token" };
      }

      const validatorUser: ValidatorUser = {
        username: data.username,
        witnessRank: data.witnessRank ?? null,
        isTopWitness: data.isTopWitness,
        isVouched: data.isVouched || false,
        sponsor: data.vouchSponsor,
        sessionToken: data.sessionToken,
      };

      const session = {
        user: validatorUser,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      setUser(validatorUser);

      return { success: true };
    } catch (error) {
      return { success: false, error: "Network error" };
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  return (
    <ValidatorAuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout }}>
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
