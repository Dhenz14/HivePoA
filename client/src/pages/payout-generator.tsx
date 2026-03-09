import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { CalendarIcon, FileText, Download, CheckCircle2, Clock, AlertCircle, Loader2 } from "lucide-react";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-mode";

interface PoaRecipient {
  username: string;
  proofCount: number;
  successRate: number;
  totalHbd: string;
}

interface PoaDataResponse {
  period: { start: string; end: string };
  recipients: PoaRecipient[];
  totalHbd: string;
  recipientCount: number;
}

interface PayoutReport {
  id: string;
  validatorUsername: string;
  periodStart: string;
  periodEnd: string;
  totalHbd: string;
  recipientCount: number;
  status: string;
  executedAt: string | null;
  createdAt: string;
}

export default function PayoutGenerator() {
  const { user } = useValidatorAuth();
  const sessionToken = user?.sessionToken;
  const queryClient = useQueryClient();
  
  const [dateRange, setDateRange] = useState<{ from: Date; to: Date }>({
    from: subDays(new Date(), 7),
    to: new Date(),
  });

  const { data: poaData, isLoading: loadingPoa, refetch: refetchPoa } = useQuery<PoaDataResponse>({
    queryKey: ["poa-data", dateRange.from.toISOString(), dateRange.to.toISOString()],
    queryFn: async () => {
      const res = await fetch(
        `${getApiBase()}/api/validator/payout/poa-data?startDate=${startOfDay(dateRange.from).toISOString()}&endDate=${endOfDay(dateRange.to).toISOString()}`,
        { headers: { Authorization: `Bearer ${sessionToken}` } }
      );
      if (!res.ok) throw new Error("Failed to fetch PoA data");
      return res.json();
    },
    enabled: !!sessionToken,
  });

  const { data: reports, isLoading: loadingReports } = useQuery<PayoutReport[]>({
    queryKey: ["payout-reports"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/validator/payout/reports`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!res.ok) throw new Error("Failed to fetch reports");
      return res.json();
    },
    enabled: !!sessionToken,
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${getApiBase()}/api/validator/payout/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          periodStart: startOfDay(dateRange.from).toISOString(),
          periodEnd: endOfDay(dateRange.to).toISOString(),
        }),
      });
      if (!res.ok) throw new Error("Failed to generate report");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payout-reports"] });
    },
  });

  const exportReport = async (reportId: string) => {
    const res = await fetch(`${getApiBase()}/api/validator/payout/reports/${reportId}/export`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payout-report-${data.period}.json`;
    a.click();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      case "executed":
        return <Badge variant="outline" className="bg-green-500/10 text-green-500"><CheckCircle2 className="w-3 h-3 mr-1" />Executed</Badge>;
      case "rejected":
        return <Badge variant="outline" className="bg-red-500/10 text-red-500"><AlertCircle className="w-3 h-3 mr-1" />Rejected</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-payout-generator">
      <div>
        <h1 className="text-3xl font-display font-bold">Payout Report Generator</h1>
        <p className="text-muted-foreground mt-1">Generate payout reports from PoA challenge data</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CalendarIcon className="w-5 h-5" />
              Select Period
            </CardTitle>
            <CardDescription>Choose date range for payout calculation</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="justify-start text-left font-normal" data-testid="button-date-from">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    From: {format(dateRange.from, "PPP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={dateRange.from}
                    onSelect={(date) => date && setDateRange({ ...dateRange, from: date })}
                  />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="justify-start text-left font-normal" data-testid="button-date-to">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    To: {format(dateRange.to, "PPP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={dateRange.to}
                    onSelect={(date) => date && setDateRange({ ...dateRange, to: date })}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <Button onClick={() => refetchPoa()} variant="secondary" className="w-full" data-testid="button-preview">
              Preview Data
            </Button>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5" />
              PoA Data Preview
            </CardTitle>
            <CardDescription>
              {poaData ? `${poaData.recipientCount} recipients | Total: ${poaData.totalHbd} HBD` : "Select a date range to preview"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingPoa ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : poaData?.recipients && poaData.recipients.length > 0 ? (
              <div className="space-y-4">
                <div className="max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Username</TableHead>
                        <TableHead className="text-right">Proofs</TableHead>
                        <TableHead className="text-right">Success Rate</TableHead>
                        <TableHead className="text-right">HBD</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {poaData.recipients.map((r) => (
                        <TableRow key={r.username} data-testid={`row-recipient-${r.username}`}>
                          <TableCell className="font-mono text-sm">@{r.username}</TableCell>
                          <TableCell className="text-right">{r.proofCount}</TableCell>
                          <TableCell className="text-right">
                            <span className={cn(r.successRate >= 90 ? "text-green-500" : r.successRate >= 70 ? "text-yellow-500" : "text-red-500")}>
                              {r.successRate.toFixed(1)}%
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono">{r.totalHbd}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <Button
                  onClick={() => generateMutation.mutate()}
                  disabled={generateMutation.isPending}
                  className="w-full"
                  data-testid="button-generate-report"
                >
                  {generateMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</>
                  ) : (
                    <>Generate Payout Report</>
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">No PoA data for selected period</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Generated Reports</CardTitle>
          <CardDescription>Previously generated payout reports</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingReports ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : reports && reports.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Generated By</TableHead>
                  <TableHead className="text-right">Recipients</TableHead>
                  <TableHead className="text-right">Total HBD</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((report) => (
                  <TableRow key={report.id} data-testid={`row-report-${report.id}`}>
                    <TableCell className="font-mono text-sm">
                      {format(new Date(report.periodStart), "MMM d")} - {format(new Date(report.periodEnd), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>@{report.validatorUsername}</TableCell>
                    <TableCell className="text-right">{report.recipientCount}</TableCell>
                    <TableCell className="text-right font-mono">{report.totalHbd}</TableCell>
                    <TableCell>{getStatusBadge(report.status)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => exportReport(report.id)}
                        data-testid={`button-export-${report.id}`}
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-muted-foreground text-center py-8">No reports generated yet</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
