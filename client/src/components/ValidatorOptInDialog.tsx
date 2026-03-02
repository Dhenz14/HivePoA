import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Shield, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

export function ValidatorOptInDialog() {
  const { needsValidatorChoice, optIn, resign } = useValidatorAuth();
  const [isOptingIn, setIsOptingIn] = useState(false);
  const [isDeclining, setIsDeclining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOptIn = async () => {
    setIsOptingIn(true);
    setError(null);
    const result = await optIn();
    if (!result.success) setError(result.error || "Failed to activate");
    setIsOptingIn(false);
  };

  const handleDecline = async () => {
    setIsDeclining(true);
    setError(null);
    const result = await resign();
    if (!result.success) setError(result.error || "Failed to decline");
    setIsDeclining(false);
  };

  return (
    <Dialog open={needsValidatorChoice}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="mx-auto mb-2 p-3 rounded-full bg-primary/20 w-fit">
            <Shield className="h-8 w-8 text-primary" />
          </div>
          <DialogTitle className="text-center text-xl">Become a Validator?</DialogTitle>
          <DialogDescription className="text-center">
            You're eligible to run as a network validator. This is optional.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-2">
          <div className="rounded-lg border bg-muted/50 p-4 space-y-2 text-sm">
            <p className="font-medium">As a validator you will:</p>
            <ul className="list-disc list-inside space-y-1 text-muted-foreground">
              <li>Issue Proof-of-Access challenges to storage nodes</li>
              <li>Verify that files are stored correctly on the network</li>
              <li>Help secure the network and earn HBD rewards</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            You can change this later from the sidebar or validator dashboard.
          </p>
          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter className="flex gap-3 sm:gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleDecline}
            disabled={isOptingIn || isDeclining}
          >
            {isDeclining ? "..." : (
              <>
                <XCircle className="h-4 w-4 mr-2" />
                Not Now
              </>
            )}
          </Button>
          <Button
            className="flex-1"
            onClick={handleOptIn}
            disabled={isOptingIn || isDeclining}
          >
            {isOptingIn ? "Activating..." : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Activate Validator
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
