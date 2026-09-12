import type { Request, Response } from "express";
import { AppError } from "../../shared/errors/appError";
import { logAuditEvent } from "../audit/audit.service";
import { PrismaListingsRepository } from "../listings/repositories/listings.repository";
import { PrismaMessagesRepository } from "./repositories/messages.repository";
import { MessagesService } from "./messages.service";

const service = new MessagesService(new PrismaMessagesRepository());
const listingsRepository = new PrismaListingsRepository();

function requireTrustedUid(req: Request): string {
  const uid = req.currentUser?.firebaseUid;
  if (!uid) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  return uid;
}

export async function createConversation(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);

  const listingId = String(req.body?.listingId ?? "");
  const listing = await listingsRepository.findById(listingId);
  if (!listing) {
    throw new AppError(404, "Listing not found", "NOT_FOUND");
  }
  if (listing.ownerId === uid) {
    throw new AppError(400, "You cannot message your own listing.", "VALIDATION_ERROR");
  }
  if (listing.status !== "published") {
    throw new AppError(400, "Listing is not available for messaging.", "VALIDATION_ERROR");
  }

  const participantIds = Array.from(new Set([uid, listing.ownerId].filter(Boolean)));
  const primaryImage =
    listing.images.find((image) => image.isPrimary)?.url ?? listing.images[0]?.url ?? "";
  const participants = {
    [uid]: {
      fullName: req.currentUser?.displayName ?? "",
      photoURL: req.currentUser?.photoURL ?? "",
    },
    ...(listing.ownerId
      ? {
          [listing.ownerId]: {
            fullName: listing.ownerSnapshot.fullName,
            photoURL: listing.ownerSnapshot.photoURL,
          },
        }
      : {}),
  };

  const conversation = await service.createConversation({
    participantIds,
    participants,
    listingId,
    listingSnapshot: {
      title: listing.title,
      primaryImageURL: primaryImage,
    },
    createdBy: uid,
  });
  res.status(201).json({ success: true, conversation });
}

export async function createMessage(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);

  const { message, created } = await service.createMessage({
    conversationId: req.params.conversationId,
    senderId: uid,
    clientRequestId: String(req.body?.clientRequestId ?? ""),
    type: (req.body?.type as "text" | "image" | "system") ?? "text",
    text: String(req.body?.text ?? ""),
    attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
  });
  if (created) {
    await logAuditEvent({
      actorId: uid,
      action: "message.create",
      targetType: "conversation",
      targetId: req.params.conversationId,
      metadata: { messageId: message.id, type: message.type },
    });
  }
  res.status(created ? 201 : 200).json({ success: true, message, created });
}

export async function getConversation(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);

  const conversation = await service.getConversationForUser(req.params.conversationId, uid);
  if (!conversation) {
    throw new AppError(404, "Conversation not found", "NOT_FOUND");
    return;
  }
  res.json({ success: true, conversation });
}

export async function listConversations(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);

  const conversations = await service.listUserConversations(uid);
  res.json({ success: true, conversations });
}

export async function getConversationMessages(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);

  const messages = await service.getMessages(req.params.conversationId, uid);
  res.json({ success: true, messages });
}

export async function markConversationRead(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);
  const result = await service.markConversationRead(req.params.conversationId, uid);
  await logAuditEvent({
    actorId: uid,
    action: "message.read",
    targetType: "conversation",
    targetId: req.params.conversationId,
    metadata: {
      updatedMessages: result.updatedMessages,
      updatedNotifications: result.updatedNotifications,
    },
  });
  res.json({ success: true, ...result, updatedCount: result.updatedMessages });
}

export async function getUnreadSummary(req: Request, res: Response): Promise<void> {
  const uid = requireTrustedUid(req);
  const summary = await service.getUnreadSummary(uid);
  res.json({ success: true, ...summary });
}
