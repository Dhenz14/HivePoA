import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, Download, Upload, Globe, TrendingUp, Activity, Award, Clock } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function P2PNetworkPage() {
  const { data: stats } = useQuery<{
    combined: { activePeers: number; activeRooms: number; totalBytesShared: number; avgP2pRatio: number };
    realtime: any;
    database: any;
  }>({
    queryKey: ['/api/p2p/stats'],
    refetchInterval: 5000,
  });

  const { data: rooms } = useQuery<any[]>({
    queryKey: ['/api/p2p/rooms'],
    refetchInterval: 10000,
  });

  const { data: history } = useQuery<any[]>({
    queryKey: ['/api/p2p/history'],
  });

  const { data: contributors } = useQuery<{ hiveUsername: string; totalBytesShared: number; totalSegments: number }[]>({
    queryKey: ['/api/p2p/contributors'],
  });

  const combinedStats = stats?.combined || { activePeers: 0, activeRooms: 0, totalBytesShared: 0, avgP2pRatio: 0 };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">P2P CDN Network</h1>
          <p className="text-muted-foreground">
            Real-time peer-to-peer video streaming network statistics
          </p>
        </div>
        <Badge 
          variant={combinedStats.activePeers > 0 ? 'default' : 'secondary'}
          className="text-lg px-4 py-2"
          data-testid="badge-network-status"
        >
          <Activity className="h-4 w-4 mr-2" />
          {combinedStats.activePeers > 0 ? 'Active' : 'Idle'}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-stat-peers">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Peers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center">
              <Users className="h-8 w-8 text-primary mr-3" />
              <span className="text-3xl font-bold" data-testid="text-active-peers">
                {combinedStats.activePeers}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Viewers sharing bandwidth
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-rooms">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Rooms</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center">
              <Globe className="h-8 w-8 text-blue-500 mr-3" />
              <span className="text-3xl font-bold" data-testid="text-active-rooms">
                {combinedStats.activeRooms}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Videos with P2P enabled
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-shared">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Shared</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center">
              <Upload className="h-8 w-8 text-green-500 mr-3" />
              <span className="text-3xl font-bold" data-testid="text-total-shared">
                {formatBytes(combinedStats.totalBytesShared)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Bandwidth saved via P2P
            </p>
          </CardContent>
        </Card>

        <Card data-testid="card-stat-ratio">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">P2P Ratio</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center">
              <TrendingUp className="h-8 w-8 text-purple-500 mr-3" />
              <span className="text-3xl font-bold" data-testid="text-p2p-ratio">
                {(combinedStats.avgP2pRatio * 100).toFixed(1)}%
              </span>
            </div>
            <Progress value={combinedStats.avgP2pRatio * 100} className="mt-2" />
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="rooms" className="space-y-4">
        <TabsList>
          <TabsTrigger value="rooms" data-testid="tab-rooms">Active Rooms</TabsTrigger>
          <TabsTrigger value="contributors" data-testid="tab-contributors">Top Contributors</TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">Network History</TabsTrigger>
        </TabsList>

        <TabsContent value="rooms" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Active P2P Rooms</CardTitle>
              <CardDescription>
                Videos currently being shared via peer-to-peer network
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!rooms || rooms.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No active P2P rooms</p>
                  <p className="text-sm">Start watching a video to join the network</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {rooms.map((room: any) => (
                    <div 
                      key={room.id} 
                      className="flex items-center justify-between p-4 border rounded-lg"
                      data-testid={`room-${room.id}`}
                    >
                      <div>
                        <p className="font-mono text-sm">{room.videoCid?.substring(0, 20)}...</p>
                        <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                          <span className="flex items-center">
                            <Users className="h-3 w-3 mr-1" />
                            {room.realtimePeers || room.activePeers} peers
                          </span>
                          <span className="flex items-center">
                            <Upload className="h-3 w-3 mr-1" />
                            {formatBytes(room.totalBytesShared || 0)}
                          </span>
                        </div>
                      </div>
                      <Badge variant="secondary">
                        {room.realtimePeers || room.activePeers > 0 ? 'Active' : 'Idle'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contributors" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Award className="h-5 w-5 mr-2 text-yellow-500" />
                Top Bandwidth Contributors
              </CardTitle>
              <CardDescription>
                Users who have contributed the most to the P2P network
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!contributors || contributors.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Award className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No contributions yet</p>
                  <p className="text-sm">Be the first to share bandwidth!</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {contributors.map((contributor: any, index: number) => (
                    <div 
                      key={contributor.hiveUsername}
                      className="flex items-center justify-between p-3 border rounded-lg"
                      data-testid={`contributor-${index}`}
                    >
                      <div className="flex items-center">
                        <span className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center mr-3 font-bold">
                          {index + 1}
                        </span>
                        <div>
                          <p className="font-medium">@{contributor.hiveUsername}</p>
                          <p className="text-sm text-muted-foreground">
                            {contributor.totalSegments} segments shared
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-green-600">
                          {formatBytes(contributor.totalBytesShared)}
                        </p>
                        <p className="text-xs text-muted-foreground">Total shared</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Network Activity History</CardTitle>
              <CardDescription>
                P2P network performance over time
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!history || history.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No history data yet</p>
                  <p className="text-sm">Stats will appear after network activity</p>
                </div>
              ) : (
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={history.slice().reverse()}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis 
                        dataKey="timestamp" 
                        tickFormatter={(value) => new Date(value).toLocaleTimeString()}
                      />
                      <YAxis yAxisId="left" />
                      <YAxis yAxisId="right" orientation="right" />
                      <Tooltip 
                        labelFormatter={(value) => new Date(value).toLocaleString()}
                        formatter={(value: any, name: string) => {
                          if (name === 'avgP2pRatio') return [(value * 100).toFixed(1) + '%', 'P2P Ratio'];
                          if (name === 'totalBytesShared') return [formatBytes(value), 'Bytes Shared'];
                          return [value, name];
                        }}
                      />
                      <Area 
                        yAxisId="left"
                        type="monotone" 
                        dataKey="activePeers" 
                        stroke="#8884d8" 
                        fill="#8884d8" 
                        fillOpacity={0.3}
                        name="Active Peers"
                      />
                      <Line 
                        yAxisId="right"
                        type="monotone" 
                        dataKey="avgP2pRatio" 
                        stroke="#82ca9d" 
                        name="P2P Ratio"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
