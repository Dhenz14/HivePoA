import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Key, AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { useHiveKeychain } from "@/hooks/use-hive-keychain";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

export default function ValidatorLogin() {
  const [, setLocation] = useLocation();
  const { isAvailable, isChecking, requestSignature } = useHiveKeychain();
  const { login, isAuthenticated, user } = useValidatorAuth();

  const [username, setUsername] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isAuthenticated && user) {
    return (
      <div className="container max-w-lg py-16" data-testid="page-validator-login">
        <Card className="border-green-500/50 bg-green-500/5">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 rounded-full bg-green-500/20 w-fit">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
            <CardTitle className="text-2xl">Logged In</CardTitle>
            <CardDescription>
              @{user.username}
              {user.isTopWitness
                ? ` — Witness #${user.witnessRank}`
                : user.isVouched
                  ? ` — Vouched by @${user.sponsor}`
                  : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              className="w-full"
              onClick={() => setLocation("/")}
              data-testid="button-go-dashboard"
            >
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleLogin = async () => {
    if (!username.trim()) {
      setError("Please enter your Hive username");
      return;
    }

    if (!isAvailable) {
      setError("Hive Keychain extension is not installed");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const challenge = `SPK-Validator-Login-${Date.now()}`;
      const signResult = await requestSignature(username.trim(), challenge);

      if (!signResult.success) {
        setError(signResult.error || "Signature rejected");
        setIsLoading(false);
        return;
      }

      const loginResult = await login(username.trim(), signResult.signature!, challenge);

      if (!loginResult.success) {
        setError(loginResult.error || "Login failed");
        setIsLoading(false);
        return;
      }

      setLocation("/");
    } catch (err) {
      setError("Login failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="container max-w-lg py-16" data-testid="page-validator-login">
      <Card>
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 p-3 rounded-full bg-primary/20 w-fit">
            <Key className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">Login with Hive Keychain</CardTitle>
          <CardDescription>
            Sign in with your Hive account to access the network and earn rewards.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {isChecking ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Detecting Hive Keychain...</span>
            </div>
          ) : !isAvailable ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Hive Keychain Required</AlertTitle>
              <AlertDescription className="mt-2">
                <p className="mb-3">
                  Install the Hive Keychain browser extension to sign in.
                </p>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href="https://hive-keychain.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="link-keychain-install"
                  >
                    Get Hive Keychain
                    <ExternalLink className="ml-2 h-3 w-3" />
                  </a>
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Hive Keychain detected
              </div>

              <div className="space-y-2">
                <Label htmlFor="username">Hive Username</Label>
                <Input
                  id="username"
                  placeholder="yourusername"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value.toLowerCase().replace("@", ""));
                    setError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                  data-testid="input-username"
                />
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                className="w-full"
                size="lg"
                onClick={handleLogin}
                disabled={isLoading || !username.trim()}
                data-testid="button-login"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing...
                  </>
                ) : (
                  <>
                    <Key className="mr-2 h-4 w-4" />
                    Sign in with Keychain
                  </>
                )}
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                Your private keys never leave Hive Keychain
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
