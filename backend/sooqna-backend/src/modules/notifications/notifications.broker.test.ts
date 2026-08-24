import { AppError } from "../../shared/errors/appError";
import { NotificationBroker } from "./notifications.broker";

type FakeResponse = { write: jest.Mock };
const response = (): FakeResponse => ({ write: jest.fn(() => true) });

describe("NotificationBroker", () => {
  test("limits each user to three streams without affecting another user", () => {
    const broker = new NotificationBroker();
    const cleanups = [broker.subscribe("user-a", response() as never), broker.subscribe("user-a", response() as never), broker.subscribe("user-a", response() as never)];

    expect(() => broker.subscribe("user-a", response() as never)).toThrow(AppError);
    expect(() => broker.subscribe("user-a", response() as never)).toThrow(expect.objectContaining({ statusCode: 429, code: "TOO_MANY_STREAMS" }));
    const userBCleanup = broker.subscribe("user-b", response() as never);
    expect(broker.activeCount("user-a")).toBe(3);
    expect(broker.activeCount("user-b")).toBe(1);
    cleanups.forEach((cleanup) => cleanup()); userBCleanup();
  });

  test("publishes a content-free SSE signal only to the owning user's streams", () => {
    const broker = new NotificationBroker();
    const owner = response(); const other = response();
    broker.subscribe("user-a", owner as never); broker.subscribe("user-b", other as never);

    broker.publish("user-a", { event: "notification", id: "notification-1", unreadCount: 2, version: 1 });

    expect(owner.write).toHaveBeenCalledWith("event: notification\nid: notification-1\ndata: {\"id\":\"notification-1\",\"unreadCount\":2,\"version\":1}\n\n");
    expect(other.write).not.toHaveBeenCalled();
    expect(owner.write.mock.calls[0][0]).not.toContain("body");
  });

  test("removes failed streams and makes unsubscribe idempotent", () => {
    const broker = new NotificationBroker();
    const failed = response(); failed.write.mockImplementation(() => { throw new Error("closed"); });
    const cleanup = broker.subscribe("user-a", failed as never);

    broker.publish("user-a", { event: "notification", id: "notification-1", unreadCount: 1, version: 1 });
    expect(broker.activeCount("user-a")).toBe(0);
    expect(() => { cleanup(); cleanup(); }).not.toThrow();
    expect(broker.activeCount()).toBe(0);
  });
});
