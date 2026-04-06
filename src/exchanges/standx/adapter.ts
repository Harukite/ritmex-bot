import type {
  AccountListener,
  DepthListener,
  ExchangeAdapter,
  ExchangePrecision,
  FundingRateListener,
  KlineListener,
  OrderListener,
  RestHealthListener,
  TickerListener,
} from "../adapter";
import type { Order, CreateOrderParams } from "../types";
import { StandxGateway, type StandxGatewayOptions, type ConnectionEventListener, type ConnectionEventType } from "./gateway";
import { createSafeInvoke, createInitManager } from "../adapter-utils";

export type { ConnectionEventListener, ConnectionEventType };

export interface StandxCredentials {
  token?: string;
  symbol?: string;
  baseUrl?: string;
  wsUrl?: string;
  sessionId?: string;
  signingKey?: string;
  logger?: StandxGatewayOptions["logger"];
}

export class StandxExchangeAdapter implements ExchangeAdapter {
  readonly id = "standx";

  private readonly gateway: StandxGateway;
  private readonly symbol: string;
  private readonly safeInvoke = createSafeInvoke("StandxExchangeAdapter");
  private readonly init: ReturnType<typeof createInitManager>;

  constructor(credentials: StandxCredentials = {}) {
    const token = credentials.token ?? process.env.STANDX_TOKEN;
    if (!token) {
      throw new Error("Missing STANDX_TOKEN environment variable");
    }
    this.symbol = credentials.symbol ?? process.env.STANDX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTC-USD";
    this.gateway = new StandxGateway({
      token,
      symbol: this.symbol,
      baseUrl: credentials.baseUrl,
      wsUrl: credentials.wsUrl,
      sessionId: credentials.sessionId,
      signingKey: credentials.signingKey,
      logger: credentials.logger,
    });
    this.init = createInitManager("StandxExchangeAdapter", () =>
      this.gateway.ensureInitialized(this.symbol),
    );
  }

  supportsTrailingStops(): boolean {
    return false;
  }

  watchAccount(cb: AccountListener): void {
    void this.init.ensureInitialized("watchAccount");
    this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
  }

  watchOrders(cb: OrderListener): void {
    void this.init.ensureInitialized("watchOrders");
    this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
  }

  watchDepth(symbol: string, cb: DepthListener): void {
    void this.init.ensureInitialized("watchDepth");
    this.gateway.onDepth(symbol, this.safeInvoke("watchDepth", cb));
  }

  watchTicker(symbol: string, cb: TickerListener): void {
    void this.init.ensureInitialized("watchTicker");
    this.gateway.onTicker(symbol, this.safeInvoke("watchTicker", cb));
  }

  watchKlines(symbol: string, interval: string, cb: KlineListener): void {
    void this.init.ensureInitialized("watchKlines");
    this.gateway.onKlines(symbol, interval, this.safeInvoke("watchKlines", cb));
  }

  watchFundingRate(symbol: string, cb: FundingRateListener): void {
    void this.init.ensureInitialized("watchFundingRate");
    this.gateway.onFundingRate(symbol, this.safeInvoke("watchFundingRate", cb));
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    await this.init.ensureInitialized("createOrder");
    return this.gateway.createOrder(params);
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    await this.init.ensureInitialized("cancelOrder");
    await this.gateway.cancelOrder(params);
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    await this.init.ensureInitialized("cancelOrders");
    await this.gateway.cancelOrders(params);
  }

  async cancelAllOrders(params: { symbol: string }): Promise<void> {
    await this.init.ensureInitialized("cancelAllOrders");
    await this.gateway.cancelAllOrders(params);
  }

  async getPrecision(): Promise<ExchangePrecision | null> {
    try {
      const precision = await this.gateway.getPrecision(this.symbol);
      if (!precision) return null;
      return {
        priceTick: precision.priceTick,
        qtyStep: precision.qtyStep,
        priceDecimals: precision.priceDecimals,
        sizeDecimals: precision.sizeDecimals,
        minBaseAmount: precision.minBaseAmount,
      };
    } catch (error) {
      console.error("[StandxExchangeAdapter] getPrecision failed", error);
      return null;
    }
  }

  /**
   * 监听连接事件（断连/重连）
   */
  onConnectionEvent(listener: ConnectionEventListener): void {
    this.gateway.onConnectionEvent(listener);
  }

  /**
   * 取消连接事件监听
   */
  offConnectionEvent(listener: ConnectionEventListener): void {
    this.gateway.offConnectionEvent(listener);
  }

  onRestHealthEvent(listener: RestHealthListener): void {
    this.gateway.onRestHealthEvent(listener);
  }

  offRestHealthEvent(listener: RestHealthListener): void {
    this.gateway.offRestHealthEvent(listener);
  }

  /**
   * 查询当前真实的挂单状态（通过 HTTP API）
   * 用于验证实际挂单情况，防止取消请求丢失
   */
  async queryOpenOrders(): Promise<Order[]> {
    await this.init.ensureInitialized("queryOpenOrders");
    return this.gateway.queryOpenOrders(this.symbol);
  }

  async queryAccountSnapshot() {
    await this.init.ensureInitialized("queryAccountSnapshot");
    return this.gateway.queryAccountSnapshot();
  }

  async changeMarginMode(params: { symbol: string; marginMode: "isolated" | "cross" }): Promise<void> {
    await this.init.ensureInitialized("changeMarginMode");
    await this.gateway.changeMarginMode(params.symbol, params.marginMode);
  }

  /**
   * 强制取消所有挂单
   * 会查询当前挂单然后取消，并验证取消成功
   */
  async forceCancelAllOrders(): Promise<boolean> {
    await this.init.ensureInitialized("forceCancelAllOrders");
    return this.gateway.forceCancelAllOrders(this.symbol);
  }
}
