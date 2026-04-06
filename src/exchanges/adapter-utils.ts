import { extractMessage } from "../utils/errors";

/**
 * Wrap a callback so exceptions inside it are swallowed and logged.
 * Used by adapter watch* methods to prevent gateway callback errors
 * from killing the event loop.
 */
export function createSafeInvoke(adapterName: string) {
  return function safeInvoke<T extends (...args: any[]) => void>(context: string, cb: T): T {
    const wrapped = ((...args: any[]) => {
      try {
        cb(...args);
      } catch (error) {
        console.error(`[${adapterName}] ${context} handler failed: ${extractMessage(error)}`);
      }
    }) as T;
    return wrapped;
  };
}

export interface InitManager {
  ensureInitialized(context?: string): Promise<void>;
}

/**
 * Creates a reusable init-once-with-retry manager.
 * Every adapter uses the same pattern: cache the init promise, retry on
 * failure with exponential back-off, and deduplicate context error logs.
 */
export function createInitManager(
  adapterName: string,
  doInitialize: () => Promise<void>,
): InitManager {
  let initPromise: Promise<void> | null = null;
  const initContexts = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = 3000;
  let lastInitErrorAt = 0;

  function clearRetry(): void {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryDelayMs = 3000;
  }

  function handleInitError(context: string, error: unknown): void {
    const now = Date.now();
    if (now - lastInitErrorAt < 5000) return;
    lastInitErrorAt = now;
    console.error(`[${adapterName}] ${context} failed`, error);
  }

  function scheduleRetry(): void {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (initPromise) return;
      retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
      void ensureInitialized("retry");
    }, retryDelayMs);
  }

  function ensureInitialized(context?: string): Promise<void> {
    if (!initPromise) {
      initContexts.clear();
      initPromise = doInitialize()
        .then((value) => {
          clearRetry();
          return value;
        })
        .catch((error) => {
          handleInitError("initialize", error);
          initPromise = null;
          scheduleRetry();
          throw error;
        });
    }
    if (context && !initContexts.has(context)) {
      initContexts.add(context);
      initPromise.catch((error) => {
        handleInitError(context, error);
        scheduleRetry();
      });
    }
    return initPromise;
  }

  return { ensureInitialized };
}
