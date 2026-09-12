import type { Server } from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { createNotificationsRepository } from "./modules/notifications/notifications.repository";
import { NotificationsService } from "./modules/notifications/notifications.service";
import { createNotificationWorker } from "./modules/notifications/notifications.worker";
import { runListingLifecycle } from "./modules/notifications/listingNotificationProducers";
import { createNotificationPublisher, NotificationBroker, setNotificationBroker, setNotificationPublisher } from "./modules/notifications/notifications.broker";

type LifecycleDependencies = {
  listen?: (port: number, callback: () => void) => Server;
  worker?: ReturnType<typeof createNotificationWorker>;
  disconnect?: () => Promise<void>;
  drainTimeoutMs?: number;
};

export function createServerLifecycle(deps: LifecycleDependencies = {}) {
  const repository = createNotificationsRepository();
  const broker = new NotificationBroker();
  setNotificationBroker(broker);
  const publishSignal = createNotificationPublisher(broker);
  setNotificationPublisher(publishSignal);
  const worker = deps.worker ?? createNotificationWorker({
    repository,
    service: new NotificationsService(repository, { publishSignal }),
    publishSignal,
    logger,
    ...(!env.enableCategoriesJsonFallback || env.databaseUrl
      ? { runLifecycle: async (now: Date) => { await runListingLifecycle(prisma, now); } }
      : {}),
  });
  let server: Server | undefined;
  let stopping: Promise<void> | undefined;
  const drainTimeoutMs = Math.max(1, deps.drainTimeoutMs ?? 10_000);
  return {
    start(): Server {
      if (server) return server;
      server = (deps.listen ?? ((port, callback) => app.listen(port, callback)))(env.port, () => {
        logger.info(`sooqna-backend listening on http://localhost:${env.port}`, { env: env.nodeEnv, port: env.port });
        worker.start();
      });
      return server;
    },
    async stop(): Promise<void> {
      if (stopping) return stopping;
      stopping = (async () => {
        broker.beginShutdown();
        const closing = server ? new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())) : Promise.resolve();
        try {
          const drained = await waitForWorker(worker.stop(), drainTimeoutMs);
          if (!drained) logger.warn("Notification worker drain timed out during shutdown.", { drainTimeoutMs });
          await closing;
        } finally {
          await (deps.disconnect ?? (() => prisma.$disconnect()))();
        }
      })();
      return stopping;
    },
  };
}

function waitForWorker(workerStop: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    void workerStop.then(() => { clearTimeout(timer); resolve(true); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export function startServer() {
  const lifecycle = createServerLifecycle();
  lifecycle.start();
  const shutdown = () => { void lifecycle.stop().then(() => process.exit(0)).catch((error: unknown) => { logger.error("Graceful shutdown failed.", { error: error instanceof Error ? error.message : String(error) }); process.exit(1); }); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return lifecycle;
}

if (require.main === module) startServer();

