import { storage } from "../storage";
import { logHive } from "../logger";
import { EventEmitter } from "events";

export interface HiveEvent {
  type: "spk_video_upload" | "hivepoa_announce" | "spk_reputation_slash" | "hbd_transfer";
  fromUser: string;
  toUser?: string;
  payload: any;
  blockNumber: number;
}

class HiveSimulator extends EventEmitter {
  private blockNumber: number = 85000000;
  private interval: NodeJS.Timeout | null = null;

  start() {
    if (this.interval) return;

    logHive.info("[Hive Simulator] Starting blockchain event stream...");
    
    // Simulate new blocks every 3 seconds
    this.interval = setInterval(() => {
      this.blockNumber++;
      this.simulateRandomEvent();
    }, 3000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async simulateRandomEvent() {
    const events = [
      this.simulateUpload.bind(this),
      this.simulateNodeAnnounce.bind(this),
      this.simulateReputationSlash.bind(this),
      this.simulateHbdTransfer.bind(this),
    ];

    const randomEvent = events[Math.floor(Math.random() * events.length)];
    await randomEvent();
  }

  private async simulateUpload() {
    const usernames = ["alice", "bob", "charlie", "david", "eve"];
    const cids = [
      "QmNew1...xyz",
      "QmNew2...abc",
      "QmNew3...def",
    ];

    const event: HiveEvent = {
      type: "spk_video_upload",
      fromUser: usernames[Math.floor(Math.random() * usernames.length)],
      payload: {
        cid: cids[Math.floor(Math.random() * cids.length)],
        size: `${Math.floor(Math.random() * 500)}MB`,
        name: `video_${Date.now()}.mp4`,
      },
      blockNumber: this.blockNumber,
    };

    await storage.createHiveTransaction({
      type: event.type,
      fromUser: event.fromUser,
      toUser: event.toUser || null,
      payload: JSON.stringify(event.payload),
      blockNumber: event.blockNumber,
    });

    this.emit("transaction", event);
  }

  private async simulateNodeAnnounce() {
    const event: HiveEvent = {
      type: "hivepoa_announce",
      fromUser: `node-${Math.floor(Math.random() * 1000)}`,
      payload: {
        peerId: `Qm${Math.random().toString(36).substring(7)}`,
        cids: [`QmFile${Math.random().toString(36).substring(7)}`],
      },
      blockNumber: this.blockNumber,
    };

    await storage.createHiveTransaction({
      type: event.type,
      fromUser: event.fromUser,
      toUser: null,
      payload: JSON.stringify(event.payload),
      blockNumber: event.blockNumber,
    });

    this.emit("transaction", event);
  }

  private async simulateReputationSlash() {
    const event: HiveEvent = {
      type: "spk_reputation_slash",
      fromUser: "validator-police",
      toUser: `node-${Math.floor(Math.random() * 1000)}`,
      payload: {
        reason: "Failed PoA challenge",
        oldRep: 60,
        newRep: 55,
      },
      blockNumber: this.blockNumber,
    };

    await storage.createHiveTransaction({
      type: event.type,
      fromUser: event.fromUser,
      toUser: event.toUser || null,
      payload: JSON.stringify(event.payload),
      blockNumber: event.blockNumber,
    });

    this.emit("transaction", event);
  }

  private async simulateHbdTransfer() {
    const event: HiveEvent = {
      type: "hbd_transfer",
      fromUser: "threespeak",
      toUser: `storage-node-${Math.floor(Math.random() * 1000)}`,
      payload: {
        amount: "0.500 HBD",
        memo: "PoA Reward for QmFile...",
      },
      blockNumber: this.blockNumber,
    };

    await storage.createHiveTransaction({
      type: event.type,
      fromUser: event.fromUser,
      toUser: event.toUser || null,
      payload: JSON.stringify(event.payload),
      blockNumber: event.blockNumber,
    });

    this.emit("transaction", event);
  }
}

export const hiveSimulator = new HiveSimulator();
