import { reconnectDelay } from "./notificationStream";

type LifecycleOptions = {
  canConnect(): boolean;
  refresh(): Promise<void>;
  connect(signal: AbortSignal): Promise<void>;
  onReconnect(): void;
  retryDelay?(attempt: number): number;
};

/** Serializes REST recovery, streams, and reconnects for one authenticated session. */
export class NotificationLifecycle {
  private controller: AbortController | null = null;
  private running = false;
  private disposed = false;
  private resumeRequested = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(private readonly options: LifecycleOptions) {}

  resume(): void {
    if (this.disposed) return;
    this.clearTimer();
    if (this.running && !this.controller?.signal.aborted) return;
    this.resumeRequested = true;
    this.start();
  }

  pause(): void {
    this.resumeRequested = false;
    this.clearTimer();
    this.controller?.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
  }

  /** A delivered server signal establishes a healthy connection. */
  connected(): void { this.attempt = 0; }

  private start(): void {
    if (this.disposed || this.running || !this.options.canConnect()) return;
    this.resumeRequested = false;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    void (async () => {
      try {
        await this.options.refresh();
        if (!this.disposed && !controller.signal.aborted && this.options.canConnect()) {
          await this.options.connect(controller.signal);
        }
      } catch { /* The provider exposes the recoverable REST error; reconnect below. */ }
      finally {
        this.running = false;
        if (this.controller === controller) this.controller = null;
        if (this.disposed || !this.options.canConnect()) return;
        if (this.resumeRequested) { this.start(); return; }
        if (!controller.signal.aborted) {
          this.options.onReconnect();
          this.timer = setTimeout(() => {
            this.timer = null;
            this.start();
          }, (this.options.retryDelay ?? reconnectDelay)(this.attempt++));
        }
      }
    })();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
