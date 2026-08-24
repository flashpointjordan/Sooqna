import assert from "node:assert/strict";
import { ApiRequestError } from "../src/services/apiRequestError";
import {
  canPollMessages,
  createSingleFlightRunner,
  getRateLimitBlockedUntil,
  refreshMessagePollCycle,
} from "../src/components/messages/messagePolling";

assert.equal(
  canPollMessages({ visibilityState: "hidden", blockedUntil: 0, now: 100 }),
  false
);
assert.equal(
  canPollMessages({ visibilityState: "visible", blockedUntil: 200, now: 100 }),
  false
);
assert.equal(
  canPollMessages({ visibilityState: "visible", blockedUntil: 100, now: 100 }),
  true
);
assert.equal(
  getRateLimitBlockedUntil(
    new ApiRequestError("limited", 429, "RATE_LIMITED", 35),
    1_000
  ),
  36_000
);
assert.equal(
  getRateLimitBlockedUntil(new ApiRequestError("busy", 503, "UNAVAILABLE"), 1_000),
  null
);

async function run(): Promise<void> {
  const singleFlight = createSingleFlightRunner();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;

  const first = singleFlight(async () => {
    runs += 1;
    await gate;
  });
  const second = await singleFlight(async () => {
    runs += 1;
  });

  assert.equal(second, false);
  assert.equal(runs, 1);
  release?.();
  assert.equal(await first, true);
  assert.equal(await singleFlight(async () => { runs += 1; }), true);
  assert.equal(runs, 2);

  const calls = { inbox: 0, conversation: 0, markRead: 0, applyReadState: 0 };
  await refreshMessagePollCycle({
    conversationId: "conversation-1",
    refreshInbox: async () => {
      calls.inbox += 1;
      return {
        totalUnread: 2,
        byConversation: { "conversation-1": 2 },
      };
    },
    refreshConversation: async (conversationId) => {
      assert.equal(conversationId, "conversation-1");
      calls.conversation += 1;
    },
    markRead: async (conversationId) => {
      assert.equal(conversationId, "conversation-1");
      calls.markRead += 1;
      return 2;
    },
    applyReadState: (conversationId, unreadCount) => {
      assert.equal(conversationId, "conversation-1");
      assert.equal(unreadCount, 2);
      calls.applyReadState += 1;
    },
  });

  assert.deepEqual(calls, {
    inbox: 1,
    conversation: 1,
    markRead: 1,
    applyReadState: 1,
  });
}

void run();
