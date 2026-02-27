import { WebSocket, WebSocketServer } from 'ws';
import { storage } from './storage';
import { logP2P } from './logger';

interface PeerInfo {
  ws: WebSocket;
  peerId: string;
  roomId: string;
  sessionId: string;
  hiveUsername?: string;
  isDesktopAgent: boolean;
  connectedAt: Date;
  lastHeartbeat: Date;
  stats: {
    bytesUploaded: number;
    bytesDownloaded: number;
    segmentsShared: number;
    peersConnected: number;
  };
}

interface Room {
  id: string;
  videoCid: string;
  peers: Map<string, PeerInfo>;
  createdAt: Date;
}

interface SignalingMessage {
  type: 'join' | 'leave' | 'offer' | 'answer' | 'ice-candidate' | 
        'stats-update' | 'heartbeat' | 'peer-list' | 'error';
  peerId?: string;
  roomId?: string;
  targetPeerId?: string;
  videoCid?: string;
  hiveUsername?: string;
  isDesktopAgent?: boolean;
  payload?: any;
}

export class P2PSignalingServer {
  private wss: WebSocketServer | null = null;
  private rooms: Map<string, Room> = new Map();
  private peersBySocket: Map<WebSocket, PeerInfo> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  init(wss: WebSocketServer) {
    this.wss = wss;

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => this.handleMessage(ws, data.toString()));
      ws.on('close', () => this.handleDisconnect(ws));
      ws.on('error', (err) => logP2P.error({ err }, 'P2P Signaling WebSocket error'));
    });

    this.heartbeatInterval = setInterval(() => this.cleanupStaleConnections(), 30000);
    this.statsInterval = setInterval(() => this.persistNetworkStats(), 60000);

    logP2P.info('[P2P Signaling] Server initialized');
  }

  private async handleMessage(ws: WebSocket, rawData: string) {
    let message: SignalingMessage;
    try {
      message = JSON.parse(rawData);
    } catch {
      this.sendError(ws, 'Invalid JSON message');
      return;
    }

    switch (message.type) {
      case 'join':
        await this.handleJoin(ws, message);
        break;
      case 'leave':
        await this.handleLeave(ws);
        break;
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        this.handleWebRTCSignaling(ws, message);
        break;
      case 'stats-update':
        await this.handleStatsUpdate(ws, message);
        break;
      case 'heartbeat':
        this.handleHeartbeat(ws);
        break;
      default:
        this.sendError(ws, `Unknown message type: ${message.type}`);
    }
  }

  private async handleJoin(ws: WebSocket, message: SignalingMessage) {
    if (!message.videoCid || !message.peerId) {
      this.sendError(ws, 'Missing videoCid or peerId');
      return;
    }

    const existingPeer = this.peersBySocket.get(ws);
    if (existingPeer) {
      await this.handleLeave(ws);
    }

    const room = await this.getOrCreateRoom(message.videoCid);

    const dbSession = await storage.createP2pSession({
      peerId: message.peerId,
      videoCid: message.videoCid,
      roomId: room.id,
      hiveUsername: message.hiveUsername,
      isDesktopAgent: message.isDesktopAgent || false,
      status: 'active',
      bytesUploaded: 0,
      bytesDownloaded: 0,
      segmentsShared: 0,
      peersConnected: 0,
    });

    const peerInfo: PeerInfo = {
      ws,
      peerId: message.peerId,
      roomId: room.id,
      sessionId: dbSession.id,
      hiveUsername: message.hiveUsername,
      isDesktopAgent: message.isDesktopAgent || false,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      stats: {
        bytesUploaded: 0,
        bytesDownloaded: 0,
        segmentsShared: 0,
        peersConnected: 0,
      },
    };

    room.peers.set(message.peerId, peerInfo);
    this.peersBySocket.set(ws, peerInfo);

    await storage.updateP2pRoomStats(room.id, room.peers.size, 0);

    const peerList = this.getPeerListForRoom(room, message.peerId);
    this.send(ws, {
      type: 'peer-list',
      roomId: room.id,
      payload: {
        peers: peerList,
        yourPeerId: message.peerId,
      },
    });

    room.peers.forEach((peer, peerId) => {
      if (peerId !== message.peerId) {
        this.send(peer.ws, {
          type: 'peer-list',
          roomId: room.id,
          payload: {
            newPeer: {
              peerId: message.peerId,
              isDesktopAgent: message.isDesktopAgent || false,
            },
          },
        });
      }
    });

    logP2P.info(`[P2P] Peer ${message.peerId} joined room ${room.id} (${room.peers.size} peers)`);
  }

  private async handleLeave(ws: WebSocket) {
    const peer = this.peersBySocket.get(ws);
    if (!peer) return;

    const room = this.rooms.get(peer.roomId);
    if (room) {
      room.peers.delete(peer.peerId);

      room.peers.forEach((otherPeer) => {
        this.send(otherPeer.ws, {
          type: 'peer-list',
          roomId: room.id,
          payload: {
            removedPeer: peer.peerId,
          },
        });
      });

      if (room.peers.size === 0) {
        this.rooms.delete(peer.roomId);
      } else {
        await storage.updateP2pRoomStats(room.id, room.peers.size, 0);
      }
    }

    await storage.disconnectP2pSession(peer.sessionId);

    if (peer.stats.segmentsShared > 0 && peer.hiveUsername) {
      const room = this.rooms.get(peer.roomId);
      await storage.createP2pContribution({
        peerId: peer.peerId,
        videoCid: room?.videoCid || '',
        hiveUsername: peer.hiveUsername,
        bytesShared: peer.stats.bytesUploaded,
        segmentsShared: peer.stats.segmentsShared,
        p2pRatio: peer.stats.bytesDownloaded > 0 
          ? peer.stats.bytesUploaded / peer.stats.bytesDownloaded 
          : 0,
        sessionDurationSec: Math.floor((Date.now() - peer.connectedAt.getTime()) / 1000),
      });
    }

    this.peersBySocket.delete(ws);
    logP2P.info(`[P2P] Peer ${peer.peerId} left room ${peer.roomId}`);
  }

  private handleWebRTCSignaling(ws: WebSocket, message: SignalingMessage) {
    const sender = this.peersBySocket.get(ws);
    if (!sender) {
      this.sendError(ws, 'Not joined to any room');
      return;
    }

    if (!message.targetPeerId) {
      this.sendError(ws, 'Missing targetPeerId');
      return;
    }

    const room = this.rooms.get(sender.roomId);
    if (!room) return;

    const targetPeer = room.peers.get(message.targetPeerId);
    if (!targetPeer) {
      this.sendError(ws, 'Target peer not found');
      return;
    }

    this.send(targetPeer.ws, {
      type: message.type,
      peerId: sender.peerId,
      payload: message.payload,
    });
  }

  private async handleStatsUpdate(ws: WebSocket, message: SignalingMessage) {
    const peer = this.peersBySocket.get(ws);
    if (!peer || !message.payload) return;

    const { bytesUploaded, bytesDownloaded, segmentsShared, peersConnected } = message.payload;

    peer.stats = {
      bytesUploaded: bytesUploaded || peer.stats.bytesUploaded,
      bytesDownloaded: bytesDownloaded || peer.stats.bytesDownloaded,
      segmentsShared: segmentsShared || peer.stats.segmentsShared,
      peersConnected: peersConnected || peer.stats.peersConnected,
    };

    await storage.updateP2pSessionStats(
      peer.sessionId,
      peer.stats.bytesUploaded,
      peer.stats.bytesDownloaded,
      peer.stats.segmentsShared,
      peer.stats.peersConnected
    );
  }

  private handleHeartbeat(ws: WebSocket) {
    const peer = this.peersBySocket.get(ws);
    if (peer) {
      peer.lastHeartbeat = new Date();
    }
    this.send(ws, { type: 'heartbeat' });
  }

  private async handleDisconnect(ws: WebSocket) {
    await this.handleLeave(ws);
  }

  private async getOrCreateRoom(videoCid: string): Promise<Room> {
    const roomsArray = Array.from(this.rooms.values());
    for (const room of roomsArray) {
      if (room.videoCid === videoCid) {
        return room;
      }
    }

    const dbRoom = await storage.getOrCreateP2pRoom(videoCid);

    const room: Room = {
      id: dbRoom.id,
      videoCid,
      peers: new Map(),
      createdAt: new Date(),
    };

    this.rooms.set(room.id, room);
    return room;
  }

  private getPeerListForRoom(room: Room, excludePeerId: string) {
    const peers: { peerId: string; isDesktopAgent: boolean }[] = [];
    room.peers.forEach((peer, peerId) => {
      if (peerId !== excludePeerId) {
        peers.push({
          peerId,
          isDesktopAgent: peer.isDesktopAgent,
        });
      }
    });
    return peers;
  }

  private cleanupStaleConnections() {
    const now = Date.now();
    const staleThreshold = 60000;

    this.peersBySocket.forEach((peer, ws) => {
      if (now - peer.lastHeartbeat.getTime() > staleThreshold) {
        logP2P.info(`[P2P] Cleaning up stale peer ${peer.peerId}`);
        ws.close();
      }
    });
  }

  private async persistNetworkStats() {
    const activePeers = this.peersBySocket.size;
    const activeRooms = this.rooms.size;

    let totalBytesShared = 0;
    let bandwidthSavedBytes = 0;

    this.peersBySocket.forEach((peer) => {
      totalBytesShared += peer.stats.bytesUploaded;
      bandwidthSavedBytes += peer.stats.bytesUploaded;
    });

    let totalBytes = 0;
    this.peersBySocket.forEach((peer) => {
      totalBytes += peer.stats.bytesDownloaded;
    });

    const avgP2pRatio = totalBytes > 0
      ? totalBytesShared / totalBytes
      : 0;

    if (activePeers > 0) {
      await storage.createP2pNetworkStats({
        activePeers,
        activeRooms,
        totalBytesShared,
        avgP2pRatio,
        bandwidthSavedBytes,
      });
    }
  }

  private send(ws: WebSocket, message: SignalingMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, errorMessage: string) {
    this.send(ws, { type: 'error', payload: { message: errorMessage } });
  }

  getStats() {
    return {
      activeRooms: this.rooms.size,
      activePeers: this.peersBySocket.size,
      rooms: Array.from(this.rooms.values()).map((room) => ({
        id: room.id,
        videoCid: room.videoCid,
        peerCount: room.peers.size,
      })),
    };
  }

  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    this.peersBySocket.forEach((_, ws) => ws.close());
    this.rooms.clear();
    this.peersBySocket.clear();
  }
}

export const p2pSignaling = new P2PSignalingServer();
