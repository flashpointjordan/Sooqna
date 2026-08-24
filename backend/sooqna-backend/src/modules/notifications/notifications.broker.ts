import type { Response } from "express";
import { AppError } from "../../shared/errors/appError";

export type NotificationSignal = {
  event: "notification.changed";
  notificationId: string;
  unreadCount: number;
  version: number;
};
export type NotificationPublisher = (userId: string, notificationId: string, unreadCount: number) => Promise<void> | void;

/**
 * Process-local SSE broker. A Redis Pub/Sub adapter can replace this boundary
 * when notification delivery spans more than one Node process.
 */
export class NotificationBroker {
  private readonly streams = new Map<string, Set<Response>>();
  private readonly cleanupHandlers = new WeakMap<Response, () => void>();

  subscribe(userId: string, response: Response): () => void {
    const userStreams = this.streams.get(userId) ?? new Set<Response>();
    if (userStreams.size >= 3) throw new AppError(429, "Too many notification streams.", "TOO_MANY_STREAMS");
    userStreams.add(response);
    this.streams.set(userId, userStreams);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.cleanupHandlers.delete(response);
      userStreams.delete(response);
      if (userStreams.size === 0 && this.streams.get(userId) === userStreams) this.streams.delete(userId);
    };
  }

  publish(userId: string, signal: NotificationSignal): void {
    for (const response of this.streams.get(userId) ?? []) {
      try {
        const written = response.write(`event: ${signal.event}\nid: ${signal.notificationId}\ndata: ${JSON.stringify(signal)}\n\n`);
        if (!written) this.closeResponse(userId, response);
      } catch {
        this.closeResponse(userId, response);
      }
    }
  }

  closeUser(userId: string): number {
    const responses = [...(this.streams.get(userId) ?? [])];
    for (const response of responses) this.closeResponse(userId, response);
    return responses.length;
  }

  closeAll(): number {
    let closed = 0;
    for (const userId of [...this.streams.keys()]) closed += this.closeUser(userId);
    return closed;
  }

  activeCount(userId?: string): number {
    if (userId) return this.streams.get(userId)?.size ?? 0;
    return [...this.streams.values()].reduce((total, streams) => total + streams.size, 0);
  }

  registerCleanup(response: Response, cleanup: () => void): void {
    this.cleanupHandlers.set(response, cleanup);
  }

  private remove(userId: string, response: Response): void {
    const userStreams = this.streams.get(userId);
    if (!userStreams) return;
    userStreams.delete(response);
    if (userStreams.size === 0 && this.streams.get(userId) === userStreams) this.streams.delete(userId);
  }

  private closeResponse(userId: string, response: Response): void {
    const cleanup = this.cleanupHandlers.get(response);
    this.cleanupHandlers.delete(response);
    cleanup?.();
    this.remove(userId, response);
    this.end(response);
  }

  private end(response: Response): void {
    try { response.end(); }
    catch { /* A closed socket has already been removed from the broker. */ }
  }
}

let productionBroker: NotificationBroker | undefined;
let productionPublisher: NotificationPublisher | undefined;

export function setNotificationBroker(broker: NotificationBroker): void {
  productionBroker = broker;
  productionPublisher = createNotificationPublisher(broker);
}

export function getNotificationBroker(): NotificationBroker {
  productionBroker ??= new NotificationBroker();
  return productionBroker;
}

export function createNotificationPublisher(broker: Pick<NotificationBroker, "publish">): NotificationPublisher {
  return (userId, notificationId, unreadCount) => {
    broker.publish(userId, { event: "notification.changed", notificationId, unreadCount, version: 1 });
  };
}

export function setNotificationPublisher(publisher: NotificationPublisher): void {
  productionPublisher = publisher;
}

export function getNotificationPublisher(): NotificationPublisher {
  productionPublisher ??= createNotificationPublisher(getNotificationBroker());
  return productionPublisher;
}

export function publishNotificationSignal(userId: string, notificationId: string, unreadCount: number): Promise<void> | void {
  return getNotificationPublisher()(userId, notificationId, unreadCount);
}
