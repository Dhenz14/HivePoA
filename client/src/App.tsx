import { useEffect } from "react";
import { Switch, Route, Redirect, useLocation, Router } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NodeConfigProvider } from "@/contexts/NodeConfigContext";
import { ValidatorAuthProvider, useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { AlertsProvider } from "@/components/AlertsProvider";
import NotFound from "@/pages/not-found";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Layout } from "@/components/layout/Layout";
import { AgentRequired } from "@/components/AgentRequired";
import { detectBackendMode } from "@/lib/api-mode";
import Dashboard from "@/pages/dashboard";
import Storage from "@/pages/storage";
import Browse from "@/pages/browse";
import Connect from "@/pages/connect";
import Wallet from "@/pages/wallet";
import NodeStatus from "@/pages/node";
import ValidatorSettings from "@/pages/settings";
import Validators from "@/pages/validators";
import Download from "@/pages/download";
import Earnings from "@/pages/earnings";
import Marketplace from "@/pages/marketplace";
import Analytics from "@/pages/analytics";
import ValidatorLogin from "@/pages/validator-login";
import ValidatorDashboard from "@/pages/validator-dashboard";
import NodeMonitoring from "@/pages/node-monitoring";
import ChallengeQueue from "@/pages/challenge-queue";
import FraudDetection from "@/pages/fraud-detection";
import PayoutGenerator from "@/pages/payout-generator";
import WalletDashboard from "@/pages/wallet-dashboard";
import P2PNetwork from "@/pages/p2p-network";
import Encoding from "@/pages/encoding";
import Watch from "@/pages/watch";
import generatedImage from '@assets/generated_images/a_dark,_futuristic_abstract_mesh_background_with_red_accents..png';

function ProtectedValidatorRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isValidator, isLoading } = useValidatorAuth();
  const [, setLocation] = useLocation();

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  }

  if (!isAuthenticated) {
    setLocation("/validator-login");
    return null;
  }

  if (!isValidator) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        <p className="text-lg font-medium mb-2">Validator Access Required</p>
        <p>Only top 150 Hive witnesses and vouched users can access validator features.</p>
      </div>
    );
  }

  return <Component />;
}

function AppRoutes() {
  return (
    <Layout>
      <Switch>
        {/* Agent-dependent pages — need desktop agent running */}
        <Route path="/">{() => <AgentRequired><Dashboard /></AgentRequired>}</Route>
        <Route path="/storage">{() => <AgentRequired><Storage /></AgentRequired>}</Route>
        <Route path="/browse">{() => <AgentRequired><Browse /></AgentRequired>}</Route>
        <Route path="/connect">{() => <AgentRequired><Connect /></AgentRequired>}</Route>
        <Route path="/wallet">{() => <AgentRequired><Wallet /></AgentRequired>}</Route>
        <Route path="/node">{() => <AgentRequired><NodeStatus /></AgentRequired>}</Route>
        <Route path="/settings">{() => <AgentRequired><ValidatorSettings /></AgentRequired>}</Route>
        <Route path="/earnings">{() => <AgentRequired><Earnings /></AgentRequired>}</Route>
        <Route path="/p2p-network">{() => <AgentRequired><P2PNetwork /></AgentRequired>}</Route>
        <Route path="/watch/:author/:permlink">{() => <AgentRequired><Watch /></AgentRequired>}</Route>

        {/* Works without agent — download page uses GitHub API directly */}
        <Route path="/download" component={Download} />
        <Route path="/validator-login" component={ValidatorLogin} />

        {/* Server-only pages — need full server deployment */}
        <Route path="/validators">{() => <AgentRequired serverOnly><Validators /></AgentRequired>}</Route>
        <Route path="/marketplace">{() => <AgentRequired serverOnly><Marketplace /></AgentRequired>}</Route>
        <Route path="/analytics">{() => <AgentRequired serverOnly><Analytics /></AgentRequired>}</Route>
        <Route path="/wallet-dashboard">{() => <AgentRequired serverOnly><WalletDashboard /></AgentRequired>}</Route>
        <Route path="/encoding">{() => <AgentRequired serverOnly><Encoding /></AgentRequired>}</Route>
        <Route path="/validator-dashboard">
          {() => <AgentRequired serverOnly><ProtectedValidatorRoute component={ValidatorDashboard} /></AgentRequired>}
        </Route>
        <Route path="/node-monitoring">
          {() => <AgentRequired serverOnly><ProtectedValidatorRoute component={NodeMonitoring} /></AgentRequired>}
        </Route>
        <Route path="/challenge-queue">
          {() => <AgentRequired serverOnly><ProtectedValidatorRoute component={ChallengeQueue} /></AgentRequired>}
        </Route>
        <Route path="/fraud-detection">
          {() => <AgentRequired serverOnly><ProtectedValidatorRoute component={FraudDetection} /></AgentRequired>}
        </Route>
        <Route path="/payout-generator">
          {() => <AgentRequired serverOnly><ProtectedValidatorRoute component={PayoutGenerator} /></AgentRequired>}
        </Route>

        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  useEffect(() => {
    detectBackendMode();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <NodeConfigProvider>
        <ValidatorAuthProvider>
          <TooltipProvider>
            <AlertsProvider>
              {/* Background Image Layer */}
              <div className="fixed inset-0 z-[-1] opacity-20 pointer-events-none">
                 <img src={generatedImage} alt="" className="w-full h-full object-cover" />
                 <div className="absolute inset-0 bg-background/90 mix-blend-multiply" />
              </div>
              
              <Toaster />
              <ErrorBoundary>
                <Router base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                  <AppRoutes />
                </Router>
              </ErrorBoundary>
            </AlertsProvider>
          </TooltipProvider>
        </ValidatorAuthProvider>
      </NodeConfigProvider>
    </QueryClientProvider>
  );
}

export default App;
