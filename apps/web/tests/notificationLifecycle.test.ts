import assert from "node:assert/strict";
import { NotificationLifecycle } from "../src/components/notifications/notificationLifecycle";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  const events: string[] = [];
  let visible = true;
  let finish: (() => void) | undefined;
  let active = 0;
  let maximum = 0;
  const lifecycle = new NotificationLifecycle({
    canConnect: () => visible,
    refresh: async () => { events.push("refresh"); },
    connect: async (signal) => {
      events.push("connect");
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      active -= 1;
    },
    onReconnect: () => { events.push("reconnect"); },
    retryDelay: () => 5,
  });
  lifecycle.resume(); lifecycle.resume();
  await tick();
  assert.deepEqual(events, ["refresh", "connect"]);
  visible = false; lifecycle.pause();
  await tick();
  assert.equal(active, 0, "hidden tabs must abort their stream");
  visible = true; lifecycle.resume();
  await tick();
  assert.deepEqual(events.slice(-2), ["refresh", "connect"]);
  finish?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.includes("reconnect"));
  assert.deepEqual(events.slice(-2), ["refresh", "connect"], "EOF must refresh and reconnect automatically");
  assert.equal(maximum, 1, "resume and reconnect must never overlap streams");
  lifecycle.dispose();
  await tick();
  assert.equal(active, 0);
  const length = events.length;
  lifecycle.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, length, "disposed sessions must not restart");

  let releaseRefresh: (() => void) | undefined;
  let connects = 0;
  const stale = new NotificationLifecycle({
    canConnect: () => true,
    refresh: () => new Promise<void>((resolve) => { releaseRefresh = resolve; }),
    connect: async () => { connects += 1; },
    onReconnect: () => {},
  });
  stale.resume(); stale.dispose(); releaseRefresh?.();
  await tick();
  assert.equal(connects, 0, "an old user's pending refresh must not open a stream after cleanup");
  console.log("notification lifecycle tests passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
