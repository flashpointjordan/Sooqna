import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const prismaSchema = readFileSync(resolve(__dirname, "../../../prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  resolve(__dirname, "../../../prisma/migrations/20260824000100_add_notifications/migration.sql"),
  "utf8"
);

const notificationEnums = {
  NotificationCategory: ["MESSAGES", "LISTINGS", "ENGAGEMENT", "SAVED_SEARCHES", "SYSTEM", "SECURITY"],
  NotificationType: [
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
  ],
  NotificationOutboxState: ["PENDING", "PROCESSING", "PROCESSED", "FAILED", "DEAD"],
  NotificationBroadcastStatus: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"],
  NotificationBroadcastAudience: ["ALL", "ROLES", "USERS"],
} as const;

function block(source: string, header: string): string {
  const match = source.match(new RegExp(`${header} \\{([\\s\\S]*?)\\n\\}`, "m"));
  expect(match).not.toBeNull();
  return match![1];
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function schemaField(modelBlock: string, name: string): string {
  const match = modelBlock.match(new RegExp(`^\\s*${name}\\s+(.+?)\\s*$`, "m"));
  expect(match).not.toBeNull();
  return normalized(match![1]);
}

function schemaEnum(name: string): string[] {
  return block(prismaSchema, `enum ${name}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function modelDirectives(modelBlock: string, directive: "index" | "unique"): string[] {
  return Array.from(modelBlock.matchAll(new RegExp(`^\\s*@@${directive}\\((.+)\\)\\s*$`, "gm"))).map(
    (match) => `@@${directive}(${match[1]})`
  );
}

function migrationEnum(name: string): string[] {
  const match = migration.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^;]+)\\);`));
  expect(match).not.toBeNull();
  return Array.from(match![1].matchAll(/'([^']+)'/g), (value) => value[1]);
}

function migrationTable(name: string): string {
  const match = migration.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`));
  expect(match).not.toBeNull();
  return match![1];
}

function migrationColumn(table: string, name: string): string {
  const match = table.match(new RegExp(`^\\s*"${name}"\\s+(.+?)(?:,)?\\s*$`, "m"));
  expect(match).not.toBeNull();
  return normalized(match![1].replace(/,$/, ""));
}

function expectSchemaFields(modelName: string, fields: Record<string, string>): string {
  const modelBlock = block(prismaSchema, `model ${modelName}`);
  for (const [name, contract] of Object.entries(fields)) {
    expect(schemaField(modelBlock, name)).toBe(contract);
  }
  return modelBlock;
}

function expectMigrationColumns(tableName: string, columns: Record<string, string>): void {
  const table = migrationTable(tableName);
  for (const [name, contract] of Object.entries(columns)) {
    expect(migrationColumn(table, name)).toBe(contract);
  }
}

describe("notification Prisma schema and migration contract", () => {
  it("defines exactly the approved enum values in Prisma and PostgreSQL", () => {
    for (const [name, values] of Object.entries(notificationEnums)) {
      expect(schemaEnum(name)).toEqual(values);
      expect(migrationEnum(name)).toEqual(values);
    }
  });

  it("defines complete notification model fields, ownership, indexes, and uniqueness", () => {
    const user = block(prismaSchema, "model User");
    expect(schemaField(user, "notifications")).toBe("Notification[]");
    expect(schemaField(user, "notificationPreferences")).toBe("NotificationPreference[]");

    const notification = expectSchemaFields("Notification", {
      id: "String @id @default(cuid())",
      userId: "String",
      type: "NotificationType",
      category: "NotificationCategory",
      title: "String",
      body: "String",
      actionUrl: "String?",
      entityType: "String?",
      entityId: "String?",
      metadata: 'Json @default("{}")',
      dedupeKey: "String? @unique",
      aggregationKey: "String?",
      readAt: "DateTime?",
      deletedAt: "DateTime?",
      expiresAt: "DateTime",
      createdAt: "DateTime @default(now())",
      updatedAt: "DateTime @updatedAt",
      user: "User @relation(fields: [userId], references: [firebaseUid], onDelete: Cascade)",
    });
    expect(modelDirectives(notification, "index")).toEqual([
      "@@index([userId, deletedAt, createdAt])",
      "@@index([userId, readAt, deletedAt])",
      "@@index([aggregationKey, createdAt])",
    ]);

    const preference = expectSchemaFields("NotificationPreference", {
      id: "String @id @default(cuid())",
      userId: "String",
      category: "NotificationCategory",
      enabled: "Boolean @default(true)",
      createdAt: "DateTime @default(now())",
      updatedAt: "DateTime @updatedAt",
      user: "User @relation(fields: [userId], references: [firebaseUid], onDelete: Cascade)",
    });
    expect(modelDirectives(preference, "unique")).toEqual(["@@unique([userId, category])"]);

    const outbox = expectSchemaFields("NotificationOutbox", {
      id: "String @id @default(cuid())",
      eventType: "NotificationType",
      aggregateType: "String",
      aggregateId: "String",
      recipientId: "String?",
      payload: "Json",
      dedupeKey: "String @unique",
      state: "NotificationOutboxState @default(PENDING)",
      attempts: "Int @default(0)",
      availableAt: "DateTime @default(now())",
      processedAt: "DateTime?",
      lastError: "String?",
      createdAt: "DateTime @default(now())",
      updatedAt: "DateTime @updatedAt",
    });
    expect(modelDirectives(outbox, "index")).toEqual(["@@index([state, availableAt, createdAt])"]);

    const broadcast = expectSchemaFields("NotificationBroadcast", {
      id: "String @id @default(cuid())",
      audience: "NotificationBroadcastAudience",
      audienceValue: "Json",
      title: "String",
      body: "String",
      actionUrl: "String?",
      status: "NotificationBroadcastStatus @default(PENDING)",
      cursor: "String?",
      deliveredCount: "Int @default(0)",
      createdBy: "String",
      createdAt: "DateTime @default(now())",
      updatedAt: "DateTime @updatedAt",
    });
    expect(modelDirectives(broadcast, "index")).toEqual(["@@index([status, createdAt])"]);
  });

  it("keeps the additive PostgreSQL migration in parity with the Prisma models", () => {
    expectMigrationColumns("Notification", {
      id: "TEXT NOT NULL",
      userId: "TEXT NOT NULL",
      type: '"NotificationType" NOT NULL',
      category: '"NotificationCategory" NOT NULL',
      title: "TEXT NOT NULL",
      body: "TEXT NOT NULL",
      actionUrl: "TEXT",
      entityType: "TEXT",
      entityId: "TEXT",
      metadata: "JSONB NOT NULL DEFAULT '{}'",
      dedupeKey: "TEXT",
      aggregationKey: "TEXT",
      readAt: "TIMESTAMP(3)",
      deletedAt: "TIMESTAMP(3)",
      expiresAt: "TIMESTAMP(3) NOT NULL",
      createdAt: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
      updatedAt: "TIMESTAMP(3) NOT NULL",
    });
    expectMigrationColumns("NotificationPreference", {
      id: "TEXT NOT NULL",
      userId: "TEXT NOT NULL",
      category: '"NotificationCategory" NOT NULL',
      enabled: "BOOLEAN NOT NULL DEFAULT true",
      createdAt: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
      updatedAt: "TIMESTAMP(3) NOT NULL",
    });
    expectMigrationColumns("NotificationOutbox", {
      id: "TEXT NOT NULL",
      eventType: '"NotificationType" NOT NULL',
      aggregateType: "TEXT NOT NULL",
      aggregateId: "TEXT NOT NULL",
      recipientId: "TEXT",
      payload: "JSONB NOT NULL",
      dedupeKey: "TEXT NOT NULL",
      state: '"NotificationOutboxState" NOT NULL DEFAULT \'PENDING\'',
      attempts: "INTEGER NOT NULL DEFAULT 0",
      availableAt: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
      processedAt: "TIMESTAMP(3)",
      lastError: "TEXT",
      createdAt: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
      updatedAt: "TIMESTAMP(3) NOT NULL",
    });
    expectMigrationColumns("NotificationBroadcast", {
      id: "TEXT NOT NULL",
      audience: '"NotificationBroadcastAudience" NOT NULL',
      audienceValue: "JSONB NOT NULL",
      title: "TEXT NOT NULL",
      body: "TEXT NOT NULL",
      actionUrl: "TEXT",
      status: '"NotificationBroadcastStatus" NOT NULL DEFAULT \'PENDING\'',
      cursor: "TEXT",
      deliveredCount: "INTEGER NOT NULL DEFAULT 0",
      createdBy: "TEXT NOT NULL",
      createdAt: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
      updatedAt: "TIMESTAMP(3) NOT NULL",
    });

    expect(migration).toContain('CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey")');
    expect(migration).toContain('CREATE INDEX "Notification_userId_deletedAt_createdAt_idx" ON "Notification"("userId", "deletedAt", "createdAt")');
    expect(migration).toContain('CREATE INDEX "Notification_userId_readAt_deletedAt_idx" ON "Notification"("userId", "readAt", "deletedAt")');
    expect(migration).toContain('CREATE INDEX "Notification_aggregationKey_createdAt_idx" ON "Notification"("aggregationKey", "createdAt")');
    expect(migration).toContain('CREATE UNIQUE INDEX "NotificationPreference_userId_category_key" ON "NotificationPreference"("userId", "category")');
    expect(migration).toContain('CREATE UNIQUE INDEX "NotificationOutbox_dedupeKey_key" ON "NotificationOutbox"("dedupeKey")');
    expect(migration).toContain('CREATE INDEX "NotificationOutbox_state_availableAt_createdAt_idx" ON "NotificationOutbox"("state", "availableAt", "createdAt")');
    expect(migration).toContain('CREATE INDEX "NotificationBroadcast_status_createdAt_idx" ON "NotificationBroadcast"("status", "createdAt")');
    expect(migration).toContain('ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("firebaseUid") ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).toContain('ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("firebaseUid") ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).not.toMatch(/\b(?:DROP\s+(?:TABLE|TYPE|INDEX|COLUMN|CONSTRAINT)|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|ALTER\s+TABLE[\s\S]*?\bDROP\b)/i);
  });
});
