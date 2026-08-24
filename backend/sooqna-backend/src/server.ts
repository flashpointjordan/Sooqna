import type { Server } from "node:http";
import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { PrismaNotificationsRepository } from "./modules/notifications/notifications.repository";
import { NotificationsService } from "./modules/notifications/notifications.service";
import { createNotificationWorker } from "./modules/notifications/notifications.worker";

type LifecycleDependencies = {
  listen?: (port: number, callback: () => void) => Server;
  worker?: ReturnType<typeof createNotificationWorker>;
  disconnect?: () => Promise<void>;
};

export function createServerLifecycle(deps: LifecycleDependencies = {}) {
  const repository = new PrismaNotificationsRepository();
  const worker = deps.worker ?? createNotificationWorker({
    repository,
    service: new NotificationsService(repository),
    logger,
  });
  let server: Server | undefined;
  let stopping: Promise<void> | undefined;
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
        await worker.stop();
        if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        await (deps.disconnect ?? (() => prisma.$disconnect()))();
      })();
      return stopping;
    },
  };
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

