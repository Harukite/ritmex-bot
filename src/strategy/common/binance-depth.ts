import NodeWebSocket from "ws";
import { computeDepthStats, type DepthImbalance } from "../../utils/depth";

const WebSocketCtor: typeof globalThis.WebSocket =
  typeof globalThis.WebSocket !== "undefined"
    ? globalThis.WebSocket
    : ((NodeWebSocket as unknown) as typeof globalThis.WebSocket);

const DEFAULT_BASE_URL = "wss://stream.binance.com:9443/ws";

// ========== Binance WebSocket 连接管理常量 ==========
// Binance 会发送 ping，若长时间无消息则认为连接异常
// 我们设置 5 分钟作为心跳超时阈值（保守值）
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
// 心跳检查间隔（每 30 秒检查一次）
const HEARTBEAT_CHECK_INTERVAL_MS = 30_000;
// Binance 连接最长有效期 24 小时，我们设置 23 小时主动重连
const MAX_CONNECTION_DURATION_MS = 23 * 60 * 60 * 1000;
// 数据过时阈值（毫秒）- 超过此时间未收到数据，标记为不可用
const DATA_STALE_THRESHOLD_MS = 5_000;
// 基础重连延迟
const RECONNECT_DELAY_BASE_MS = 3000;
// 最大重连延迟
const RECONNECT_DELAY_MAX_MS = 60_000;

export type BinanceConnectionState = "connected" | "disconnected" | "stale";

export interface BinanceDepthSnapshot {
  symbol: string;
  buySum: number;
  sellSum: number;
  skipBuySide: boolean;
  skipSellSide: boolean;
  imbalance: DepthImbalance;
  updatedAt: number;
}

export type BinanceConnectionListener = (state: BinanceConnectionState) => void;

export class BinanceDepthTracker {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_DELAY_BASE_MS;
  private stopped = false;
  private snapshot: BinanceDepthSnapshot | null = null;
  private listeners = new Set<(snapshot: BinanceDepthSnapshot) => void>();
  private connectionListeners = new Set<BinanceConnectionListener>();

  // ========== 心跳与连接管理 ==========
  // 上次收到消息的时间戳
  private lastMessageTime = 0;
  // 心跳检查定时器
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // 连接建立时间（用于日志记录）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private connectionStartTime = 0;
  // 24 小时重连定时器
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  // 当前连接状态
  private connectionState: BinanceConnectionState = "disconnected";

  constructor(
    private readonly symbol: string,
    private readonly options?: {
      baseUrl?: string;
      levels?: number;
      ratio?: number;
      speedMs?: number;
      logger?: (context: string, error: unknown) => void;
    }
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cleanup();
  }

  onUpdate(handler: (snapshot: BinanceDepthSnapshot) => void): void {
    this.listeners.add(handler);
  }

  offUpdate(handler: (snapshot: BinanceDepthSnapshot) => void): void {
    this.listeners.delete(handler);
  }

  /**
   * 监听连接状态变化
   */
  onConnectionChange(handler: BinanceConnectionListener): void {
    this.connectionListeners.add(handler);
  }

  offConnectionChange(handler: BinanceConnectionListener): void {
    this.connectionListeners.delete(handler);
  }

  getSnapshot(): BinanceDepthSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  /**
   * 获取当前连接状态
   */
  getConnectionState(): BinanceConnectionState {
    return this.connectionState;
  }

  /**
   * 检查数据是否过时
   */
  isDataStale(): boolean {
    if (!this.snapshot) return true;
    return Date.now() - this.snapshot.updatedAt > DATA_STALE_THRESHOLD_MS;
  }

  private cleanup(): void {
    // 停止心跳监控
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // 停止 24 小时重连定时器
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    // 停止重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 关闭 WebSocket
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.ws || this.stopped) return;
    const url = this.buildUrl();
    this.ws = new WebSocketCtor(url);

    const handleOpen = () => {
      this.reconnectDelayMs = RECONNECT_DELAY_BASE_MS;
      this.connectionStartTime = Date.now();
      this.lastMessageTime = Date.now();
      this.updateConnectionState("connected");

      // 启动心跳监控
      this.startHeartbeatMonitor();
      // 启动 24 小时自动重连定时器
      this.startMaxDurationTimer();

      this.options?.logger?.("binanceDepth", "WebSocket connected");
    };

    const handleClose = () => {
      this.ws = null;
      this.stopHeartbeatMonitor();
      this.stopMaxDurationTimer();
      this.updateConnectionState("disconnected");

      if (!this.stopped) {
        this.options?.logger?.("binanceDepth", "WebSocket closed, scheduling reconnect");
        this.scheduleReconnect();
      }
    };

    const handleError = (error: unknown) => {
      this.options?.logger?.("binanceDepth", error);
      // 如果连接从未成功建立，需要清理并重连
      if (this.ws && this.connectionState === "disconnected") {
        this.ws = null;
        this.scheduleReconnect();
      }
    };

    const handleMessage = (event: { data: unknown }) => {
      this.lastMessageTime = Date.now();
      // 如果之前是 stale 状态，恢复为 connected
      if (this.connectionState === "stale") {
        this.updateConnectionState("connected");
      }
      this.handlePayload(event.data);
    };

    // 处理 Binance 服务器的 ping 帧
    // 根据文档：必须尽快回复 pong，payload 为 ping 的 payload 副本
    const handlePing = (data: unknown) => {
      this.lastMessageTime = Date.now();
      if (this.ws && "pong" in this.ws && typeof this.ws.pong === "function") {
        try {
          this.ws.pong(data as any);
        } catch (error) {
          this.options?.logger?.("binanceDepth pong", error);
        }
      }
    };

    if ("addEventListener" in this.ws && typeof this.ws.addEventListener === "function") {
      this.ws.addEventListener("open", handleOpen);
      this.ws.addEventListener("message", handleMessage as any);
      this.ws.addEventListener("close", handleClose);
      this.ws.addEventListener("error", handleError as any);
      this.ws.addEventListener("ping", handlePing as any);
    } else if ("on" in this.ws && typeof (this.ws as any).on === "function") {
      const nodeSocket = this.ws as any;
      nodeSocket.on("open", handleOpen);
      nodeSocket.on("message", (data: unknown) => handleMessage({ data }));
      nodeSocket.on("close", handleClose);
      nodeSocket.on("error", handleError);
      nodeSocket.on("ping", handlePing);
    } else {
      (this.ws as any).onopen = handleOpen;
      (this.ws as any).onmessage = handleMessage;
      (this.ws as any).onclose = handleClose;
      (this.ws as any).onerror = handleError;
    }
  }

  private buildUrl(): string {
    const base = this.options?.baseUrl ?? DEFAULT_BASE_URL;
    const levels = this.options?.levels ?? 10;
    const speed = this.options?.speedMs ?? 100;
    const stream = `${this.symbol.toLowerCase()}@depth${levels}@${speed}ms`;
    return `${base}/${stream}`;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
      this.connect();
    }, this.reconnectDelayMs);
  }

  /**
   * 启动心跳监控
   * 根据 Binance 文档：长时间无 pong 会断连
   * 我们设置 5 分钟作为心跳超时阈值
   */
  private startHeartbeatMonitor(): void {
    this.stopHeartbeatMonitor();
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastMessageTime;

      // 检查数据是否过时（5 秒无数据）
      if (elapsed > DATA_STALE_THRESHOLD_MS && this.connectionState === "connected") {
        this.updateConnectionState("stale");
        this.options?.logger?.("binanceDepth", `Data stale: ${elapsed}ms since last message`);
      }

      // 检查心跳超时（5 分钟无消息）
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        this.options?.logger?.("binanceDepth", `Heartbeat timeout: ${elapsed}ms, forcing reconnect`);
        this.forceReconnect("heartbeat_timeout");
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 启动 24 小时自动重连定时器
   * 根据 Binance 文档：连接最长有效期 24 小时
   * 我们设置 23 小时主动重连，避免被服务器断开
   */
  private startMaxDurationTimer(): void {
    this.stopMaxDurationTimer();
    this.maxDurationTimer = setTimeout(() => {
      this.options?.logger?.("binanceDepth", "Max connection duration reached (23h), reconnecting");
      this.forceReconnect("max_duration");
    }, MAX_CONNECTION_DURATION_MS);
  }

  private stopMaxDurationTimer(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  /**
   * 强制重连
   */
  private forceReconnect(reason: string): void {
    this.options?.logger?.("binanceDepth", `Force reconnect: ${reason}`);
    this.stopHeartbeatMonitor();
    this.stopMaxDurationTimer();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.updateConnectionState("disconnected");
    // 立即重连（不使用指数退避）
    this.reconnectDelayMs = RECONNECT_DELAY_BASE_MS;
    this.scheduleReconnect();
  }

  /**
   * 更新连接状态并通知监听器
   */
  private updateConnectionState(state: BinanceConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const listener of this.connectionListeners) {
      try {
        listener(state);
      } catch (error) {
        this.options?.logger?.("binanceDepth connectionListener", error);
      }
    }
  }

  private handlePayload(data: unknown): void {
    const payload = this.parsePayload(data);
    if (!payload) return;
    const bids = Array.isArray(payload.b) ? payload.b : Array.isArray(payload.bids) ? payload.bids : [];
    const asks = Array.isArray(payload.a) ? payload.a : Array.isArray(payload.asks) ? payload.asks : [];
    const depth = {
      lastUpdateId: Number(payload.lastUpdateId ?? payload.u ?? Date.now()),
      bids,
      asks,
    };
    const levels = this.options?.levels ?? 10;
    const ratio = this.options?.ratio ?? 3;
    const stats = computeDepthStats(depth, levels, ratio);
    this.snapshot = {
      symbol: this.symbol,
      buySum: stats.buySum,
      sellSum: stats.sellSum,
      skipBuySide: stats.skipBuySide,
      skipSellSide: stats.skipSellSide,
      imbalance: stats.imbalance,
      updatedAt: Date.now(),
    };
    for (const listener of this.listeners) {
      try {
        listener({ ...this.snapshot });
      } catch (error) {
        this.options?.logger?.("binanceDepth listener", error);
      }
    }
  }

  private parsePayload(
    data: unknown
  ): { b?: [string, string][]; a?: [string, string][]; bids?: [string, string][]; asks?: [string, string][]; u?: number; lastUpdateId?: number } | null {
    try {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf-8") : null;
      if (!text) return null;
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed as {
        b?: [string, string][];
        a?: [string, string][];
        bids?: [string, string][];
        asks?: [string, string][];
        u?: number;
        lastUpdateId?: number;
      };
    } catch {
      return null;
    }
  }
}
