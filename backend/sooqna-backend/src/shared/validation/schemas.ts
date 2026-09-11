import { z } from "zod";
import { LISTING_CURRENCIES } from "../constants/domain";

/** Coerce empty/whitespace-only query strings to undefined (i.e. "no filter"). */
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const idParamSchema = z.object({
  id: z.string().min(1),
});

const listingIdParamSchema = z.object({
  listingId: z.string().min(1),
});

const conversationIdParamSchema = z.object({
  conversationId: z.string().min(1),
});

const conversationUnreadParamsSchema = z.object({
  conversationId: z.string().min(1),
});

export const userProfileBodySchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    photoURL: z.string().trim().url().max(2048).optional(),
  })
  .strict();

export const userProfilePatchBodySchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    photoURL: z.string().trim().url().max(2048).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one profile field is required.",
  });

const listingLocationSchema = z.object({
  country: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(120),
  area: z.string().trim().min(1).max(120),
});

export const createListingBodySchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    price: z.number().finite().nonnegative(),
    currency: z.enum(LISTING_CURRENCIES).optional().default("SYP"),
    categoryId: z.string().trim().min(1).max(120),
    description: z.string().trim().max(10000).optional(),
    clientRequestId: z.string().trim().min(8).max(120).optional(),
    location: listingLocationSchema,
  })
  .strict();

export const patchListingBodySchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(10000).optional(),
    price: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required for patch.",
  });

export const renewListingBodySchema = z
  .object({
    durationDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export const attachListingImageBodySchema = z
  .object({
    url: z.string().trim().url().max(2048),
    path: z.string().trim().min(1).max(2048),
  })
  .strict();

export const createConversationBodySchema = z
  .object({
    listingId: z.string().trim().min(1),
    participantIds: z.unknown().optional(),
    participants: z.unknown().optional(),
    listingSnapshot: z.unknown().optional(),
    createdBy: z.unknown().optional(),
  })
  .strict();

export const createMessageBodySchema = z
  .object({
    clientRequestId: z.string().trim().min(8).max(128),
    type: z.enum(["text", "image", "system"]).default("text"),
    text: z.string().trim().max(4000).optional().default(""),
    attachments: z.array(z.unknown()).max(5).optional().default([]),
  })
  .strict()
  .refine((value) => value.type !== "text" || value.text.length > 0, {
    message: "text is required when type is text",
    path: ["text"],
  });

export const categoriesQuerySchema = z
  .object({
    activeOnly: z.enum(["true", "false", "1", "0"]).optional(),
  })
  .strict();

export const listingsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    // Treat empty/whitespace query params (e.g. ?city=) as "no filter" rather
    // than a validation error, so the "all cities/categories" UI state is valid.
    category: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(120).optional()),
    city: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(120).optional()),
    search: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
    sort: z.enum(["price_asc", "price_desc", "newest"]).optional(),
    priceMin: z.coerce.number().nonnegative().optional(),
    priceMax: z.coerce.number().nonnegative().optional(),
  })
  .strict();

export const moderationQueueQuerySchema = z
  .object({
    status: z.enum(["open", "in_review", "resolved", "rejected"]).optional(),
  })
  .strict();

export const auditLogsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

export const engagementEventBodySchema = z
  .object({
    eventType: z.enum(["favorite", "view", "contact_intent"]),
    listingId: z.string().trim().min(1).max(120).optional(),
    conversationId: z.string().trim().min(1).max(120).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const engagementRecentQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const recaptchaVerifyBodySchema = z
  .object({
    token: z.string().trim().min(1).optional(),
  })
  .strict();

export const emptyQuerySchema = z.object({}).strict();
export const emptyBodySchema = z.object({}).strict();
export const uploadMultipartFieldsSchema = z.record(z.string(), z.string()).optional().default({});

export const createReportBodySchema = z
  .object({
    targetType: z.enum(["listing", "message", "user"]),
    targetId: z.string().trim().min(1).max(120),
    reasonCode: z
      .enum(["spam", "abuse", "fraud", "inappropriate", "other"])
      .default("other"),
    details: z.string().trim().max(2000).optional().default(""),
  })
  .strict();

export const updateReportStatusBodySchema = z
  .object({
    status: z.enum(["open", "in_review", "resolved", "rejected"]),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const createReviewBodySchema = z
  .object({
    sellerId: z.string().trim().min(1).max(120),
    listingId: z.string().trim().min(1).max(120),
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(2000).optional().default(""),
  })
  .strict();

export const sellerIdParamsSchema = z.object({
  sellerId: z.string().min(1),
});

export const reviewsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export const batchListingIdsBodySchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(50),
  })
  .strict();

export const idParamsSchema = idParamSchema;
export const listingIdParamsSchema = listingIdParamSchema;
export const conversationIdParamsSchema = conversationIdParamSchema;
export const conversationUnreadParams = conversationUnreadParamsSchema;
