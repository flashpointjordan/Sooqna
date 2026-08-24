import type { Response } from "express";
import { AppError } from "../../shared/errors/appError";

export type NotificationSignal = {
  event: "notification";
  id: string;
  unreadCount: number;
  version: number;
};

/**
 * Process-local SSE broker. A Redis Pub/Sub adapter can replace this boundary
 * when notification delivery spans more than one Node process.
 */
export class NotificationBroker {
  private readonly streams = new Map<string, Set<Response>>();

  subscribe(userId: string, response: Response): () => void {
    const userStreams = this.streams.get(userId) ?? new Set<Response>();
    if (userStreams.size >= 3) throw new AppError(429, "Too many notification streams.", "TOO_MANY_STREAMS");
    userStreams.add(response);
    this.streams.set(userId, userStreams);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      userStreams.delete(response);
      if (userStreams.size === 0) this.streams.delete(userId);
    };
  }

  publish(userId: string, signal: NotificationSignal): void {
    for (const response of this.streams.get(userId) ?? []) {
      try {
        response.write(`event: ${signal.event}\nid: ${signal.id}\ndata: ${JSON.stringify({ id: signal.id, unreadCount: signal.unreadCount, version: signal.version })}\n\n`);
      } catch {
        this.remove(userId, response);
      }
    }
  }

  activeCount(userId?: string): number {
    if (userId) return this.streams.get(userId)?.size ?? 0;
    return [...this.streams.values()].reduce((total, streams) => total + streams.size, 0);
  }

  private remove(userId: string, response: Response): void {
    const userStreams = this.streams.get(userId);
    if (!userStreams) return;
    userStreams.delete(response);
    if (userStreams.size === 0) this.streams.delete(userId);
  }
}

let productionBroker: NotificationBroker | undefined;

export function setNotificationBroker(broker: NotificationBroker): void {
  productionBroker = broker;
}

export function getNotificationBroker(): NotificationBroker {
  productionBroker ??= new NotificationBroker();
  return productionBroker;
}
