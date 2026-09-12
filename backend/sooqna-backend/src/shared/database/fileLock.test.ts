import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { withFileLock } from "./fileLock";

describe("withFileLock", () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sooqna-lock-"));
    lockPath = path.join(directory, "state.lock");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("serializes concurrent owners", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = withFileLock(lockPath, async () => {
      order.push("first-start");
      firstEntered();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first-end");
    }, { retryMs: 1, staleMs: 1_000 });
    await entered;
    const second = withFileLock(lockPath, async () => { order.push("second"); }, { retryMs: 1, staleMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("recovers an expired lock lease", async () => {
    await writeFile(lockPath, "dead-owner", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    await expect(withFileLock(lockPath, async () => "recovered", { retryMs: 1, staleMs: 5 }))
      .resolves.toBe("recovered");
  });

  it("does not delete a replacement owner's token when releasing", async () => {
    await withFileLock(lockPath, async () => {
      await writeFile(lockPath, "replacement-owner", "utf8");
    }, { retryMs: 1, staleMs: 1_000 });
    await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement-owner");
  });
});
