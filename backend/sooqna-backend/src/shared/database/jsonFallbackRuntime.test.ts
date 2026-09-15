import * as fs from "node:fs";
import * as path from "node:path";
import { jsonFallbackRuntimeDirectory } from "./jsonFallbackRuntime";
import {
  conversationReadJournalPath,
  listingLifecycleJournalPath,
  messagesStateDataPath,
  notificationBroadcastJournalPath,
  notificationOperationsDataPath,
  notificationStateDataPath,
} from "./marketplaceJsonRecovery";

describe("JSON fallback runtime storage", () => {
  test("keeps every generated state and journal outside source", () => {
    const generatedPaths = [
      messagesStateDataPath,
      notificationStateDataPath,
      notificationOperationsDataPath,
      conversationReadJournalPath,
      notificationBroadcastJournalPath,
      listingLifecycleJournalPath,
    ];

    expect(generatedPaths.every((filePath) => filePath.startsWith(jsonFallbackRuntimeDirectory))).toBe(true);
    for (const filePath of generatedPaths) {
      expect(filePath).not.toContain(`${path.sep}src${path.sep}`);
    }
  });

  test("ignores the default runtime directory at repository level", () => {
    const repositoryIgnore = fs.readFileSync(path.resolve(process.cwd(), "..", "..", ".gitignore"), "utf8");
    expect(repositoryIgnore).toContain("backend/sooqna-backend/.runtime-data/");
  });
});
