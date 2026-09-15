import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";

type FileLockOptions = {
  retryMs?: number;
  staleMs?: number;
  timeoutMs?: number;
};

export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const retryMs = Math.max(1, options.retryMs ?? 10);
  const staleMs = Math.max(5, options.staleMs ?? 30_000);
  const timeoutMs = Math.max(retryMs, options.timeoutMs ?? 5_000);
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() <= deadline) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(token, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      const heartbeat = setInterval(() => {
        void readFile(lockPath, "utf8").then((owner) => {
          if (owner === token) return utimes(lockPath, new Date(), new Date());
          return undefined;
        }).catch(() => undefined);
      }, Math.max(2, Math.floor(staleMs / 3)));
      heartbeat.unref();
      try {
        return await work();
      } finally {
        clearInterval(heartbeat);
        const owner = await readFile(lockPath, "utf8").catch(() => null);
        if (owner === token) await unlink(lockPath).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const first = await Promise.all([
        readFile(lockPath, "utf8").catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      if (first[0] !== null && first[1] && Date.now() - first[1].mtimeMs > staleMs) {
        await delay(retryMs);
        const second = await Promise.all([
          readFile(lockPath, "utf8").catch(() => null),
          stat(lockPath).catch(() => null),
        ]);
        if (
          second[0] === first[0] &&
          second[1] &&
          Date.now() - second[1].mtimeMs > staleMs
        ) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      await delay(retryMs);
    }
  }
  throw new Error(`Timed out waiting for file lock: ${lockPath}`);
}
