"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { RequireAuthGate } from "@/components/auth/RequireAuthGate";
import { isEmailNotVerified } from "@/lib/apiError";
import { EmailVerificationBanner } from "@/components/ui/EmailVerificationBanner";
import {
  createMessage,
  enqueuePendingMessage,
  flushPendingMessages,
  getConversationById,
  getConversationMessages,
  getMyConversations,
  getUnreadSummary,
  markConversationRead,
} from "@/services/messageService";
import type { Conversation, Message } from "@/types/message";
import { ConversationList } from "./ConversationList";
import { ChatPanel } from "./ChatPanel";
import {
  canPollMessages,
  createSingleFlightRunner,
  getRateLimitBlockedUntil,
  refreshMessagePollCycle,
} from "./messagePolling";

const POLL_INTERVAL_MS = 30_000;

export function MessagesWorkspace({ initialConversationId = "" }: { initialConversationId?: string }) {
  const { currentUser } = useAuth();
  const [mobileView, setMobileView] = useState<"list" | "chat">(
    initialConversationId ? "chat" : "list"
  );
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [inbox, setInbox] = useState<Conversation[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailUnverified, setEmailUnverified] = useState(false);

  const lastMessageCountRef = useRef(0);
  const blockedUntilRef = useRef(0);
  const singleFlightRef = useRef(createSingleFlightRunner());

  const refreshInbox = useCallback(async () => {
    if (!currentUser) {
      return { totalUnread: 0, byConversation: {} };
    }
    setInboxLoading(true);
    try {
      const [conversations, unreadSummary] = await Promise.all([
        getMyConversations(),
        getUnreadSummary(),
      ]);
      setInbox(conversations);
      setUnreadTotal(unreadSummary.totalUnread);
      return unreadSummary;
    } catch (err) {
      if (isEmailNotVerified(err)) setEmailUnverified(true);
      throw err;
    } finally {
      setInboxLoading(false);
    }
  }, [currentUser]);

  const refreshConversationData = useCallback(async (targetId: string, silent = false) => {
    if (!silent) setChatLoading(true);
    setError(null);
    try {
      const [convoData, messagesData] = await Promise.all([
        getConversationById(targetId),
        getConversationMessages(targetId),
      ]);
      setConversation(convoData);
      if (messagesData.length !== lastMessageCountRef.current) {
        setMessages(messagesData);
        lastMessageCountRef.current = messagesData.length;
      }
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : "فشل تحميل المحادثة.");
      }
      throw err;
    } finally {
      if (!silent) setChatLoading(false);
    }
  }, []);

  const applyReadState = useCallback((targetId: string, updatedCount: number) => {
    setUnreadTotal((current) => Math.max(0, current - updatedCount));
    setInbox((current) =>
      current.map((item) =>
        item.id === targetId ? { ...item, unreadCount: 0 } : item
      )
    );
  }, []);

  const runRefreshCycle = useCallback(async (
    targetId: string,
    silent = true
  ): Promise<boolean> => {
    if (!currentUser) return false;

    const now = Date.now();
    const visibilityState = typeof document === "undefined"
      ? "visible"
      : document.visibilityState;
    if (!canPollMessages({ visibilityState, blockedUntil: blockedUntilRef.current, now })) {
      if (!silent && now < blockedUntilRef.current) {
        const seconds = Math.ceil((blockedUntilRef.current - now) / 1_000);
        setError(`طلبات كثيرة. يمكنك المحاولة بعد ${seconds} ثانية.`);
      }
      return false;
    }

    try {
      return await singleFlightRef.current(() =>
        refreshMessagePollCycle({
          conversationId: targetId,
          refreshInbox,
          refreshConversation: (id) => refreshConversationData(id, silent),
          markRead: markConversationRead,
          applyReadState,
        })
      );
    } catch (err) {
      const blockedUntil = getRateLimitBlockedUntil(err, Date.now());
      if (blockedUntil !== null) {
        blockedUntilRef.current = blockedUntil;
        setError(err instanceof Error ? err.message : "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.");
      } else if (!silent) {
        setError(err instanceof Error ? err.message : "فشل تحديث الرسائل.");
      }
      return false;
    }
  }, [applyReadState, currentUser, refreshConversationData, refreshInbox]);

  useEffect(() => {
    if (!initialConversationId) return;
    setConversationId(initialConversationId);
    setMobileView("chat");
  }, [initialConversationId]);

  useEffect(() => {
    void flushPendingMessages().then((count) => {
      if (count > 0) void runRefreshCycle("", true);
    });
  }, [runRefreshCycle]);

  useEffect(() => {
    if (!currentUser) return;
    lastMessageCountRef.current = 0;
    void runRefreshCycle(conversationId, false);
  }, [conversationId, currentUser, runRefreshCycle]);

  // Polling
  useEffect(() => {
    if (!currentUser) return;
    const refresh = () => void runRefreshCycle(conversationId, true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const interval = window.setInterval(refresh, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [currentUser, conversationId, runRefreshCycle]);

  // Mobile back button support
  useEffect(() => {
    if (mobileView !== "chat") return;
    function handlePopState() {
      setMobileView("list");
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [mobileView]);

  function handleSelectConversation(id: string) {
    setConversationId(id);
    setMobileView("chat");
    window.history.pushState({ messagesView: "chat" }, "");
  }

  function handleBack() {
    setMobileView("list");
    setConversationId("");
    setConversation(null);
    setMessages([]);
  }

  async function handleSendMessage(text: string) {
    if (!currentUser || !conversationId.trim()) return;
    setSendingMessage(true);
    setError(null);

    const optimisticMessage: Message = {
      id: `tmp-${Date.now()}`,
      senderId: currentUser.uid,
      type: "text",
      text,
      attachments: [],
      isRead: false,
      readAt: null,
      createdAt: new Date().toISOString(),
      deletedAt: null,
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      await createMessage(conversationId.trim(), {
        senderId: currentUser.uid,
        type: "text",
        text,
      });
      lastMessageCountRef.current = 0;
      await runRefreshCycle(conversationId.trim(), true);
    } catch (err) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        enqueuePendingMessage(conversationId.trim(), {
          senderId: currentUser.uid,
          type: "text",
          text,
        });
        setError("أنت غير متصل الآن. تم حفظ الرسالة محلياً وسيتم إرسالها عند عودة الاتصال.");
      } else {
        setError(err instanceof Error ? err.message : "فشل إرسال الرسالة.");
        setMessages((prev) => prev.filter((item) => item.id !== optimisticMessage.id));
      }
    } finally {
      setSendingMessage(false);
    }
  }

  return (
    <RequireAuthGate fallbackMessage="يتم التحقق من الجلسة قبل فتح الرسائل...">
      {emailUnverified && <EmailVerificationBanner />}

      {error && (
        <p className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]" style={{ height: "calc(100vh - 260px)", minHeight: "480px" }}>
        {/* Desktop: side-by-side */}
        <div className="hidden h-full md:flex">
          <div className="w-80 shrink-0 border-e border-[var(--border)] bg-[var(--bg)]">
            <ConversationList
              conversations={inbox}
              activeConversationId={conversationId || null}
              currentUserId={currentUser?.uid ?? ""}
              totalUnread={unreadTotal}
              loading={inboxLoading}
              onSelectConversation={handleSelectConversation}
              onRefresh={() => void runRefreshCycle(conversationId, false)}
            />
          </div>
          <div className="flex-1">
            <ChatPanel
              conversation={conversation}
              messages={messages}
              currentUserId={currentUser?.uid ?? ""}
              loading={chatLoading}
              onSendMessage={(t) => void handleSendMessage(t)}
              sendingMessage={sendingMessage}
            />
          </div>
        </div>

        {/* Mobile: toggle between list and chat */}
        <div className="flex h-full flex-col md:hidden">
          {mobileView === "list" ? (
            <ConversationList
              conversations={inbox}
              activeConversationId={conversationId || null}
              currentUserId={currentUser?.uid ?? ""}
              totalUnread={unreadTotal}
              loading={inboxLoading}
              onSelectConversation={handleSelectConversation}
              onRefresh={() => void runRefreshCycle(conversationId, false)}
            />
          ) : (
            <ChatPanel
              conversation={conversation}
              messages={messages}
              currentUserId={currentUser?.uid ?? ""}
              loading={chatLoading}
              onSendMessage={(t) => void handleSendMessage(t)}
              sendingMessage={sendingMessage}
              onBack={handleBack}
            />
          )}
        </div>
      </div>
    </RequireAuthGate>
  );
}
