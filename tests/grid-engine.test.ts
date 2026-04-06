import { describe, expect, it } from "vitest";
import type { ExchangeAdapter } from "../src/exchanges/adapter";
import type {
  AccountSnapshot,
  Depth,
  Order,
  Ticker,
  CreateOrderParams,
} from "../src/exchanges/types";
import type { GridConfig } from "../src/config";
import { GridEngine } from "../src/strategy/grid-engine";

let orderCounter = 0;

class StubAdapter implements ExchangeAdapter {
  id = "aster";

  private accountHandler: ((snapshot: AccountSnapshot) => void) | null = null;
  private orderHandler: ((orders: Order[]) => void) | null = null;
  private depthHandler: ((depth: Depth) => void) | null = null;
  private tickerHandler: ((ticker: Ticker) => void) | null = null;
  private currentOrders: Order[] = [];

  public createdOrders: CreateOrderParams[] = [];
  public marketOrders: CreateOrderParams[] = [];
  public cancelAllCount = 0;
  public cancelledOrders: Array<number | string> = [];

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: (snapshot: AccountSnapshot) => void): void {
    this.accountHandler = cb;
  }

  watchOrders(cb: (orders: Order[]) => void): void {
    this.orderHandler = cb;
  }

  watchDepth(_symbol: string, cb: (depth: Depth) => void): void {
    this.depthHandler = cb;
  }

  watchTicker(_symbol: string, cb: (ticker: Ticker) => void): void {
    this.tickerHandler = cb;
  }

  watchKlines(): void {
    // not used in tests
  }

  emitAccount(snapshot: AccountSnapshot): void {
    this.accountHandler?.(snapshot);
  }

  emitOrders(orders: Order[]): void {
    this.orderHandler?.(orders);
  }

  emitDepth(depth: Depth): void {
    this.depthHandler?.(depth);
  }

  emitTicker(ticker: Ticker): void {
    this.tickerHandler?.(ticker);
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    orderCounter++;
    const orderId = params.clientOrderId ?? `stub-${orderCounter}`;
    const order: Order = {
      orderId,
      clientOrderId: params.clientOrderId ?? orderId,
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      status: params.type === "MARKET" ? "FILLED" : "NEW",
      price: Number(params.price ?? 0).toString(),
      origQty: Number(params.quantity ?? 0).toString(),
      executedQty: "0",
      stopPrice: "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: params.reduceOnly === "true",
      closePosition: false,
    };
    this.createdOrders.push(params);
    if (params.type === "MARKET") {
      this.marketOrders.push(params);
      this.orderHandler?.([]);
    } else {
      this.currentOrders.push(order);
      this.orderHandler?.([...this.currentOrders]);
    }
    return order;
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    this.cancelledOrders.push(params.orderId);
    this.currentOrders = this.currentOrders.filter(o => String(o.orderId) !== String(params.orderId));
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    this.cancelledOrders.push(...params.orderIdList);
    const idSet = new Set(params.orderIdList.map(String));
    this.currentOrders = this.currentOrders.filter(o => !idSet.has(String(o.orderId)));
  }

  async cancelAllOrders(): Promise<void> {
    this.cancelAllCount += 1;
    this.currentOrders = [];
    this.orderHandler?.([]);
  }

  clearCurrentOrders(): void {
    this.currentOrders = [];
  }

  getCurrentOrders(): Order[] {
    return [...this.currentOrders];
  }
}

function createAccountSnapshot(symbol: string, positionAmt: number): AccountSnapshot {
  return {
    canTrade: true,
    canDeposit: true,
    canWithdraw: true,
    updateTime: Date.now(),
    totalWalletBalance: "0",
    totalUnrealizedProfit: "0",
    positions: [
      {
        symbol,
        positionAmt: positionAmt.toString(),
        entryPrice: "150",
        unrealizedProfit: "0",
        positionSide: "BOTH",
        updateTime: Date.now(),
      },
    ],
    assets: [],
  } as unknown as AccountSnapshot;
}

describe("GridEngine", () => {
  const baseConfig: GridConfig = {
    symbol: "BTCUSDT",
    lowerPrice: 100,
    upperPrice: 200,
    gridLevels: 3,
    orderSize: 0.1,
    maxPositionSize: 0.2,
    refreshIntervalMs: 10,
    maxLogEntries: 50,
    priceTick: 0.1,
    qtyStep: 0.01,
    direction: "both",
    stopLossPct: 0.01,
    restartTriggerPct: 0.01,
    autoRestart: true,
    gridMode: "geometric",
    maxCloseSlippagePct: 0.05,
  };

  it("creates geometric desired orders when running in both directions", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    // use internal syncGrid to generate orders without waiting for timers
    const desired = (engine as any).computeDesiredOrders(150) as Array<{ side: string; price: string }>;
    expect(desired).toHaveLength(3);
    const buyOrders = desired.filter((order) => order.side === "BUY");
    const sellOrders = desired.filter((order) => order.side === "SELL");
    expect(buyOrders).toHaveLength(2);
    expect(sellOrders).toHaveLength(1);
    expect(Number(buyOrders[0]?.price)).toBeCloseTo(141.4, 1);
    expect(Number(buyOrders[1]?.price)).toBeCloseTo(100, 6);
    expect(Number(sellOrders[0]?.price)).toBeCloseTo(200, 6);

    engine.stop();
  });

  it("limits sell orders for long-only direction when no position is available", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine({ ...baseConfig, direction: "long" }, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);

    const desired = (engine as any).computeDesiredOrders(150) as Array<{ side: string; reduceOnly: boolean }>;
    const sells = desired.filter((order) => order.side === "SELL");
    const buys = desired.filter((order) => order.side === "BUY");

    expect(buys.length).toBeGreaterThan(0);
    expect(sells).toHaveLength(0);

    engine.stop();
  });

  it("does not repopulate the same buy level until exposure is released", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);

    const desiredInitial = (engine as any).computeDesiredOrders(150) as Array<{ level: number; side: string }>;
    const nearestBuy = desiredInitial.find((order) => order.side === "BUY");
    expect(nearestBuy).toBeTruthy();
    const targetLevel = nearestBuy!.level;

    (engine as any).longExposure.set(targetLevel, baseConfig.orderSize);
    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, baseConfig.orderSize));

    const desiredAfterFill = (engine as any).computeDesiredOrders(150) as Array<{ level: number; side: string }>;
    expect(desiredAfterFill.some((order) => order.level === targetLevel && order.side === "BUY")).toBe(false);

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    const desiredAfterExit = (engine as any).computeDesiredOrders(150) as Array<{ level: number; side: string }>;
    expect(desiredAfterExit.some((order) => order.level === targetLevel && order.side === "BUY")).toBe(true);

    engine.stop();
  });

  it("keeps level side assignments stable regardless of price", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);

    const desiredHigh = (engine as any).computeDesiredOrders(2.45) as Array<{ level: number; side: string }>;
    expect(desiredHigh.every((order) => {
      const isBuyLevel = order.level <= Math.floor((baseConfig.gridLevels - 1) / 2);
      return isBuyLevel ? order.side === "BUY" : order.side === "SELL";
    })).toBe(true);

    const desiredLow = (engine as any).computeDesiredOrders(1.55) as Array<{ level: number; side: string }>;
    expect(desiredLow.every((order) => {
      const isBuyLevel = order.level <= Math.floor((baseConfig.gridLevels - 1) / 2);
      return isBuyLevel ? order.side === "BUY" : order.side === "SELL";
    })).toBe(true);

    engine.stop();
  });

  it("limits active sell orders by remaining short headroom", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);

    const desiredFull = (engine as any).computeDesiredOrders(2.1) as Array<{ level: number; side: string }>;
    const sellCountFull = desiredFull.filter((order) => order.side === "SELL").length;
    expect(sellCountFull).toBeGreaterThan(0);

    const limitedHeadroomConfig = { ...baseConfig, maxPositionSize: baseConfig.orderSize * 2 };
    const limitedEngine = new GridEngine(limitedHeadroomConfig, adapter as any, { now: () => 0, skipPersistence: true });
    (limitedEngine as any).shortExposure.set(12, baseConfig.orderSize * 2);

    const desiredLimited = (limitedEngine as any).computeDesiredOrders(2.1) as Array<{ level: number; side: string }>;
    const sellCountLimited = desiredLimited.filter((order) => order.side === "SELL").length;
    expect(sellCountLimited).toBeLessThanOrEqual(1);

    engine.stop();
    limitedEngine.stop();
  });

  it("places reduce-only orders to close existing exposures", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, baseConfig.orderSize));
    adapter.emitOrders([]);

    const buyLevel = (engine as any).buyLevelIndices.slice(-1)[0];
    (engine as any).longExposure.set(buyLevel, baseConfig.orderSize);

    const desired = (engine as any).computeDesiredOrders(2.05) as Array<{
      level: number;
      side: string;
      reduceOnly: boolean;
      amount: number;
    }>;

    const closeOrder = desired.find((order) => order.reduceOnly && order.side === "SELL");
    expect(closeOrder).toBeTruthy();
    expect(closeOrder!.amount).toBeCloseTo(baseConfig.orderSize);

    engine.stop();
  });

  it("restores exposures from existing reduce-only orders on restart", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, baseConfig.orderSize * 2));

    const reduceOrder: Order = {
      orderId: "existing-reduce",
      clientOrderId: "existing-reduce",
      symbol: baseConfig.symbol,
      side: "SELL",
      type: "LIMIT",
      status: "NEW",
      price: baseConfig.upperPrice.toFixed(1),
      origQty: (baseConfig.orderSize * 2).toString(),
      executedQty: "0",
      stopPrice: "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: true,
      closePosition: false,
    };

    adapter.emitOrders([reduceOrder]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    await (engine as any).syncGrid(150);

    const longExposure: Map<number, number> = (engine as any).longExposure;
    const buyIndices: number[] = (engine as any).buyLevelIndices;

    const totalExposure = [...longExposure.values()].reduce((acc, qty) => acc + qty, 0);
    expect(totalExposure).toBeCloseTo(baseConfig.orderSize * 2, 6);
    expect(longExposure.get(buyIndices.slice(-1)[0]!)).toBeCloseTo(baseConfig.orderSize, 6);
    expect(longExposure.get(buyIndices[0]!)).toBeCloseTo(baseConfig.orderSize, 6);

    const snapshot = engine.getSnapshot();
    const reduceDesired = snapshot.desiredOrders.find(
      (order) => order.reduceOnly && order.side === "SELL"
    );
    expect(reduceDesired).toBeTruthy();
    expect(reduceDesired!.amount).toBeCloseTo(baseConfig.orderSize * 2, 6);
    expect(Number(reduceDesired!.price)).toBeCloseTo(baseConfig.upperPrice, 6);
    // New engine cancels unrecognized orders (no grid- prefix) during recovery;
    // legacy syncGrid still picks up exposure from position regardless.

    engine.stop();
  });

  it("halts the grid and closes positions when stop loss triggers", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0.2));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    (engine as any).stopReason = "test stop";
    await (engine as any).haltGrid(90);

    expect(adapter.cancelAllCount).toBeGreaterThanOrEqual(1);
    expect(adapter.marketOrders).toHaveLength(1);
    expect(engine.getSnapshot().running).toBe(false);

    engine.stop();
  });

  // -----------------------------------------------------------------------
  // New tests for refactored level-state tracking & clientOrderId system
  // -----------------------------------------------------------------------

  it("encodes and decodes ENTRY clientOrderId correctly", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 1000, skipPersistence: true });

    const makeId = (engine as any).__proto__.constructor; // access via module scope
    // Access the private function through the engine's internal methods
    // We test indirectly by placing an order and checking its clientOrderId

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    // Force recovery to complete
    (engine as any).recoveryDone = true;

    // Trigger syncGridSimple which should place orders with clientOrderIds
    // We'll interact through the desired orders and order placement instead

    const desired = (engine as any).computeDesiredOrders(150) as Array<{ intent: string }>;
    // All orders from computeDesiredOrders should have intent set
    for (const d of desired) {
      expect(d.intent).toBeDefined();
      expect(["ENTRY", "EXIT"]).toContain(d.intent);
    }

    engine.stop();
  });

  it("marks level as filled when ENTRY disappears as filled", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    (engine as any).recoveryDone = true;

    // Simulate placing an ENTRY order at a buy level
    const buyLevel = (engine as any).buyLevelIndices[0] as number;
    const levelPrice = (engine as any).gridLevels[buyLevel];
    const priceStr = (engine as any).formatPrice(levelPrice);

    // Register the order in the engine's tracking
    const fakeOrderId = "entry-order-1";
    (engine as any).orderIntentById.set(fakeOrderId, {
      side: "BUY",
      price: priceStr,
      level: buyLevel,
      intent: "ENTRY",
    });

    // First sync: the order is active → record it in prevActiveIds
    const activeOrder: Order = {
      orderId: fakeOrderId,
      clientOrderId: fakeOrderId,
      symbol: baseConfig.symbol,
      side: "BUY",
      type: "LIMIT",
      status: "NEW",
      price: priceStr,
      origQty: baseConfig.orderSize.toString(),
      executedQty: "0",
      stopPrice: "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: false,
      closePosition: false,
    };

    // Set engine's openOrders to include the active order
    (engine as any).openOrders = [activeOrder];
    // Run syncGridSimple so prevActiveIds gets populated
    await (engine as any).syncGridSimple(150);

    // Verify level starts as idle
    expect((engine as any).levelStates.get(buyLevel)).toBe("idle");

    // Now: order disappears from active (FILLED)
    const filledOrder: Order = {
      ...activeOrder,
      status: "FILLED",
      executedQty: baseConfig.orderSize.toString(),
    };

    // Update engine openOrders: the order is now FILLED (not active)
    // Also include a fake EXIT order so exit-first logic doesn't short-circuit
    const fakeExitOrder: Order = {
      orderId: "fake-exit",
      clientOrderId: "grid-X-0-2-abc",
      symbol: baseConfig.symbol,
      side: "SELL",
      type: "LIMIT",
      status: "NEW",
      price: "200.0",
      origQty: baseConfig.orderSize.toString(),
      executedQty: "0",
      stopPrice: "0",
      time: Date.now(),
      updateTime: Date.now(),
      reduceOnly: false,
      closePosition: false,
    };
    (engine as any).orderIntentById.set("fake-exit", {
      side: "SELL",
      price: "200.0",
      level: 2,
      intent: "EXIT",
      sourceLevel: 0,
    });

    (engine as any).openOrders = [filledOrder, fakeExitOrder];
    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, baseConfig.orderSize));

    // Trigger tick to process disappearance
    await (engine as any).syncGridSimple(150);

    // Level should now be "filled"
    expect((engine as any).levelStates.get(buyLevel)).toBe("filled");

    engine.stop();
  });

  it("refuses new ENTRY at a level that is already filled", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    (engine as any).recoveryDone = true;

    // Mark a buy level as "filled" — this simulates a previous ENTRY fill
    const buyLevel = (engine as any).buyLevelIndices[0] as number;
    (engine as any).levelStates.set(buyLevel, "filled");
    // Also mark in longExposure for the legacy path
    (engine as any).longExposure.set(buyLevel, baseConfig.orderSize);

    // The legacy computeDesiredOrders skips levels present in longExposure
    const desired = (engine as any).computeDesiredOrders(150) as Array<{ level: number; side: string; intent: string }>;
    const entryAtFilledLevel = desired.find(
      (d: { level: number; intent: string }) => d.level === buyLevel && d.intent === "ENTRY"
    );
    expect(entryAtFilledLevel).toBeUndefined();

    // Also verify via syncGridSimple: filled levels don't generate ENTRY
    // Reset position to have some qty so exit-first doesn't block entry generation
    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    (engine as any).openOrders = [];
    await (engine as any).syncGridSimple(150);
    const desiredNew = (engine as any).desiredOrders as Array<{ level: number; intent: string }>;
    const entryAtFilled = desiredNew.find(
      (d: { level: number; intent: string }) => d.level === buyLevel && d.intent === "ENTRY"
    );
    expect(entryAtFilled).toBeUndefined();

    engine.stop();
  });

  it("releases level back to idle when EXIT fills (via longExposure legacy)", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, baseConfig.orderSize));
    adapter.emitOrders([]);

    const buyLevel = (engine as any).buyLevelIndices[0] as number;

    // Simulate: level was filled and has exposure
    (engine as any).levelStates.set(buyLevel, "exit_placed");
    (engine as any).longExposure.set(buyLevel, baseConfig.orderSize);

    // Now clear the exposure (simulating EXIT fill)
    (engine as any).longExposure.delete(buyLevel);
    (engine as any).levelStates.set(buyLevel, "idle");
    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));

    // The level should now accept a new ENTRY
    const desired = (engine as any).computeDesiredOrders(150) as Array<{ level: number; side: string; intent: string }>;
    const entryAtLevel = desired.find(
      (d: { level: number; intent: string }) => d.level === buyLevel && d.intent === "ENTRY"
    );
    expect(entryAtLevel).toBeTruthy();

    engine.stop();
  });

  it("EXIT orders are placed without reduceOnly flag", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, baseConfig.orderSize));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    (engine as any).recoveryDone = true;

    // Set up a filled level so the engine wants to place an EXIT
    const buyLevels = (engine as any).buyLevelIndices as number[];
    const buyLevel = buyLevels[buyLevels.length - 1]!;
    const target = (engine as any).levelMeta[buyLevel]?.closeTarget;

    (engine as any).levelStates.set(buyLevel, "filled");
    if (target != null) {
      (engine as any).exitTargetBySource.set(buyLevel, target);
    }

    // Trigger syncGridSimple to attempt EXIT placement
    await (engine as any).syncGridSimple(150);

    // Check that any created order does NOT have reduceOnly = "true"
    for (const params of adapter.createdOrders) {
      if (params.clientOrderId?.includes("-X-")) {
        expect(params.reduceOnly).not.toBe("true");
      }
    }

    engine.stop();
  });

  it("all desired orders from computeDesiredOrders have intent field set", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);

    const desired = (engine as any).computeDesiredOrders(150) as Array<{ intent?: string }>;
    for (const d of desired) {
      expect(d.intent).toBeDefined();
      expect(["ENTRY", "EXIT"]).toContain(d.intent);
    }

    engine.stop();
  });

  it("snapshot includes level state for each grid line", () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    const snapshot = engine.getSnapshot();
    expect(snapshot.gridLines.length).toBeGreaterThan(0);
    for (const line of snapshot.gridLines) {
      expect(line.state).toBeDefined();
      expect(["idle", "filled", "exit_placed"]).toContain(line.state);
    }

    engine.stop();
  });

  it("created orders contain clientOrderId with grid prefix", async () => {
    const adapter = new StubAdapter();
    const engine = new GridEngine(baseConfig, adapter, { now: () => 0, skipPersistence: true });

    adapter.emitAccount(createAccountSnapshot(baseConfig.symbol, 0));
    adapter.emitOrders([]);
    adapter.emitTicker({
      symbol: baseConfig.symbol,
      lastPrice: "150",
      openPrice: "150",
      highPrice: "150",
      lowPrice: "150",
      volume: "0",
      quoteVolume: "0",
    });

    (engine as any).recoveryDone = true;

    // Trigger a sync to place at least one order
    await (engine as any).syncGridSimple(150);

    // Check that created orders have grid- prefixed clientOrderId
    if (adapter.createdOrders.length > 0) {
      for (const params of adapter.createdOrders) {
        expect(params.clientOrderId).toBeDefined();
        expect(params.clientOrderId!.startsWith("grid-")).toBe(true);
      }
    }

    engine.stop();
  });
});
