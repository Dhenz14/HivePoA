import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Shield, Key, AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { useHiveKeychain } from "@/hooks/use-hive-keychain";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

export default function ValidatorLogin() {
  const [, setLocation] = useLocation();
  const { isAvailable, isChecking, requestSignature } = useHiveKeychain();
  const { login, isAuthenticated, user } = useValidatorAuth();
  
  const [username, setUsername] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [witnessStatus, setWitnessStatus] = useState<{
    checked: boolean;
    isWitness: boolean;
    rank: number | null;
  }>({ checked: false, isWitness: false, rank: null });

  if (isAuthenticated && user) {
    return (
      <div className="container max-w-lg py-16" data-testid="page-validator-login">
        <Card className="border-green-500/50 bg-green-500/5">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 rounded-full bg-green-500/20 w-fit">
              <CheckCircle2 className="h-8 w-8 text-green-500" />
            </div>
            <CardTitle className="text-2xl">Logged In as Validator</CardTitle>
            <CardDescription>
              @{user.username} (Witness #{user.witnessRank})
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button 
              className="w-full" 
              onClick={() => setLocation("/validator-dashboard")}
              data-testid="button-go-dashboard"
            >
              Go to Validator Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const checkWitnessStatus = async () => {
    if (!username.trim()) {
      setError("Please enter your Hive username");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/validator/witness-check/${username.trim()}`);
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Account not found");
        setWitnessStatus({ checked: true, isWitness: false, rank: null });
        return;
      }

      setWitnessStatus({
        checked: true,
        isWitness: data.isTopWitness,
        rank: data.witnessRank,
      });

      if (!data.isTopWitness) {
        setError(`@${username} is not in the top 150 witnesses. Only witnesses can access validator features.`);
      }
    } catch (err) {
      setError("Failed to check witness status");
    } finally {
      setIsLoading(false);
    }
  };

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

      setLocation("/validator-dashboard");
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
            <Shield className="h-8 w-8 text-primary" />
          </div>
          <CardTitle className="text-2xl">Validator Login</CardTitle>
          <CardDescription>
            Sign in with Hive Keychain to access validator features.
            Only top 150 witnesses can validate.
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
                <div className="flex gap-2">
                  <Input
                    id="username"
                    placeholder="yourusername"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value.toLowerCase().replace("@", ""));
                      setWitnessStatus({ checked: false, isWitness: false, rank: null });
                      setError(null);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && checkWitnessStatus()}
                    data-testid="input-username"
                  />
                  <Button 
                    variant="outline" 
                    onClick={checkWitnessStatus}
                    disabled={isLoading || !username.trim()}
                    data-testid="button-check-witness"
                  >
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check"}
                  </Button>
                </div>
              </div>

              {witnessStatus.checked && (
                <div className={`p-4 rounded-lg border ${
                  witnessStatus.isWitness 
                    ? "bg-green-500/10 border-green-500/30" 
                    : "bg-yellow-500/10 border-yellow-500/30"
                }`}>
                  {witnessStatus.isWitness ? (
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <div>
                        <p className="font-medium">@{username} is a Top Witness</p>
                        <p className="text-sm text-muted-foreground">
                          Rank #{witnessStatus.rank} - Eligible to validate
                        </p>
                      </div>
                      <Badge className="ml-auto">Witness</Badge>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="h-5 w-5 text-yellow-500" />
                      <div>
                        <p className="font-medium">Not a Top 150 Witness</p>
                        <p className="text-sm text-muted-foreground">
                          Only witnesses can access validator features
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

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
                disabled={isLoading || !witnessStatus.isWitness}
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

      <div className="mt-6 text-center text-sm text-muted-foreground">
        <p>Why witness-only access?</p>
        <p className="mt-1">
          Validators police the network and distribute HBD rewards. 
          Using Hive's elected witnesses ensures accountability.
        </p>
      </div>
    </div>
  );
}
