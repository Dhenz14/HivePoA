import { Switch, Route, Redirect, useLocation } from "wouter";
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
import generatedImage from '@assets/generated_images/a_dark,_futuristic_abstract_mesh_background_with_red_accents..png';

function ProtectedValidatorRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated, isLoading } = useValidatorAuth();
  const [, setLocation] = useLocation();

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  }

  if (!isAuthenticated) {
    setLocation("/validator-login");
    return null;
  }

  return <Component />;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/storage" component={Storage} />
        <Route path="/browse" component={Browse} />
        <Route path="/connect" component={Connect} />
        <Route path="/wallet" component={Wallet} />
        <Route path="/node" component={NodeStatus} />
        <Route path="/settings" component={ValidatorSettings} />
        <Route path="/validators" component={Validators} />
        <Route path="/download" component={Download} />
        <Route path="/earnings" component={Earnings} />
        <Route path="/marketplace" component={Marketplace} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/validator-login" component={ValidatorLogin} />
        <Route path="/validator-dashboard">
          {() => <ProtectedValidatorRoute component={ValidatorDashboard} />}
        </Route>
        <Route path="/node-monitoring">
          {() => <ProtectedValidatorRoute component={NodeMonitoring} />}
        </Route>
        <Route path="/challenge-queue">
          {() => <ProtectedValidatorRoute component={ChallengeQueue} />}
        </Route>
        <Route path="/fraud-detection">
          {() => <ProtectedValidatorRoute component={FraudDetection} />}
        </Route>
        <Route path="/payout-generator">
          {() => <ProtectedValidatorRoute component={PayoutGenerator} />}
        </Route>
        <Route path="/wallet-dashboard" component={WalletDashboard} />
        <Route path="/p2p-network" component={P2PNetwork} />
        <Route path="/encoding" component={Encoding} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
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
                <Router />
              </ErrorBoundary>
            </AlertsProvider>
          </TooltipProvider>
        </ValidatorAuthProvider>
      </NodeConfigProvider>
    </QueryClientProvider>
  );
}

export default App;
