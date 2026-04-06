import type { GridConfig, GridDirection } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type { AccountSnapshot, Depth, Order, Ticker } from "../exchanges/types";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";
import { decimalsOf } from "../utils/math";
import { extractMessage } from "../utils/errors";
import { getMidOrLast } from "../utils/price";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import {
  placeMarketOrder,
  placeOrder,
  unlockOperating,
  type OrderLockMap,
  type OrderPendingMap,
  type OrderTimerMap,
} from "../core/order-coordinator";
import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import {
  loadGridState,
  saveGridState,
  clearGridState,
  type StoredGridState,
  type StoredLevelInfo,
  type LevelState,
} from "./common/grid-storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DesiredGridOrder {
  level: number;
  side: "BUY" | "SELL";
  price: string;
  amount: number;
  intent: "ENTRY" | "EXIT";
  reduceOnly?: boolean;
}

interface LevelMeta {
  index: number;
  price: number;
  side: "BUY" | "SELL";
  closeTarget: number | null;
  closeSources: number[];
}

interface GridLineSnapshot {
  level: number;
  price: number;
  side: "BUY" | "SELL";
  active: boolean;
  hasOrder: boolean;
  state: LevelState;
}

export interface GridEngineSnapshot {
  ready: boolean;
  symbol: string;
  lowerPrice: number;
  upperPrice: number;
  lastPrice: number | null;
  midPrice: number | null;
  gridLines: GridLineSnapshot[];
  desiredOrders: DesiredGridOrder[];
  openOrders: Order[];
  position: PositionSnapshot;
  running: boolean;
  stopReason: string | null;
  direction: GridDirection;
  tradeLog: TradeLogEntry[];
  feedStatus: {
    account: boolean;
    orders: boolean;
    depth: boolean;
    ticker: boolean;
  };
  lastUpdated: number | null;
}

type GridEvent = "update";
type GridListener = (snapshot: GridEngineSnapshot) => void;

interface EngineOptions {
  now?: () => number;
  /** Skip disk persistence (for tests) */
  skipPersistence?: boolean;
}

// ---------------------------------------------------------------------------
// clientOrderId encoding/decoding
// ---------------------------------------------------------------------------

const CID_PREFIX = "grid";

/** ENTRY: grid-E-{level}-{tsHex}  EXIT: grid-X-{sourceLevel}-{targetLevel}-{tsHex} */
function makeClientOrderId(intent: "ENTRY" | "EXIT", level: number, targetOrSource?: number): string {
  const hex = Date.now().toString(16);
  if (intent === "ENTRY") return `${CID_PREFIX}-E-${level}-${hex}`;
  return `${CID_PREFIX}-X-${targetOrSource ?? 0}-${level}-${hex}`;
}

interface ParsedClientOrderId {
  intent: "ENTRY" | "EXIT";
  level: number;
  sourceLevel?: number;
}

function parseClientOrderId(cid: string): ParsedClientOrderId | null {
  if (!cid || !cid.startsWith(`${CID_PREFIX}-`)) return null;
  const parts = cid.split("-");
  // grid-E-{level}-{hex}
  if (parts[1] === "E" && parts.length >= 3) {
    const level = Number(parts[2]);
    if (!Number.isFinite(level)) return null;
    return { intent: "ENTRY", level };
  }
  // grid-X-{sourceLevel}-{targetLevel}-{hex}
  if (parts[1] === "X" && parts.length >= 4) {
    const sourceLevel = Number(parts[2]);
    const targetLevel = Number(parts[3]);
    if (!Number.isFinite(sourceLevel) || !Number.isFinite(targetLevel)) return null;
    return { intent: "EXIT", level: targetLevel, sourceLevel };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EPSILON = 1e-8;

// ---------------------------------------------------------------------------
// GridEngine
// ---------------------------------------------------------------------------

export class GridEngine {
  private readonly tradeLog: ReturnType<typeof createTradeLog>;
  private readonly events = new StrategyEventEmitter<GridEvent, GridEngineSnapshot>();
  private readonly locks: OrderLockMap = {};
  private readonly timers: OrderTimerMap = {};
  private readonly pendings: OrderPendingMap = {};
  private priceDecimals: number;
  private readonly now: () => number;
  private readonly configValid: boolean;
  private readonly gridLevels: number[];
  private readonly levelMeta: LevelMeta[] = [];
  private readonly buyLevelIndices: number[] = [];
  private readonly sellLevelIndices: number[] = [];
  private readonly skipPersistence: boolean;

  // --- Per-level state tracking ---
  // Each grid level can be: idle → filled → exit_placed → idle (cycle)
  // A level in "filled" or "exit_placed" state CANNOT accept a new ENTRY order.
  private readonly levelStates = new Map<number, LevelState>();
  // Maps source level → target level for EXIT orders
  private readonly exitTargetBySource = new Map<number, number>();
  // Maps order id → parsed intent for tracking active orders
  private readonly orderIntentById = new Map<string, { side: "BUY" | "SELL"; price: string; level: number; intent: "ENTRY" | "EXIT"; sourceLevel?: number }>();

  // Deferred disappearance classification
  private readonly awaitingByLevel = new Map<number, { accountVerAtStart: number; absAtStart: number; ts: number }>();

  // Order key suppression to bridge WS latency
  private readonly pendingKeyUntil = new Map<string, number>();
  static readonly PENDING_TTL_MS = 10_000;

  private prevActiveIds = new Set<string>();
  private sidesLocked = false;
  private recoveryDone = false;
  private recoveryPromise: Promise<void> | null = null;
  private lastAbsPositionAmt = 0;
  private immediateCloseToPlace: Array<{ sourceLevel: number; targetLevel: number; side: "BUY" | "SELL"; price: string }> = [];

  // Legacy compatibility maps kept for tests calling computeDesiredOrders/syncGrid
  private readonly longExposure = new Map<number, number>();
  private readonly shortExposure = new Map<number, number>();

  private accountSnapshot: AccountSnapshot | null = null;
  private depthSnapshot: Depth | null = null;
  private tickerSnapshot: Ticker | null = null;
  private openOrders: Order[] = [];

  private position: PositionSnapshot = { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0, markPrice: null };
  private desiredOrders: DesiredGridOrder[] = [];

  private readonly feedArrived = {
    account: false,
    orders: false,
    depth: false,
    ticker: false,
  };

  private readonly feedStatus = {
    account: false,
    orders: false,
    depth: false,
    ticker: false,
  };

  private readonly log: LogHandler;
  private precisionSync: Promise<void> | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private running: boolean;
  private stopReason: string | null = null;
  private lastUpdated: number | null = null;
  private accountVersion = 0;
  private ordersVersion = 0;
  private lastPlacementOrdersVersion = -1;
  private lastLimitAttemptAt = 0;
  static readonly LIMIT_COOLDOWN_MS = 3000;
  private savePending = false;

  constructor(private readonly config: GridConfig, private readonly exchange: ExchangeAdapter, options: EngineOptions = {}) {
    this.tradeLog = createTradeLog(this.config.maxLogEntries);
    this.log = (type, detail) => this.tradeLog.push(type, detail);
    this.priceDecimals = decimalsOf(this.config.priceTick);
    this.now = options.now ?? Date.now;
    this.skipPersistence = options.skipPersistence ?? false;
    this.configValid = this.validateConfig();
    this.gridLevels = this.computeGridLevels();
    this.buildLevelMeta();
    this.syncPrecision();
    this.running = this.configValid;
    if (!this.configValid) {
      this.stopReason = "配置无效，已暂停网格";
      this.log("error", this.stopReason);
    }
    if (this.gridLevels.length === 0) {
      this.running = false;
      this.stopReason = `网格价位计算失败，模式不支持或参数无效: ${String(this.config.gridMode)}`;
      this.log("error", this.stopReason);
      this.emitUpdate();
    }
    // Initialize all levels to idle
    for (let i = 0; i < this.gridLevels.length; i++) {
      this.levelStates.set(i, "idle");
    }
    this.bootstrap();
  }

  start(): void {
    if (this.timer || !this.running) {
      if (!this.timer && !this.running) {
        this.emitUpdate();
      }
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.refreshIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  on(event: GridEvent, listener: GridListener): void {
    this.events.on(event, listener);
  }

  off(event: GridEvent, listener: GridListener): void {
    this.events.off(event, listener);
  }

  getSnapshot(): GridEngineSnapshot {
    return this.buildSnapshot();
  }

  // -----------------------------------------------------------------------
  // Precision sync
  // -----------------------------------------------------------------------

  private syncPrecision(): void {
    if (this.precisionSync) return;
    const getPrecision = this.exchange.getPrecision?.bind(this.exchange);
    if (!getPrecision) return;
    this.precisionSync = getPrecision()
      .then((precision) => {
        if (!precision) return;
        let updated = false;
        if (Number.isFinite(precision.priceTick) && precision.priceTick > 0) {
          if (Math.abs(precision.priceTick - this.config.priceTick) > 1e-12) {
            this.config.priceTick = precision.priceTick;
            this.priceDecimals = decimalsOf(precision.priceTick);
            updated = true;
          }
        }
        if (Number.isFinite(precision.qtyStep) && precision.qtyStep > 0) {
          if (Math.abs(precision.qtyStep - this.config.qtyStep) > 1e-12) {
            this.config.qtyStep = precision.qtyStep;
            updated = true;
          }
        }
        if (updated) {
          this.log("info", `已同步交易精度: priceTick=${precision.priceTick} qtyStep=${precision.qtyStep}`);
          this.rebuildGridAfterPrecisionUpdate();
        }
      })
      .catch((error) => {
        this.log("error", `同步精度失败: ${extractMessage(error)}`);
        this.precisionSync = null;
        setTimeout(() => this.syncPrecision(), 2000);
      });
  }

  private rebuildGridAfterPrecisionUpdate(): void {
    if (!this.configValid) return;
    const reference = this.getReferencePrice();
    const newLevels = this.computeGridLevels();
    this.gridLevels.length = 0;
    this.gridLevels.push(...newLevels);
    this.buildLevelMeta(reference);
    // Re-initialize level states
    for (let i = 0; i < this.gridLevels.length; i++) {
      if (!this.levelStates.has(i)) {
        this.levelStates.set(i, "idle");
      }
    }
    this.emitUpdate();
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  private validateConfig(): boolean {
    if (this.config.lowerPrice <= 0 || this.config.upperPrice <= 0) return false;
    if (this.config.upperPrice <= this.config.lowerPrice) return false;
    if (!Number.isFinite(this.config.gridLevels) || this.config.gridLevels < 2) return false;
    if (!Number.isFinite(this.config.orderSize) || this.config.orderSize <= 0) return false;
    if (!Number.isFinite(this.config.maxPositionSize) || this.config.maxPositionSize <= 0) return false;
    if (!Number.isFinite(this.config.refreshIntervalMs) || this.config.refreshIntervalMs < 1) return false;
    return true;
  }

  // -----------------------------------------------------------------------
  // Bootstrap / Feed subscriptions
  // -----------------------------------------------------------------------

  private bootstrap(): void {
    const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);

    safeSubscribe<AccountSnapshot>(
      this.exchange.watchAccount.bind(this.exchange),
      (snapshot) => {
        this.accountSnapshot = snapshot;
        this.position = getPosition(snapshot, this.config.symbol);
        this.syncLegacyExposureFromPosition();
        this.accountVersion += 1;
        this.lastAbsPositionAmt = Math.abs(this.position.positionAmt);
        if (!this.feedArrived.account) {
          this.feedArrived.account = true;
          log("info", "账户快照已同步");
        }
        this.feedStatus.account = true;
        this.tryLockSidesOnce();
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅账户失败: ${extractMessage(error)}`,
        processFail: (error) => `账户推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<Order[]>(
      this.exchange.watchOrders.bind(this.exchange),
      (orders) => {
        this.openOrders = Array.isArray(orders)
          ? orders.filter((order) => order.symbol === this.config.symbol)
          : [];
        this.synchronizeLocks(orders);
        this.ordersVersion += 1;
        if (!this.feedArrived.orders) {
          this.feedArrived.orders = true;
          log("info", "订单快照已同步");
          // Trigger recovery from existing orders + persisted state
          this.recoveryPromise = this.recoverState();
        }
        this.feedStatus.orders = true;
        this.tryLockSidesOnce();
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅订单失败: ${extractMessage(error)}`,
        processFail: (error) => `订单推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<Depth>(
      this.exchange.watchDepth.bind(this.exchange, this.config.symbol),
      (depth) => {
        this.depthSnapshot = depth;
        if (!this.feedArrived.depth) {
          this.feedArrived.depth = true;
          log("info", "盘口深度已同步");
        }
        this.feedStatus.depth = true;
        this.tryLockSidesOnce();
      },
      log,
      {
        subscribeFail: (error) => `订阅深度失败: ${extractMessage(error)}`,
        processFail: (error) => `深度推送处理异常: ${extractMessage(error)}`,
      }
    );

    safeSubscribe<Ticker>(
      this.exchange.watchTicker.bind(this.exchange, this.config.symbol),
      (ticker) => {
        this.tickerSnapshot = ticker;
        if (!this.feedArrived.ticker) {
          this.feedArrived.ticker = true;
          log("info", "行情推送已同步");
        }
        this.feedStatus.ticker = true;
        this.tryLockSidesOnce();
        this.emitUpdate();
      },
      log,
      {
        subscribeFail: (error) => `订阅行情失败: ${extractMessage(error)}`,
        processFail: (error) => `行情推送处理异常: ${extractMessage(error)}`,
      }
    );
  }

  private synchronizeLocks(orders: Order[] | null | undefined): void {
    const list = Array.isArray(orders) ? orders : [];
    const FINAL = new Set(["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"]);
    Object.keys(this.pendings).forEach((type) => {
      const pendingId = this.pendings[type];
      if (!pendingId) return;
      const match = list.find((order) => String(order.orderId) === pendingId);
      if (!match) {
        unlockOperating(this.locks, this.timers, this.pendings, type);
        return;
      }
      const status = String(match.status || "").toUpperCase();
      if (FINAL.has(status)) {
        unlockOperating(this.locks, this.timers, this.pendings, type);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Recovery: reconstruct level states from open orders + disk + position
  // -----------------------------------------------------------------------

  private async recoverState(): Promise<void> {
    if (this.recoveryDone) return;
    this.recoveryDone = true;

    // 1) Load persisted state from disk
    let persisted: StoredGridState | null = null;
    if (!this.skipPersistence) {
      try {
        persisted = await loadGridState(this.config.symbol);
      } catch (err) {
        this.log("error", `加载网格状态失败: ${extractMessage(err)}`);
      }
    }

    // 2) Check if persisted state matches current config
    const configMatch = persisted &&
      persisted.lowerPrice === this.config.lowerPrice &&
      persisted.upperPrice === this.config.upperPrice &&
      persisted.gridLevels === this.config.gridLevels;

    // 3) Restore level states from persisted data if config matches
    if (configMatch && persisted) {
      let restored = 0;
      for (const [key, info] of Object.entries(persisted.levels)) {
        const idx = Number(key);
        if (!Number.isFinite(idx) || idx < 0 || idx >= this.gridLevels.length) continue;
        if (info.state === "filled" || info.state === "exit_placed") {
          this.levelStates.set(idx, info.state);
          if (info.targetLevel != null) {
            this.exitTargetBySource.set(idx, info.targetLevel);
          }
          restored++;
        }
      }
      if (restored > 0) {
        this.log("info", `从磁盘恢复了 ${restored} 条网格等级状态`);
      }
    }

    // 4) Parse open orders' clientOrderId to reconstruct intent tracking
    const activeOrders = this.openOrders.filter(o => this.isActiveLimitOrder(o));
    let recognized = 0;
    for (const o of activeOrders) {
      const cid = o.clientOrderId;
      const parsed = parseClientOrderId(cid);
      if (!parsed) continue;
      if (parsed.level < 0 || parsed.level >= this.gridLevels.length) continue;

      const id = String(o.orderId);
      if (parsed.intent === "ENTRY") {
        this.orderIntentById.set(id, {
          side: o.side,
          price: this.normalizePrice(o.price),
          level: parsed.level,
          intent: "ENTRY",
        });
      } else {
        const src = parsed.sourceLevel ?? 0;
        this.orderIntentById.set(id, {
          side: o.side,
          price: this.normalizePrice(o.price),
          level: parsed.level,
          intent: "EXIT",
          sourceLevel: src,
        });
        // Source level should be at least "filled" since an EXIT exists for it
        if (this.levelStates.get(src) === "idle") {
          this.levelStates.set(src, "exit_placed");
        }
        this.exitTargetBySource.set(src, parsed.level);
      }
      recognized++;
    }

    // 5) If we have a net position but no level is in filled/exit_placed state,
    //    infer from position which levels should be marked filled
    const absPos = Math.abs(this.position.positionAmt);
    if (absPos > EPSILON) {
      const filledOrExiting = this.countNonIdleLevels();
      if (filledOrExiting === 0) {
        this.inferLevelStatesFromPosition();
      }
    }

    // 6) Cancel stale ENTRY orders that don't match any idle level
    //    (leftover from a crashed prior run with different grid params)
    const staleOrderIds: Array<number | string> = [];
    for (const o of activeOrders) {
      const cid = o.clientOrderId;
      const parsed = parseClientOrderId(cid);
      if (!parsed) {
        // Unknown order — not placed by this grid engine. Cancel it.
        staleOrderIds.push(o.orderId);
        continue;
      }
      if (parsed.intent === "ENTRY") {
        const state = this.levelStates.get(parsed.level);
        if (state !== "idle") {
          // This level is already filled or has an exit; stale ENTRY
          staleOrderIds.push(o.orderId);
        }
      }
    }

    if (staleOrderIds.length > 0) {
      try {
        await this.exchange.cancelOrders({ symbol: this.config.symbol, orderIdList: staleOrderIds });
        this.log("order", `恢复阶段：撤销 ${staleOrderIds.length} 个过时挂单`);
      } catch (err) {
        this.log("error", `恢复阶段撤单失败: ${extractMessage(err)}`);
      }
    }

    // Initialize prevActiveIds from current orders to avoid false disappearances on first tick
    this.prevActiveIds = new Set(
      this.openOrders.filter(o => this.isActiveLimitOrder(o)).map(o => String(o.orderId))
    );

    if (recognized > 0 || (configMatch && persisted)) {
      this.log("info", `恢复完成: 识别 ${recognized} 个订单, 非空闲等级 ${this.countNonIdleLevels()} 个`);
    } else {
      this.log("info", "无历史状态可恢复，从零开始部网");
    }

    this.emitUpdate();
  }

  private countNonIdleLevels(): number {
    let count = 0;
    for (const [, state] of this.levelStates) {
      if (state !== "idle") count++;
    }
    return count;
  }

  /** When no persisted state but position exists, infer which levels should be "filled" */
  private inferLevelStatesFromPosition(): void {
    const qty = this.position.positionAmt;
    if (Math.abs(qty) <= EPSILON) return;
    const entry = this.position.entryPrice;

    if (qty > 0) {
      // Long position — mark nearest BUY levels as filled
      let remaining = Math.abs(qty);
      const candidates = this.buyLevelIndices.slice().reverse();
      for (const level of candidates) {
        if (remaining <= EPSILON) break;
        this.levelStates.set(level, "filled");
        const target = this.levelMeta[level]?.closeTarget;
        if (target != null) {
          this.exitTargetBySource.set(level, target);
        }
        remaining -= this.config.orderSize;
      }
      this.log("info", `根据多头仓位推断 ${Math.abs(qty)} 个网格等级为已成交`);
    } else {
      let remaining = Math.abs(qty);
      const candidates = this.sellLevelIndices.slice();
      for (const level of candidates) {
        if (remaining <= EPSILON) break;
        this.levelStates.set(level, "filled");
        const target = this.levelMeta[level]?.closeTarget;
        if (target != null) {
          this.exitTargetBySource.set(level, target);
        }
        remaining -= this.config.orderSize;
      }
      this.log("info", `根据空头仓位推断 ${Math.abs(qty)} 个网格等级为已成交`);
    }
  }

  // -----------------------------------------------------------------------
  // Tick loop
  // -----------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      this.tryLockSidesOnce();
      if (!this.running) {
        await this.tryRestart();
        return;
      }
      if (!this.isReady()) return;
      // Wait for recovery before grid operations
      if (!this.recoveryDone) {
        if (this.recoveryPromise) {
          try { await this.recoveryPromise; } catch {}
        }
        if (!this.recoveryDone) return;
      }
      const price = this.getReferencePrice();
      if (!Number.isFinite(price) || price === null) return;
      if (this.shouldStop(price)) {
        await this.haltGrid(price);
        return;
      }
      await this.syncGridSimple(price);
    } catch (error) {
      this.log("error", `网格轮询异常: ${extractMessage(error)}`);
    } finally {
      this.processing = false;
      this.emitUpdate();
    }
  }

  private isReady(): boolean {
    return this.feedStatus.account && this.feedStatus.orders && this.feedStatus.ticker;
  }

  private getReferencePrice(): number | null {
    return getMidOrLast(this.depthSnapshot, this.tickerSnapshot);
  }

  private tryLockSidesOnce(): void {
    if (this.sidesLocked) return;
    if (!this.feedStatus.ticker && !this.feedStatus.depth) return;
    const anchor = this.chooseAnchoringPrice();
    if (!Number.isFinite(anchor) || anchor == null) return;
    const price = this.clampReferencePrice(Number(anchor));
    this.buildLevelMeta(price);
    this.sidesLocked = true;
    this.log("info", "已根据锚定价一次性划分买卖档位");
  }

  private clampReferencePrice(price: number): number {
    if (!this.gridLevels.length) return price;
    const minLevel = this.gridLevels[0]!;
    const maxLevel = this.gridLevels[this.gridLevels.length - 1]!;
    return Math.min(Math.max(price, minLevel), maxLevel);
  }

  // -----------------------------------------------------------------------
  // Stop / Halt / Restart
  // -----------------------------------------------------------------------

  private shouldStop(price: number): boolean {
    if (this.config.stopLossPct <= 0) return false;
    const lowerTrigger = this.config.lowerPrice * (1 - this.config.stopLossPct);
    const upperTrigger = this.config.upperPrice * (1 + this.config.stopLossPct);
    if (price <= lowerTrigger) {
      this.stopReason = `价格跌破网格下边界 ${((1 - price / this.config.lowerPrice) * 100).toFixed(2)}%`;
      return true;
    }
    if (price >= upperTrigger) {
      this.stopReason = `价格突破网格上边界 ${((price / this.config.upperPrice - 1) * 100).toFixed(2)}%`;
      return true;
    }
    return false;
  }

  private async haltGrid(_price: number): Promise<void> {
    if (!this.running) return;
    const reason = this.stopReason ?? "触发网格止损";
    this.log("warn", `${reason}，开始执行平仓与撤单`);
    try {
      await this.exchange.cancelAllOrders({ symbol: this.config.symbol });
      this.log("order", "已撤销全部网格挂单");
    } catch (error) {
      this.log("error", `撤销网格挂单失败: ${extractMessage(error)}`);
    }
    await this.closePosition();
    this.desiredOrders = [];
    this.lastUpdated = this.now();
    this.running = false;
    // Reset all level states
    for (const [k] of this.levelStates) {
      this.levelStates.set(k, "idle");
    }
    this.exitTargetBySource.clear();
    this.awaitingByLevel.clear();
    this.orderIntentById.clear();
    this.immediateCloseToPlace = [];
    // Clear persisted state
    if (!this.skipPersistence) {
      try { await clearGridState(this.config.symbol); } catch {}
    }
    if (!this.config.autoRestart) {
      this.stop();
    }
  }

  private async closePosition(): Promise<void> {
    const qty = this.position.positionAmt;
    if (!Number.isFinite(qty) || Math.abs(qty) < EPSILON) return;
    const side = qty > 0 ? "SELL" : "BUY";
    const amount = Math.abs(qty);
    try {
      await placeMarketOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pendings,
        side,
        amount,
        this.log,
        false,
        undefined,
        { qtyStep: this.config.qtyStep }
      );
      this.log("order", `市价平仓 ${side} ${amount}`);
    } catch (error) {
      this.log("error", `平仓失败: ${extractMessage(error)}`);
    } finally {
      unlockOperating(this.locks, this.timers, this.pendings, "MARKET");
    }
  }

  private async tryRestart(): Promise<void> {
    if (!this.config.autoRestart || !this.configValid) return;
    if (!this.isReady()) return;
    if (this.config.restartTriggerPct <= 0) return;
    const price = this.getReferencePrice();
    if (!Number.isFinite(price) || price === null) return;
    const lowerGuard = this.config.lowerPrice * (1 + this.config.restartTriggerPct);
    const upperGuard = this.config.upperPrice * (1 - this.config.restartTriggerPct);
    if (price < lowerGuard || price > upperGuard) return;
    this.log("info", "价格重新回到网格区间，恢复网格运行");
    this.running = true;
    this.stopReason = null;
    this.sidesLocked = false;
    this.tryLockSidesOnce();
    this.start();
  }

  // -----------------------------------------------------------------------
  // Core grid sync logic
  // -----------------------------------------------------------------------

  private async syncGridSimple(price: number): Promise<void> {
    // Wait for recovery to complete
    if (!this.recoveryDone) {
      this.log("info", "恢复未完成，等待后再部网");
      this.lastUpdated = this.now();
      return;
    }

    // --- 0) Exit-first: if position exists, ensure at least one EXIT order ---
    const hasNetLong = this.position.positionAmt > EPSILON;
    const hasNetShort = this.position.positionAmt < -EPSILON;

    if (hasNetLong || hasNetShort) {
      const needExitSide: "BUY" | "SELL" = hasNetLong ? "SELL" : "BUY";
      if (!this.hasActiveExit(needExitSide)) {
        await this.ensureExitForPosition();
        this.lastUpdated = this.now();
        this.prevActiveIds = new Set(this.openOrders.filter(o => this.isActiveLimitOrder(o)).map(o => String(o.orderId)));
        return;
      }
    }

    // --- 1) Classify disappeared orders ---
    const activeOrders = this.openOrders.filter(o => this.isActiveLimitOrder(o));
    const allOrdersById = new Map<string, Order>();
    for (const o of this.openOrders) {
      if (o.symbol !== this.config.symbol) continue;
      allOrdersById.set(String(o.orderId), o);
    }

    const activeKeyCounts = new Map<string, number>();
    const currIds = new Set<string>();
    for (const o of activeOrders) {
      const id = String(o.orderId);
      currIds.add(id);
      const meta = this.orderIntentById.get(id);
      const priceStr = this.normalizePrice(o.price);
      if (meta) {
        const k = this.getOrderKey(o.side, priceStr, meta.intent);
        activeKeyCounts.set(k, (activeKeyCounts.get(k) ?? 0) + 1);
      } else {
        // Unknown order (not placed by this engine) — count conservatively
        const kEntry = this.getOrderKey(o.side, priceStr, "ENTRY");
        const kExit = this.getOrderKey(o.side, priceStr, "EXIT");
        activeKeyCounts.set(kEntry, (activeKeyCounts.get(kEntry) ?? 0) + 1);
        activeKeyCounts.set(kExit, (activeKeyCounts.get(kExit) ?? 0) + 1);
      }
    }

    // Clear suppression for keys that are now visible
    for (const [k, cnt] of activeKeyCounts.entries()) {
      if ((cnt ?? 0) > 0) this.pendingKeyUntil.delete(k);
    }

    // Detect disappeared orders
    const disappeared: string[] = [];
    for (const id of this.prevActiveIds) {
      if (!currIds.has(id)) disappeared.push(id);
    }

    let stateChanged = false;

    for (const id of disappeared) {
      const meta = this.orderIntentById.get(id);
      if (!meta) continue;

      let classified: "filled" | "canceled" | "unknown" = "unknown";
      const rec = allOrdersById.get(id);
      if (rec) {
        const status = String(rec.status || "").toUpperCase();
        const executed = Number(rec.executedQty || 0);
        if (status === "FILLED" || executed > EPSILON) {
          classified = "filled";
        } else if (["CANCELED", "CANCELLED", "EXPIRED", "REJECTED"].includes(status)) {
          classified = "canceled";
        }
      }

      if (classified === "unknown") {
        const level = meta.intent === "EXIT"
          ? (meta.sourceLevel ?? meta.level)
          : meta.level;
        this.awaitingByLevel.set(level, {
          accountVerAtStart: this.accountVersion,
          absAtStart: this.lastAbsPositionAmt,
          ts: this.now(),
        });
        this.orderIntentById.delete(id);
        continue;
      }

      if (classified === "filled") {
        stateChanged = true;
        if (meta.intent === "ENTRY") {
          // ENTRY filled → mark level as "filled", queue EXIT
          this.levelStates.set(meta.level, "filled");
          const target = this.levelMeta[meta.level]?.closeTarget;
          if (target != null) {
            this.exitTargetBySource.set(meta.level, target);
            const exitSide: "BUY" | "SELL" = meta.side === "BUY" ? "SELL" : "BUY";
            const priceStr = this.formatPrice(this.gridLevels[target]!);
            const exitKey = this.getOrderKey(exitSide, priceStr, "EXIT");
            const count = activeKeyCounts.get(exitKey) ?? 0;
            if (count < 1) {
              this.immediateCloseToPlace.push({
                sourceLevel: meta.level,
                targetLevel: target,
                side: exitSide,
                price: priceStr,
              });
            }
          }
          this.log("order", `ENTRY 成交: ${meta.side} @ ${meta.price} (等级 ${meta.level})`);
        } else {
          // EXIT filled → release source level back to idle
          const src = meta.sourceLevel ?? meta.level;
          this.levelStates.set(src, "idle");
          this.exitTargetBySource.delete(src);
          this.log("order", `EXIT 成交: ${meta.side} @ ${meta.price} (释放等级 ${src})`);
        }
        const filledKey = this.getOrderKey(meta.side, meta.price, meta.intent);
        this.pendingKeyUntil.delete(filledKey);
      } else if (classified === "canceled") {
        stateChanged = true;
        if (meta.intent === "EXIT") {
          // EXIT canceled → revert source back to "filled" so a new EXIT can be placed
          const src = meta.sourceLevel ?? meta.level;
          this.levelStates.set(src, "filled");
          this.exitTargetBySource.delete(src);
        }
        // ENTRY canceled → level stays idle (no change needed)
        const canceledKey = this.getOrderKey(meta.side, meta.price, meta.intent);
        this.pendingKeyUntil.delete(canceledKey);
      }
      this.orderIntentById.delete(id);
    }

    this.prevActiveIds = currIds;

    // --- 2) Resolve deferred unknown classifications ---
    if (this.awaitingByLevel.size) {
      for (const [level, info] of Array.from(this.awaitingByLevel.entries())) {
        if (this.now() - info.ts > 8000) {
          this.awaitingByLevel.delete(level);
          continue;
        }
        if (this.accountVersion <= info.accountVerAtStart) continue;
        const absNow = Math.abs(this.position.positionAmt);
        if (absNow > info.absAtStart + EPSILON) {
          // ENTRY filled
          this.levelStates.set(level, "filled");
          const target = this.levelMeta[level]?.closeTarget;
          if (target != null) this.exitTargetBySource.set(level, target);
          stateChanged = true;
          this.awaitingByLevel.delete(level);
          continue;
        }
        if (absNow + EPSILON < info.absAtStart) {
          // EXIT filled
          this.levelStates.set(level, "idle");
          this.exitTargetBySource.delete(level);
          stateChanged = true;
          this.awaitingByLevel.delete(level);
          continue;
        }
        // No change after new account snapshot → treat as canceled
        this.awaitingByLevel.delete(level);
      }
    }

    // --- 3) Build desired orders ---
    const desired: DesiredGridOrder[] = [];
    const desiredKeySet = new Set<string>();
    const plannedKeyCounts = new Map<string, number>(activeKeyCounts);
    const halfTick = this.config.priceTick / 2;

    // 3a) Immediate close (EXIT) orders from fresh fills
    if (this.immediateCloseToPlace.length) {
      for (const item of this.immediateCloseToPlace) {
        const key = this.getOrderKey(item.side, item.price, "EXIT");
        const until = this.pendingKeyUntil.get(key);
        if (until && until > this.now()) continue;
        const count = plannedKeyCounts.get(key) ?? 0;
        if (count < 1 && !desiredKeySet.has(key)) {
          desired.push({
            level: item.targetLevel,
            side: item.side,
            price: item.price,
            amount: this.config.orderSize,
            intent: "EXIT",
          });
          desiredKeySet.add(key);
          plannedKeyCounts.set(key, count + 1);
        }
      }
      this.immediateCloseToPlace = [];
    }

    // 3b) EXIT orders for all filled/exit_placed levels that don't already have an active EXIT
    for (const [level, state] of this.levelStates) {
      if (state !== "filled" && state !== "exit_placed") continue;
      const target = this.exitTargetBySource.get(level);
      if (target == null) continue;
      const meta = this.levelMeta[level];
      if (!meta) continue;
      const exitSide: "BUY" | "SELL" = meta.side === "BUY" ? "SELL" : "BUY";
      const priceStr = this.formatPrice(this.gridLevels[target]!);
      const closeKey = this.getOrderKey(exitSide, priceStr, "EXIT");
      const until = this.pendingKeyUntil.get(closeKey);
      if (until && until > this.now()) continue;
      if ((plannedKeyCounts.get(closeKey) ?? 0) < 1 && !desiredKeySet.has(closeKey)) {
        desired.push({
          level: target,
          side: exitSide,
          price: priceStr,
          amount: this.config.orderSize,
          intent: "EXIT",
        });
        desiredKeySet.add(closeKey);
        plannedKeyCounts.set(closeKey, (plannedKeyCounts.get(closeKey) ?? 0) + 1);
      }
    }

    // 3c) ENTRY BUY orders below price
    for (const level of this.buyLevelIndices) {
      // During exit-first phase, skip ENTRY
      if (hasNetLong || hasNetShort) continue;
      const levelState = this.levelStates.get(level) ?? "idle";
      if (levelState !== "idle") continue; // Level already filled — no re-entry until EXIT fills
      const levelPrice = this.gridLevels[level]!;
      if (levelPrice >= price - halfTick) continue;
      if (this.awaitingByLevel.has(level)) continue;
      const priceStr = this.formatPrice(levelPrice);
      const key = this.getOrderKey("BUY", priceStr, "ENTRY");
      // Check for intent conflict with EXIT at same price
      const exitKeySame = this.getOrderKey("BUY", priceStr, "EXIT");
      if ((plannedKeyCounts.get(exitKeySame) ?? 0) >= 1 || desiredKeySet.has(exitKeySame)) continue;
      const until = this.pendingKeyUntil.get(key);
      if (until && until > this.now()) continue;
      if ((plannedKeyCounts.get(key) ?? 0) >= 1) continue;
      if (!desiredKeySet.has(key)) {
        desired.push({ level, side: "BUY", price: priceStr, amount: this.config.orderSize, intent: "ENTRY" });
        desiredKeySet.add(key);
        plannedKeyCounts.set(key, (plannedKeyCounts.get(key) ?? 0) + 1);
      }
    }

    // 3d) ENTRY SELL orders above price
    for (const level of this.sellLevelIndices) {
      if (hasNetLong || hasNetShort) continue;
      const levelState = this.levelStates.get(level) ?? "idle";
      if (levelState !== "idle") continue;
      const levelPrice = this.gridLevels[level]!;
      if (levelPrice <= price + halfTick) continue;
      if (this.awaitingByLevel.has(level)) continue;
      const priceStr = this.formatPrice(levelPrice);
      const key = this.getOrderKey("SELL", priceStr, "ENTRY");
      const exitKeySame = this.getOrderKey("SELL", priceStr, "EXIT");
      if ((plannedKeyCounts.get(exitKeySame) ?? 0) >= 1 || desiredKeySet.has(exitKeySame)) continue;
      const until = this.pendingKeyUntil.get(key);
      if (until && until > this.now()) continue;
      if ((plannedKeyCounts.get(key) ?? 0) >= 1) continue;
      if (!desiredKeySet.has(key)) {
        desired.push({ level, side: "SELL", price: priceStr, amount: this.config.orderSize, intent: "ENTRY" });
        desiredKeySet.add(key);
        plannedKeyCounts.set(key, (plannedKeyCounts.get(key) ?? 0) + 1);
      }
    }

    // --- 4) Place desired orders (rate-limited) ---
    this.desiredOrders = desired;
    let newOrdersPlaced = 0;
    const MAX_NEW_ORDERS_PER_TICK = 1;

    for (const d of desired) {
      if (newOrdersPlaced >= MAX_NEW_ORDERS_PER_TICK) break;
      if (this.pendings["LIMIT"]) break;

      const nowTs = this.now();
      const needSnapshotUpdated = this.lastPlacementOrdersVersion === this.ordersVersion;
      const inCooldown = nowTs - this.lastLimitAttemptAt < GridEngine.LIMIT_COOLDOWN_MS;
      if (needSnapshotUpdated && inCooldown) break;

      const intent = d.intent;

      // Cap quantities
      if (intent === "EXIT") {
        const capped = this.capExitQty(d.amount, d.side);
        if (capped <= EPSILON) continue;
        d.amount = capped;
      } else {
        const capped = this.capEntryQty(d.amount, d.side);
        if (capped <= EPSILON) continue;
        d.amount = capped;
      }

      const key = this.getOrderKey(d.side, d.price, intent);
      // Dedupe: skip if any active LIMIT exists with same side+price
      const hasSameSidePrice = this.openOrders.some(
        o => this.isActiveLimitOrder(o) && o.side === d.side && this.normalizePrice(o.price) === d.price
      );
      if (hasSameSidePrice || (activeKeyCounts.get(key) ?? 0) >= 1) continue;

      try {
        this.lastLimitAttemptAt = nowTs;

        // Generate clientOrderId for recovery
        const clientOrderId = intent === "ENTRY"
          ? makeClientOrderId("ENTRY", d.level)
          : makeClientOrderId("EXIT", d.level, this.findSourceForExitTarget(d.level, d.side));

        // Do NOT use reduceOnly for EXIT — some exchanges reject it alongside open ENTRY orders
        const placed = await placeOrder(
          this.exchange,
          this.config.symbol,
          this.openOrders,
          this.locks,
          this.timers,
          this.pendings,
          d.side,
          d.price,
          d.amount,
          this.log,
          false, // never reduceOnly
          undefined,
          {
            priceTick: this.config.priceTick,
            qtyStep: this.config.qtyStep,
            skipDedupe: true,
            clientOrderId,
          }
        );

        if (placed) {
          this.lastPlacementOrdersVersion = this.ordersVersion;
          newOrdersPlaced += 1;
          plannedKeyCounts.set(key, (plannedKeyCounts.get(key) ?? 0) + 1);
          activeKeyCounts.set(key, (activeKeyCounts.get(key) ?? 0) + 1);
          this.pendingKeyUntil.set(key, this.now() + GridEngine.PENDING_TTL_MS);

          if (placed.orderId != null) {
            const record: typeof this.orderIntentById extends Map<string, infer V> ? V : never = {
              side: d.side,
              price: d.price,
              level: d.level,
              intent,
            };
            if (intent === "EXIT") {
              record.sourceLevel = this.findSourceForExitTarget(d.level, d.side);
              // Mark source level as exit_placed
              if (record.sourceLevel != null) {
                this.levelStates.set(record.sourceLevel, "exit_placed");
                stateChanged = true;
              }
            }
            this.orderIntentById.set(String(placed.orderId), record);
          }
        }
        if (!this.pendingKeyUntil.has(key)) {
          this.pendingKeyUntil.set(key, this.now() + GridEngine.PENDING_TTL_MS);
        }
      } catch (error) {
        this.log("error", `挂单失败 (${d.side} @ ${d.price}): ${extractMessage(error)}`);
      }
    }

    this.lastUpdated = this.now();
    this.lastAbsPositionAmt = Math.abs(this.position.positionAmt);

    // --- 5) Persist state if changed ---
    if (stateChanged) {
      this.schedulePersist();
    }
  }

  // -----------------------------------------------------------------------
  // Exit-first helper
  // -----------------------------------------------------------------------

  private hasActiveExit(side: "BUY" | "SELL"): boolean {
    for (const o of this.openOrders) {
      if (!this.isActiveLimitOrder(o)) continue;
      if (o.side !== side) continue;
      const meta = this.orderIntentById.get(String(o.orderId));
      if (meta && meta.intent === "EXIT") return true;
      // Also check clientOrderId directly
      const parsed = parseClientOrderId(o.clientOrderId);
      if (parsed && parsed.intent === "EXIT") return true;
    }
    return false;
  }

  private async ensureExitForPosition(): Promise<void> {
    const qty = this.position.positionAmt;
    if (!Number.isFinite(qty) || Math.abs(qty) <= EPSILON) return;
    const entry = this.position.entryPrice;
    if (!Number.isFinite(entry)) return;
    const dir: "long" | "short" = qty > 0 ? "long" : "short";
    const nearest = this.findNearestProfitableCloseLevel(dir, Number(entry));
    if (nearest == null) return;
    const exitSide: "BUY" | "SELL" = qty > 0 ? "SELL" : "BUY";
    const priceStr = this.formatPrice(this.gridLevels[nearest]!);
    const key = this.getOrderKey(exitSide, priceStr, "EXIT");
    const until = this.pendingKeyUntil.get(key);
    if (until && until > this.now()) return;

    // Find or create source level
    const source = this.findSourceForInitialPosition(exitSide);
    const clientOrderId = makeClientOrderId("EXIT", nearest, source);

    try {
      const placed = await placeOrder(
        this.exchange,
        this.config.symbol,
        this.openOrders,
        this.locks,
        this.timers,
        this.pendings,
        exitSide,
        priceStr,
        Math.abs(qty),
        this.log,
        false, // no reduceOnly
        undefined,
        { priceTick: this.config.priceTick, qtyStep: this.config.qtyStep, skipDedupe: true, clientOrderId }
      );
      this.pendingKeyUntil.set(key, this.now() + GridEngine.PENDING_TTL_MS);
      if (placed?.orderId != null) {
        this.levelStates.set(source, "exit_placed");
        this.exitTargetBySource.set(source, nearest);
        this.orderIntentById.set(String(placed.orderId), {
          side: exitSide,
          price: priceStr,
          level: nearest,
          intent: "EXIT",
          sourceLevel: source,
        });
        this.log("order", `兜底：为已有仓位挂平仓单 ${exitSide} @ ${priceStr}`);
        this.schedulePersist();
      }
    } catch (err) {
      this.log("error", `兜底平仓单下单失败: ${extractMessage(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Quantity capping
  // -----------------------------------------------------------------------

  private capExitQty(desiredQty: number, side: "BUY" | "SELL"): number {
    const absPos = Math.abs(this.position.positionAmt);
    if (absPos <= EPSILON) return 0;
    let pendingExitQty = 0;
    for (const o of this.openOrders) {
      if (!this.isActiveLimitOrder(o)) continue;
      if (o.side !== side) continue;
      const meta = this.orderIntentById.get(String(o.orderId));
      if (!meta || meta.intent !== "EXIT") {
        // Also check clientOrderId
        const parsed = parseClientOrderId(o.clientOrderId);
        if (!parsed || parsed.intent !== "EXIT") continue;
      }
      const orig = Number(o.origQty || 0);
      const exec = Number(o.executedQty || 0);
      pendingExitQty += Math.max(orig - exec, 0);
    }
    const remain = Math.max(absPos - pendingExitQty, 0);
    return Math.min(desiredQty, remain);
  }

  private capEntryQty(desiredQty: number, _side: "BUY" | "SELL"): number {
    const absPos = Math.abs(this.position.positionAmt);
    const remain = Math.max(this.config.maxPositionSize - absPos, 0);
    return Math.min(desiredQty, remain);
  }

  // -----------------------------------------------------------------------
  // Level lookup helpers
  // -----------------------------------------------------------------------

  /** Find the source level for a given EXIT target level */
  private findSourceForExitTarget(targetLevel: number, side: "BUY" | "SELL"): number {
    // side is the EXIT order side
    if (side === "SELL") {
      // Closing long: source is a BUY level that maps to targetLevel
      for (const [src, tgt] of this.exitTargetBySource) {
        if (tgt === targetLevel && this.levelMeta[src]?.side === "BUY") return src;
      }
      // Fallback: check levelMeta
      for (const meta of this.levelMeta) {
        if (meta.side === "BUY" && meta.closeTarget === targetLevel) {
          const state = this.levelStates.get(meta.index);
          if (state === "filled" || state === "exit_placed") return meta.index;
        }
      }
    } else {
      for (const [src, tgt] of this.exitTargetBySource) {
        if (tgt === targetLevel && this.levelMeta[src]?.side === "SELL") return src;
      }
      for (const meta of this.levelMeta) {
        if (meta.side === "SELL" && meta.closeTarget === targetLevel) {
          const state = this.levelStates.get(meta.index);
          if (state === "filled" || state === "exit_placed") return meta.index;
        }
      }
    }
    return targetLevel;
  }

  private findNearestProfitableCloseLevel(direction: "long" | "short", entryPrice: number): number | null {
    if (!this.levelMeta.length) return null;
    if (direction === "long") {
      for (const idx of this.sellLevelIndices) {
        if (this.gridLevels[idx]! > entryPrice + this.config.priceTick / 2) return idx;
      }
      return this.sellLevelIndices.length ? this.sellLevelIndices[0]! : null;
    }
    for (const idx of this.buyLevelIndices.slice().reverse()) {
      if (this.gridLevels[idx]! < entryPrice - this.config.priceTick / 2) return idx;
    }
    return this.buyLevelIndices.length ? this.buyLevelIndices[this.buyLevelIndices.length - 1]! : null;
  }

  private findSourceForInitialPosition(closeSide: "BUY" | "SELL"): number {
    const price = this.getReferencePrice();
    if (!Number.isFinite(price)) return 0;
    const p = Number(price);
    if (closeSide === "SELL") {
      let best = 0;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (const idx of this.buyLevelIndices) {
        const lv = this.gridLevels[idx]!;
        const diff = p - lv;
        if (diff >= 0 && diff < bestDiff) {
          bestDiff = diff;
          best = idx;
        }
      }
      return best;
    }
    let best = 0;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const idx of this.sellLevelIndices) {
      const lv = this.gridLevels[idx]!;
      const diff = lv - p;
      if (diff >= 0 && diff < bestDiff) {
        bestDiff = diff;
        best = idx;
      }
    }
    return best;
  }

  // -----------------------------------------------------------------------
  // Grid level computation
  // -----------------------------------------------------------------------

  private computeGridLevels(): number[] {
    if (!this.configValid) return [];
    const { lowerPrice, upperPrice, gridLevels } = this.config;
    if (gridLevels <= 1) return [Number(lowerPrice.toFixed(this.priceDecimals)), Number(upperPrice.toFixed(this.priceDecimals))];
    if (this.config.gridMode === "geometric") {
      const ratio = Math.pow(upperPrice / lowerPrice, 1 / (gridLevels - 1));
      const levels: number[] = [];
      for (let i = 0; i < gridLevels; i += 1) {
        const price = lowerPrice * Math.pow(ratio, i);
        levels.push(Number(price.toFixed(this.priceDecimals)));
      }
      if (levels.length) {
        levels[0] = Number(lowerPrice.toFixed(this.priceDecimals));
        levels[levels.length - 1] = Number(upperPrice.toFixed(this.priceDecimals));
      }
      return levels;
    }
    this.log("error", `不支持的网格模式: ${String(this.config.gridMode)}`);
    return [];
  }

  // -----------------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------------

  private buildSnapshot(): GridEngineSnapshot {
    const reference = this.getReferencePrice();
    const tickerLast = Number(this.tickerSnapshot?.lastPrice);
    const lastPrice = Number.isFinite(tickerLast) ? tickerLast : reference;
    const midPrice = reference;
    const desiredKeys = new Set(
      this.desiredOrders.map((order) => this.getOrderKey(order.side, order.price, order.intent))
    );
    const openOrderKeys = new Set(
      this.openOrders
        .filter((order) => this.isActiveLimitOrder(order))
        .map((order) => {
          const id = String(order.orderId);
          const meta = this.orderIntentById.get(id);
          const intent: "ENTRY" | "EXIT" = meta?.intent ?? "ENTRY";
          return this.getOrderKey(order.side, this.normalizePrice(order.price), intent);
        })
    );

    const gridLines: GridLineSnapshot[] = this.gridLevels.map((price, level) => {
      const desired = this.desiredOrders.find((order) => order.level === level);
      const defaultSide = this.buyLevelIndices.includes(level) ? "BUY" : "SELL";
      const side = desired?.side ?? defaultSide;
      const key = desired ? this.getOrderKey(desired.side, desired.price, desired.intent) : null;
      const hasOrder = key ? openOrderKeys.has(key) : false;
      const active = Boolean(desired && key && desiredKeys.has(key));
      const state = this.levelStates.get(level) ?? "idle";
      return { level, price, side, active, hasOrder, state };
    });

    return {
      ready: this.isReady() && this.running,
      symbol: this.config.symbol,
      lowerPrice: this.config.lowerPrice,
      upperPrice: this.config.upperPrice,
      lastPrice,
      midPrice,
      gridLines,
      desiredOrders: this.desiredOrders.slice(),
      openOrders: this.openOrders.filter((order) => this.isActiveLimitOrder(order)),
      position: this.position,
      running: this.running,
      stopReason: this.running ? null : this.stopReason,
      direction: this.config.direction,
      tradeLog: this.tradeLog.all().slice(),
      feedStatus: { ...this.feedStatus },
      lastUpdated: this.lastUpdated,
    };
  }

  private emitUpdate(): void {
    this.events.emit("update", this.buildSnapshot());
  }

  // -----------------------------------------------------------------------
  // State persistence (debounced)
  // -----------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.skipPersistence) return;
    if (this.savePending) return;
    this.savePending = true;
    setTimeout(() => {
      this.savePending = false;
      void this.persistState();
    }, 500);
  }

  private async persistState(): Promise<void> {
    const levels: Record<string, StoredLevelInfo> = {};
    for (const [idx, state] of this.levelStates) {
      if (state === "idle") continue;
      levels[String(idx)] = {
        state,
        sourceLevel: idx,
        targetLevel: this.exitTargetBySource.get(idx) ?? null,
      };
    }
    const snapshot: StoredGridState = {
      symbol: this.config.symbol,
      lowerPrice: this.config.lowerPrice,
      upperPrice: this.config.upperPrice,
      gridLevels: this.config.gridLevels,
      orderSize: this.config.orderSize,
      maxPositionSize: this.config.maxPositionSize,
      direction: this.config.direction,
      levels,
      updatedAt: this.now(),
    };
    try {
      await saveGridState(snapshot);
    } catch (err) {
      this.log("error", `保存网格状态失败: ${extractMessage(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Utility methods
  // -----------------------------------------------------------------------

  private getOrderKey(side: "BUY" | "SELL", price: string, intent: "ENTRY" | "EXIT" = "ENTRY"): string {
    return `${side}:${price}:${intent}`;
  }

  private isActiveLimitOrder(o: Order): boolean {
    if (o.symbol !== this.config.symbol) return false;
    if (o.type !== "LIMIT") return false;
    const s = String(o.status || "").toUpperCase();
    return !["FILLED", "CANCELED", "CANCELLED", "REJECTED", "EXPIRED"].includes(s);
  }

  private normalizePrice(price: string | number): string {
    const numeric = Number(price);
    if (!Number.isFinite(numeric)) return "0";
    return numeric.toFixed(this.priceDecimals);
  }

  private formatPrice(price: number): string {
    if (!Number.isFinite(price)) return "0";
    return Number(price).toFixed(this.priceDecimals);
  }

  private buildLevelMeta(referencePrice?: number | null): void {
    this.levelMeta.length = 0;
    this.buyLevelIndices.length = 0;
    this.sellLevelIndices.length = 0;
    if (!this.gridLevels.length) return;
    const pivotIndex = Math.floor(Math.max(this.gridLevels.length - 1, 0) / 2);
    const hasReference = Number.isFinite(referencePrice ?? NaN);
    const pivotPrice = hasReference ? this.clampReferencePrice(Number(referencePrice)) : null;
    for (let i = 0; i < this.gridLevels.length; i += 1) {
      let side: "BUY" | "SELL";
      if (pivotPrice != null) {
        side = this.gridLevels[i]! <= pivotPrice + EPSILON ? "BUY" : "SELL";
      } else {
        side = i <= pivotIndex ? "BUY" : "SELL";
      }
      const meta: LevelMeta = {
        index: i,
        price: this.gridLevels[i]!,
        side,
        closeTarget: null,
        closeSources: [],
      };
      this.levelMeta.push(meta);
      if (side === "BUY") this.buyLevelIndices.push(i);
      else this.sellLevelIndices.push(i);
    }
    for (const meta of this.levelMeta) {
      if (meta.side === "BUY") {
        for (let j = meta.index + 1; j < this.levelMeta.length; j += 1) {
          if (this.levelMeta[j]!.side === "SELL") {
            meta.closeTarget = this.levelMeta[j]!.index;
            this.levelMeta[j]!.closeSources.push(meta.index);
            break;
          }
        }
      } else {
        for (let j = meta.index - 1; j >= 0; j -= 1) {
          if (this.levelMeta[j]!.side === "BUY") {
            meta.closeTarget = this.levelMeta[j]!.index;
            this.levelMeta[j]!.closeSources.push(meta.index);
            break;
          }
        }
      }
    }
  }

  private chooseAnchoringPrice(): number | null {
    const reference = this.getReferencePrice();
    if (!Number.isFinite(reference) || reference == null) return null;
    const ref = Number(reference);
    const qty = this.position.positionAmt;
    const entry = this.position.entryPrice;
    const hasEntry = Number.isFinite(entry) && Math.abs(entry) > EPSILON;
    if (!hasEntry || Math.abs(qty) <= EPSILON) return ref;
    if (qty > 0 && ref < Number(entry) - EPSILON) return Number(entry);
    if (qty < 0 && ref > Number(entry) + EPSILON) return Number(entry);
    return ref;
  }

  // -----------------------------------------------------------------------
  // Legacy helpers (retained for test backward compat)
  // -----------------------------------------------------------------------

  private computeDesiredOrders(price: number): DesiredGridOrder[] {
    if (!Number.isFinite(price)) return [];
    const desired: DesiredGridOrder[] = [];
    const halfTick = this.config.priceTick / 2;
    let remainingLong = Math.max(this.config.maxPositionSize - this.sumExposure(this.longExposure), 0);
    let remainingShort = Math.max(this.config.maxPositionSize - this.sumExposure(this.shortExposure), 0);

    for (const level of this.buyLevelIndices.slice().reverse()) {
      if (this.config.direction === "short") break;
      if (this.longExposure.has(level)) continue;
      const levelPrice = this.gridLevels[level]!;
      if (levelPrice >= price - halfTick) continue;
      if (remainingLong <= EPSILON) continue;
      const amount = Math.min(this.config.orderSize, remainingLong);
      if (amount <= EPSILON) continue;
      desired.push({
        level,
        side: "BUY",
        price: this.formatPrice(levelPrice),
        amount,
        intent: "ENTRY",
        reduceOnly: false,
      });
      remainingLong -= amount;
    }

    for (const level of this.sellLevelIndices) {
      if (this.config.direction === "long") break;
      if (this.shortExposure.has(level)) continue;
      const levelPrice = this.gridLevels[level]!;
      if (levelPrice <= price + halfTick) continue;
      if (remainingShort <= EPSILON) continue;
      const amount = Math.min(this.config.orderSize, remainingShort);
      if (amount <= EPSILON) continue;
      desired.push({
        level,
        side: "SELL",
        price: this.formatPrice(levelPrice),
        amount,
        intent: "ENTRY",
        reduceOnly: false,
      });
      remainingShort -= amount;
    }

    const longByTarget = new Map<number, number>();
    for (const [sourceLevel, qty] of this.longExposure.entries()) {
      const target = this.levelMeta[sourceLevel]?.closeTarget;
      if (target == null) continue;
      longByTarget.set(target, (longByTarget.get(target) ?? 0) + qty);
    }
    for (const target of Array.from(longByTarget.keys()).sort((a, b) => a - b)) {
      desired.push({
        level: target,
        side: "SELL",
        price: this.formatPrice(this.gridLevels[target]!),
        amount: longByTarget.get(target)!,
        intent: "EXIT",
        reduceOnly: true,
      });
    }

    const shortByTarget = new Map<number, number>();
    for (const [sourceLevel, qty] of this.shortExposure.entries()) {
      const target = this.levelMeta[sourceLevel]?.closeTarget;
      if (target == null) continue;
      shortByTarget.set(target, (shortByTarget.get(target) ?? 0) + qty);
    }
    for (const target of Array.from(shortByTarget.keys()).sort((a, b) => a - b)) {
      desired.push({
        level: target,
        side: "BUY",
        price: this.formatPrice(this.gridLevels[target]!),
        amount: shortByTarget.get(target)!,
        intent: "EXIT",
        reduceOnly: true,
      });
    }

    return desired;
  }

  private async syncGrid(price: number): Promise<void> {
    this.syncLegacyExposureFromPosition();
    this.desiredOrders = this.computeDesiredOrders(price);
    this.lastUpdated = this.now();
  }

  private syncLegacyExposureFromPosition(): void {
    const qty = this.position.positionAmt;
    if (!Number.isFinite(qty) || Math.abs(qty) <= EPSILON) {
      this.longExposure.clear();
      this.shortExposure.clear();
      return;
    }
    if (qty > 0) {
      this.shortExposure.clear();
      this.longExposure.clear();
      let remaining = Math.abs(qty);
      for (const level of this.buyLevelIndices.slice().reverse()) {
        if (remaining <= EPSILON) break;
        const amount = Math.min(this.config.orderSize, remaining);
        this.longExposure.set(level, amount);
        remaining -= amount;
      }
      return;
    }
    this.longExposure.clear();
    this.shortExposure.clear();
    let remaining = Math.abs(qty);
    for (const level of this.sellLevelIndices) {
      if (remaining <= EPSILON) break;
      const amount = Math.min(this.config.orderSize, remaining);
      this.shortExposure.set(level, amount);
      remaining -= amount;
    }
  }

  private sumExposure(map: Map<number, number>): number {
    let total = 0;
    for (const qty of map.values()) total += qty;
    return total;
  }
}
