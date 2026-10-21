import type { NotificationItemDto } from "@/types/notification";

export type NotificationState = {
  items: NotificationItemDto[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  reconnecting: boolean;
};

export const initialNotificationState: NotificationState = {
  items: [], unreadCount: 0, loading: false, error: null, reconnecting: false,
};

type Action =
  | { type: "HYDRATE"; items: NotificationItemDto[]; unreadCount: number }
  | { type: "SIGNAL_COUNT"; unreadCount: number }
  | { type: "MARK_READ_OPTIMISTIC"; id: string }
  | { type: "MARK_READ_ROLLBACK"; previous: NotificationState }
  | { type: "MARK_ALL" }
  | { type: "DELETE_OPTIMISTIC"; id: string }
  | { type: "DELETE_ROLLBACK"; previous: NotificationState }
  | { type: "LOADING"; value: boolean }
  | { type: "ERROR"; message: string | null }
  | { type: "RECONNECTING"; value: boolean }
  | { type: "LOGOUT" };

const clamp = (count: number) => Math.max(0, count);

export function notificationReducer(state: NotificationState, action: Action): NotificationState {
  switch (action.type) {
    case "HYDRATE": return { ...state, items: action.items, unreadCount: clamp(action.unreadCount), loading: false, error: null, reconnecting: false };
    case "SIGNAL_COUNT": return { ...state, unreadCount: clamp(action.unreadCount) };
    case "MARK_READ_OPTIMISTIC": {
      const item = state.items.find((entry) => entry.id === action.id);
      if (!item || item.readAt) return state;
      return { ...state, items: state.items.map((entry) => entry.id === action.id ? { ...entry, readAt: "optimistic" } : entry), unreadCount: clamp(state.unreadCount - 1) };
    }
    case "MARK_READ_ROLLBACK": return action.previous;
    case "MARK_ALL": return { ...state, items: state.items.map((entry) => entry.readAt ? entry : { ...entry, readAt: "optimistic" }), unreadCount: 0 };
    case "DELETE_OPTIMISTIC": return { ...state, items: state.items.filter((entry) => entry.id !== action.id) };
    case "DELETE_ROLLBACK": return action.previous;
    case "LOADING": return { ...state, loading: action.value };
    case "ERROR": return { ...state, error: action.message, loading: false };
    case "RECONNECTING": return { ...state, reconnecting: action.value };
    case "LOGOUT": return initialNotificationState;
    default: return state;
  }
}
