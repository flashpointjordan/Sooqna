import { NotificationCategory, Role } from "@prisma/client";
import { z } from "zod";
import { assertInternalActionUrl } from "./notifications.templates";

const notificationIdSchema = z.string().trim().min(1).max(128);
const hasAtMostCodePoints = (maximum: number) => (value: string): boolean => Array.from(value).length <= maximum;
const codePointLimitedText = (maximum: number) =>
  z.string().trim().min(1).refine(hasAtMostCodePoints(maximum), `Must be at most ${maximum} Unicode code points`);
const strictNumericLimit = z
  .preprocess(
    (value) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value,
    z.number().int().min(1).max(50)
  )
  .default(20);
const internalActionUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      return assertInternalActionUrl(value) !== null;
    } catch {
      return false;
    }
  }, "Internal action URL required");

export const notificationListQuerySchema = z
  .object({
    limit: strictNumericLimit,
    cursor: z.string().trim().min(1).max(512).optional(),
    category: z.enum(NotificationCategory).optional(),
    unread: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
  })
  .strict();

export const notificationIdParamsSchema = z.object({ id: notificationIdSchema }).strict();

export const notificationPreferencesUpdateBodySchema = z
  .object({
    MESSAGES: z.boolean().optional(),
    LISTINGS: z.boolean().optional(),
    ENGAGEMENT: z.boolean().optional(),
    SAVED_SEARCHES: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one notification preference is required");

const broadcastCopySchema = {
  title: codePointLimitedText(100),
  body: codePointLimitedText(240),
  actionUrl: internalActionUrlSchema.optional(),
};

export const adminNotificationBroadcastBodySchema = z.discriminatedUnion("audience", [
  z
    .object({
      ...broadcastCopySchema,
      audience: z.literal("ALL"),
      audienceValue: z.null(),
    })
    .strict(),
  z
    .object({
      ...broadcastCopySchema,
      audience: z.literal("ROLES"),
      audienceValue: z.object({ roles: z.array(z.enum(Role)).min(1).max(3) }).strict(),
    })
    .strict(),
  z
    .object({
      ...broadcastCopySchema,
      audience: z.literal("USERS"),
      audienceValue: z.object({ userIds: z.array(notificationIdSchema).min(1).max(100) }).strict(),
    })
    .strict(),
]);

export const notificationPreferencesBodySchema = notificationPreferencesUpdateBodySchema;
export const notificationBroadcastBodySchema = adminNotificationBroadcastBodySchema;
