import { notificationListQuerySchema, notificationPreferencesUpdateBodySchema } from "./notifications.schemas";
import { listNotifications } from "./notifications.controller";
import { notificationsRouter } from "./notifications.routes";
import { NotificationsService } from "./notifications.service";

describe("notification REST route contract", () => {
  it("accepts bounded notification list and optional-only preference inputs", () => {
    expect(notificationListQuerySchema.parse({ limit: "50", category: "MESSAGES", unread: "true" })).toMatchObject({ limit: 50, category: "MESSAGES", unread: true });
    expect(notificationListQuerySchema.safeParse({ userId: "someone-else" }).success).toBe(false);
    expect(notificationListQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(notificationPreferencesUpdateBodySchema.parse({ MESSAGES: false })).toEqual({ MESSAGES: false });
    expect(notificationPreferencesUpdateBodySchema.safeParse({ SYSTEM: false }).success).toBe(false);
  });

  it("registers fixed routes before parameterized notification IDs", () => {
    const paths = notificationsRouter.stack.map((layer) => layer.route?.path).filter(Boolean);
    expect(paths).toEqual(["/", "/unread-count", "/read-all", "/preferences", "/preferences", "/:notificationId/read", "/:notificationId"]);
    expect(notificationsRouter.stack.slice(0, 4).map((layer) => layer.handle.name)).toEqual(["verifyFirebaseToken", "requireCurrentUser", "requireActiveUser", "requireVerifiedEmail"]);
  });

  it("uses the authenticated current user and wraps list responses in the standard success shape", async () => {
    const list = jest.spyOn(NotificationsService.prototype, "list").mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
    const json = jest.fn(); const status = jest.fn().mockReturnValue({ json });
    await listNotifications({ currentUser: { firebaseUid: "user-a" }, query: { limit: 20 } } as never, { status } as never);
    expect(list).toHaveBeenCalledWith("user-a", { limit: 20 });
    expect(status).toHaveBeenCalledWith(200); expect(json).toHaveBeenCalledWith({ success: true, data: { items: [], hasMore: false, nextCursor: null } });
    list.mockRestore();
  });
});
