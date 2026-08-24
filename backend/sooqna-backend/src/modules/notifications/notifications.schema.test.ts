import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const prismaSchema = readFileSync(resolve(__dirname, "../../../prisma/schema.prisma"), "utf8");

function model(name: string): string {
  const match = prismaSchema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  expect(match).not.toBeNull();
  return match![0];
}

function enumContract(name: string, values: string[]): void {
  const match = prismaSchema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`, "m"));
  expect(match).not.toBeNull();

  for (const value of values) {
    expect(match![1]).toMatch(new RegExp(`^\\s*${value}\\s*$`, "m"));
  }
}

describe("notification Prisma schema contract", () => {
  it("defines durable notification models, enums, relations, and query constraints", () => {
    enumContract("NotificationCategory", [
      "MESSAGES",
      "LISTINGS",
      "ENGAGEMENT",
      "SAVED_SEARCHES",
      "SYSTEM",
      "SECURITY",
    ]);
    enumContract("NotificationType", [
      "MESSAGE_RECEIVED",
      "LISTING_APPROVED",
      "LISTING_REJECTED",
      "LISTING_EXPIRING",
      "LISTING_EXPIRED",
      "LISTING_FAVORITED_AGGREGATE",
      "REVIEW_RECEIVED",
      "SAVED_SEARCH_MATCHES",
      "SYSTEM_ANNOUNCEMENT",
      "SECURITY_ALERT",
    ]);
    enumContract("NotificationOutboxState", ["PENDING", "PROCESSING", "PROCESSED", "FAILED", "DEAD"]);
    enumContract("NotificationBroadcastStatus", ["PENDING", "PROCESSING", "COMPLETED", "FAILED"]);
    enumContract("NotificationBroadcastAudience", ["ALL", "ROLES", "USERS"]);

    const user = model("User");
    expect(user).toMatch(/^\s*notifications\s+Notification\[\]\s*$/m);
    expect(user).toMatch(/^\s*notificationPreferences\s+NotificationPreference\[\]\s*$/m);

    const notification = model("Notification");
    expect(notification).toMatch(/^\s*dedupeKey\s+String\?\s+@unique\s*$/m);
    expect(notification).toContain("@@index([userId, deletedAt, createdAt])");
    expect(notification).toContain("@@index([userId, readAt, deletedAt])");
    expect(notification).toContain("@@index([aggregationKey, createdAt])");

    const preference = model("NotificationPreference");
    expect(preference).toContain("@@unique([userId, category])");

    const outbox = model("NotificationOutbox");
    expect(outbox).toMatch(/^\s*dedupeKey\s+String\s+@unique\s*$/m);
    expect(outbox).toContain("@@index([state, availableAt, createdAt])");

    const broadcast = model("NotificationBroadcast");
    expect(broadcast).toContain("@@index([status, createdAt])");
  });
});
