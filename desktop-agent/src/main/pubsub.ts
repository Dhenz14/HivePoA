import axios from 'axios';
import { IncomingMessage } from 'http';

export interface PubSubMessage {
  from: string;      // Sender's peer ID
  data: string;      // Decoded JSON string
  seqno: string;     // Message sequence number
  topicIDs: string[];
}

/**
 * IPFS PubSub bridge for P2P challenge messaging.
 * Uses Kubo's HTTP API for subscribe (streaming) and publish.
 */
export class PubSubBridge {
  private kuboApiUrl: string;
  private myPeerId: string;
  private subscriptions: Map<string, AbortController> = new Map();
  private seenMessages: Map<string, number> = new Map(); // seqno → timestamp
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(kuboApiUrl: string, myPeerId: string) {
    this.kuboApiUrl = kuboApiUrl;
    this.myPeerId = myPeerId;

    // Clean up old seen messages every 30 seconds
    this.cleanupInterval = setInterval(() => this.pruneSeenMessages(), 30000);
  }

  /**
   * Subscribe to an IPFS PubSub topic.
   * Uses streaming HTTP (NDJSON) — keeps connection open indefinitely.
   * Auto-reconnects on connection drop.
   */
  async subscribe(topic: string, callback: (msg: PubSubMessage) => void): Promise<void> {
    // Clean up existing subscription to this topic
    if (this.subscriptions.has(topic)) {
      this.subscriptions.get(topic)!.abort();
      this.subscriptions.delete(topic);
    }

    const abortController = new AbortController();
    this.subscriptions.set(topic, abortController);

    this.doSubscribe(topic, callback, abortController);
  }

  private async doSubscribe(
    topic: string,
    callback: (msg: PubSubMessage) => void,
    abortController: AbortController
  ): Promise<void> {
    try {
      const response = await axios.post(
        `${this.kuboApiUrl}/api/v0/pubsub/sub?arg=${encodeURIComponent(topic)}`,
        null,
        {
          responseType: 'stream',
          timeout: 0, // No timeout — keep alive
          signal: abortController.signal,
        }
      );

      const stream = response.data as IncomingMessage;
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete last line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);

            // Deduplicate by seqno
            const seqno = raw.seqno || '';
            if (seqno && this.seenMessages.has(seqno)) continue;
            if (seqno) this.seenMessages.set(seqno, Date.now());

            // Skip our own messages
            if (raw.from === this.myPeerId) continue;

            // Decode base64 data
            const decoded = Buffer.from(raw.data || '', 'base64').toString('utf-8');

            const msg: PubSubMessage = {
              from: raw.from || '',
              data: decoded,
              seqno: seqno,
              topicIDs: raw.topicIDs || [topic],
            };

            callback(msg);
          } catch {}
        }
      });

      stream.on('end', () => {
        console.log(`[PubSub] Subscription to "${topic}" ended`);
        // Auto-reconnect unless intentionally unsubscribed
        if (this.subscriptions.has(topic) && !abortController.signal.aborted) {
          console.log('[PubSub] Reconnecting in 5s...');
          setTimeout(() => {
            if (this.subscriptions.has(topic)) {
              this.doSubscribe(topic, callback, abortController);
            }
          }, 5000);
        }
      });

      stream.on('error', (err: Error) => {
        if (abortController.signal.aborted) return; // Intentional unsubscribe
        console.error(`[PubSub] Stream error on "${topic}":`, err.message);
        // Auto-reconnect
        setTimeout(() => {
          if (this.subscriptions.has(topic)) {
            this.doSubscribe(topic, callback, abortController);
          }
        }, 5000);
      });

      console.log(`[PubSub] Subscribed to "${topic}"`);
    } catch (err: any) {
      if (abortController.signal.aborted) return;
      console.error(`[PubSub] Failed to subscribe to "${topic}":`, err.message);
      // Retry after delay
      setTimeout(() => {
        if (this.subscriptions.has(topic)) {
          this.doSubscribe(topic, callback, abortController);
        }
      }, 5000);
    }
  }

  /**
   * Publish a message to an IPFS PubSub topic.
   */
  async publish(topic: string, data: object): Promise<boolean> {
    try {
      const jsonStr = JSON.stringify(data);
      // Kubo expects the data as a URL-encoded form parameter
      await axios.post(
        `${this.kuboApiUrl}/api/v0/pubsub/pub`,
        `arg=${encodeURIComponent(topic)}&arg=${encodeURIComponent(jsonStr)}`,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }
      );
      return true;
    } catch (err: any) {
      console.error(`[PubSub] Failed to publish to "${topic}":`, err.message);
      return false;
    }
  }

  /** Unsubscribe from a topic. */
  async unsubscribe(topic: string): Promise<void> {
    const controller = this.subscriptions.get(topic);
    if (controller) {
      controller.abort();
      this.subscriptions.delete(topic);
      console.log(`[PubSub] Unsubscribed from "${topic}"`);
    }
  }

  /** Unsubscribe from all topics and clean up. */
  async unsubscribeAll(): Promise<void> {
    for (const [topic, controller] of this.subscriptions) {
      controller.abort();
      console.log(`[PubSub] Unsubscribed from "${topic}"`);
    }
    this.subscriptions.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Check if subscribed to a topic. */
  isSubscribed(topic: string): boolean {
    return this.subscriptions.has(topic);
  }

  /** Remove seen messages older than 60 seconds. */
  private pruneSeenMessages(): void {
    const cutoff = Date.now() - 60000;
    for (const [seqno, timestamp] of this.seenMessages) {
      if (timestamp < cutoff) {
        this.seenMessages.delete(seqno);
      }
    }
  }
}
