"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/hooks/useAuth";
import { ThemeProvider } from "@/contexts/theme-context";
import { NotificationProvider } from "@/contexts/notification-context";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <NotificationProvider>
        <ThemeProvider>{children}</ThemeProvider>
      </NotificationProvider>
    </AuthProvider>
  );
}
