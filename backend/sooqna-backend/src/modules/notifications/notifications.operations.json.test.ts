import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationBroadcastStatus, Role } from "@prisma/client";
import { readJsonArrayFile, writeJsonArrayFileAtomically } from "../../utils/fileStore";

jest.mock("../../config/prisma", () => ({ prisma: {} }));
jest.mock("../../config/env", () => ({ env: { enableCategoriesJsonFallback: true, databaseUrl: "" } }));

import {
  createJsonNotificationOperationsStorage,
  JsonNotificationOperationsRepository,
  type JsonNotificationOperationsPaths,
} from "./notifications.operations";

const now = new Date("2026-09-12T10:00:00.000Z");
const temporaryDirectories: string[] = [];

function fixture(users: Array<Record<string, unknown>>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sooqna-notification-operations-"));
  temporaryDirectories.push(directory);
  const paths: JsonNotificationOperationsPaths = {
    operations: path.join(directory, "operations.json"),
    users: path.join(directory, "users.json"),
    messages: path.join(directory, "messages.json"),
    journal: path.join(directory, "journal.json"),
  };
  writeJsonArrayFileAtomically(paths.operations, [{ broadcasts: [] }]);
  writeJsonArrayFileAtomically(paths.users, users);
  writeJsonArrayFileAtomically(paths.messages, [{ conversations: [], messages: [], notificationOutbox: [] }]);
  return { paths, repository: new JsonNotificationOperationsRepository(createJsonNotificationOperationsStorage({ paths })) };
}

function messages(paths: JsonNotificationOperationsPaths) {
  return readJsonArrayFile<{ notificationOutbox: Array<{ recipientId: string; dedupeKey: string }> }>(paths.messages)[0];
}

function operations(paths: JsonNotificationOperationsPaths) {
  return readJsonArrayFile<{ broadcasts: Array<{ status: NotificationBroadcastStatus; cursor: string | null; deliveredCount: number }> }>(paths.operations)[0];
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()!;
    if (!directory.startsWith(os.tmpdir())) throw new Error("Refusing to remove a non-temporary test directory.");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("JSON notification operations repository", () => {
  it.each([
    [Role.BUYER, ["buyer", "legacy"]],
    [Role.SELLER, ["seller"]],
    [Role.ADMIN, ["admin"]],
  ])("normalizes fallback roles when broadcasting to %s", async (role, expectedRecipients) => {
    const { paths, repository } = fixture([
      { uid: "legacy", role: "user", accountStatus: "active" },
      { uid: "buyer", role: "BUYER", accountStatus: "active" },
      { uid: "seller", role: "seller", accountStatus: "active" },
      { uid: "admin", role: "ADMIN", accountStatus: "active" },
      { uid: "inactive", role, accountStatus: "suspended" },
    ]);
    await repository.createBroadcast({ audience: "ROLES", audienceValue: { roles: [role] }, title: "Notice", body: "Body", createdBy: "admin" }, now);

    await repository.processBroadcastBatch(10, now);

    expect(messages(paths).notificationOutbox.map((row) => row.recipientId).sort()).toEqual(expectedRecipients);
  });

  it("persists bounded outbox fanout with matching cursor and delivered count", async () => {
    const { paths, repository } = fixture([
      { uid: "a", role: "BUYER", accountStatus: "active" },
      { uid: "b", role: "SELLER", accountStatus: "active" },
      { uid: "c", role: "ADMIN", accountStatus: "active" },
    ]);
    const broadcast = await repository.createBroadcast({ audience: "ALL", audienceValue: null, title: "Notice", body: "Body", createdBy: "admin" }, now);

    await expect(repository.processBroadcastBatch(2, now)).resolves.toEqual({ broadcastId: broadcast.id, enqueued: 2, completed: false });
    expect(messages(paths).notificationOutbox).toHaveLength(2);
    expect(operations(paths).broadcasts[0]).toMatchObject({ status: "PROCESSING", cursor: "b", deliveredCount: 2 });

    await expect(repository.processBroadcastBatch(2, now)).resolves.toEqual({ broadcastId: broadcast.id, enqueued: 1, completed: true });
    expect(messages(paths).notificationOutbox).toHaveLength(3);
    expect(operations(paths).broadcasts[0]).toMatchObject({ status: "COMPLETED", cursor: "c", deliveredCount: 3 });
  });

  it("recovers one journaled fanout state after a partial file-write failure", async () => {
    const { paths } = fixture([{ uid: "a", role: "BUYER", accountStatus: "active" }]);
    let failOperationsWrite = false;
    let failed = false;
    const storage = createJsonNotificationOperationsStorage({
      paths,
      write(filePath, records) {
        if (failOperationsWrite && !failed && filePath === paths.operations) {
          failed = true;
          throw new Error("injected operations write failure");
        }
        writeJsonArrayFileAtomically(filePath, records);
      },
    });
    const repository = new JsonNotificationOperationsRepository(storage);
    const broadcast = await repository.createBroadcast({ audience: "ALL", audienceValue: null, title: "Notice", body: "Body", createdBy: "admin" }, now);
    failOperationsWrite = true;

    await expect(repository.processBroadcastBatch(10, now)).rejects.toThrow("injected operations write failure");
    expect(readJsonArrayFile(paths.journal)).toHaveLength(1);

    await expect(repository.processBroadcastBatch(10, now)).resolves.toEqual({ broadcastId: null, enqueued: 0, completed: true });
    expect(messages(paths).notificationOutbox).toEqual([
      expect.objectContaining({ recipientId: "a", dedupeKey: `broadcast:${broadcast.id}:a` }),
    ]);
    expect(operations(paths).broadcasts[0]).toMatchObject({ status: "COMPLETED", cursor: "a", deliveredCount: 1 });
    expect(readJsonArrayFile(paths.journal)).toEqual([]);
  });
});
