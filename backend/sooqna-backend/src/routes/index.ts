import { Router } from "express";
import * as path from "node:path";
import { authRouter } from "../modules/auth/auth.routes";
import { uploadRouter } from "../modules/uploads/uploads.routes";
import { usersRouter } from "../modules/users/users.routes";
import { listingsRouter } from "../modules/listings/listings.routes";
import { favoritesRouter } from "../modules/favorites/favorites.routes";
import { messagesRouter } from "../modules/messages/messages.routes";
import { categoriesRouter } from "../modules/categories/categories.routes";
import { citiesRouter } from "./cities";
import { engagementRouter } from "../modules/engagement/engagement.routes";
import { reportsRouter } from "../modules/reports/reports.routes";
import { reviewsRouter } from "../modules/reviews/reviews.routes";
import { auditRouter } from "../modules/audit/audit.routes";
import { adminRouter } from "../modules/admin/admin.routes";
import { contactRouter } from "../modules/contact/contact.routes";
import { marketRouter } from "../modules/market/market.routes";
import { savedSearchesRouter } from "../modules/saved-searches/savedSearches.routes";
import { notificationsRouter } from "../modules/notifications/notifications.routes";
import { verifyFirebaseToken } from "../middleware/verifyFirebaseToken";
import { requireActiveUser, requireCurrentUser } from "../middleware/authContext";
import { checkRole } from "../middleware/checkRole";
import { prisma } from "../config/prisma";
import { env } from "../config/env";
import { readJsonArrayFile } from "../utils/fileStore";
import { Role } from "@prisma/client";
import { shouldExposeDeveloperRoutes } from "./securityPolicy";
import { createNotificationOperationsRepository, getNotificationOperationsWorkerState, NotificationOperationsService } from "../modules/notifications/notifications.operations";
import { getNotificationBroker } from "../modules/notifications/notifications.broker";

export const apiRouter = Router();
const notificationOperations = new NotificationOperationsService(createNotificationOperationsRepository());

apiRouter.get("/health", async (_req, res, next) => {
  try {
    const notifications = await notificationOperations.health({
      workerState: getNotificationOperationsWorkerState(),
      activeStreams: getNotificationBroker().activeCount(),
    });
    res.json({ success: true, data: { status: "ok", uptime: process.uptime(), notifications } });
  } catch (error) {
    next(error);
  }
});

if (shouldExposeDeveloperRoutes(env.nodeEnv)) {
  apiRouter.get(
    "/dev/seed-summary",
    verifyFirebaseToken,
    requireCurrentUser,
    requireActiveUser,
    checkRole([Role.ADMIN]),
    async (_req, res) => {
    try {
    const [users, categories, listings, favorites, conversations, messages] = await Promise.all([
      prisma.user.count(),
      prisma.category.count(),
      prisma.listing.count(),
      prisma.favorite.count(),
      prisma.conversation.count(),
      prisma.message.count(),
    ]);
    res.json({
      success: true,
      source: "database",
      counts: { users, categories, listings, favorites, conversations, messages },
    });
    return;
  } catch {
    if (!env.enableCategoriesJsonFallback) {
      throw new Error("Database seed summary unavailable and JSON fallback is disabled.");
    }

    const usersPath = path.resolve(process.cwd(), "src/modules/users/repositories/users.data.json");
    const categoriesPath = path.resolve(
      process.cwd(),
      "src/modules/categories/repositories/categories.data.json"
    );
    const listingsPath = path.resolve(
      process.cwd(),
      "src/modules/listings/repositories/listings.data.json"
    );
    const favoritesPath = path.resolve(
      process.cwd(),
      "src/modules/favorites/repositories/favorites.data.json"
    );
    const conversationsPath = path.resolve(
      process.cwd(),
      "src/modules/messages/repositories/conversations.data.json"
    );
    const messagesPath = path.resolve(
      process.cwd(),
      "src/modules/messages/repositories/messages.data.json"
    );

    res.json({
      success: true,
      source: "json-fallback",
      counts: {
        users: readJsonArrayFile(usersPath).length,
        categories: readJsonArrayFile(categoriesPath).length,
        listings: readJsonArrayFile(listingsPath).length,
        favorites: readJsonArrayFile(favoritesPath).length,
        conversations: readJsonArrayFile(conversationsPath).length,
        messages: readJsonArrayFile(messagesPath).length,
      },
    });
  }
  }
  );
}

apiRouter.use("/auth", authRouter);
apiRouter.use("/uploads", uploadRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/listings", listingsRouter);
apiRouter.use("/favorites", favoritesRouter);
apiRouter.use("/messages", messagesRouter);
apiRouter.use("/categories", categoriesRouter);
apiRouter.use("/cities", citiesRouter);
apiRouter.use("/engagement", engagementRouter);
apiRouter.use("/reports", reportsRouter);
apiRouter.use("/reviews", reviewsRouter);
apiRouter.use("/audit", auditRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/contact", contactRouter);
apiRouter.use("/market", marketRouter);
apiRouter.use("/saved-searches", savedSearchesRouter);
apiRouter.use("/notifications", notificationsRouter);

