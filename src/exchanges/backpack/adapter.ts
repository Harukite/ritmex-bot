import type {
  AccountListener,
  DepthListener,
  ExchangeAdapter,
  KlineListener,
  OrderListener,
  TickerListener,
} from "../adapter";
import type { Order, CreateOrderParams } from "../types";
import { extractMessage } from "../../utils/errors";
import { BackpackGateway, type BackpackGatewayOptions } from "./gateway";
import { createSafeInvoke, createInitManager } from "../adapter-utils";

export interface BackpackCredentials {
  apiKey?: string;
  apiSecret?: string;
  password?: string;
  subaccount?: string;
  symbol?: string;
  sandbox?: boolean;
}

export class BackpackExchangeAdapter implements ExchangeAdapter {
  readonly id = "backpack";
  private readonly gateway: BackpackGateway;
  private readonly symbol: string;
  private readonly safeInvoke = createSafeInvoke("BackpackExchangeAdapter");
  private readonly init: ReturnType<typeof createInitManager>;

  constructor(credentials: BackpackCredentials = {}) {
    const apiKey = credentials.apiKey ?? process.env.BACKPACK_API_KEY;
    const apiSecret = credentials.apiSecret ?? process.env.BACKPACK_API_SECRET;
    const password = credentials.password ?? process.env.BACKPACK_PASSWORD;
    const subaccount = credentials.subaccount ?? process.env.BACKPACK_SUBACCOUNT;
    const sandbox = credentials.sandbox ?? (process.env.BACKPACK_SANDBOX === "true");
    
    const symbol = credentials.symbol ?? process.env.BACKPACK_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTCUSDC";
    
    if (!apiKey || !apiSecret) {
      throw new Error("BACKPACK_API_KEY and BACKPACK_API_SECRET environment variables are required");
    }

    const gatewayOptions: BackpackGatewayOptions = {
      apiKey,
      apiSecret,
      password,
      subaccount,
      symbol,
      sandbox,
      logger: (context, error) => this.logError(context, error),
    };
    
    this.gateway = new BackpackGateway(gatewayOptions);
    this.symbol = symbol;
    this.init = createInitManager("BackpackExchangeAdapter", () =>
      this.gateway.ensureInitialized(this.symbol),
    );
  }

  supportsTrailingStops(): boolean {
    return false; // TODO: Check if Backpack supports trailing stops via ccxt
  }

  watchAccount(cb: AccountListener): void {
    void this.init.ensureInitialized("watchAccount");
    this.gateway.onAccount(this.safeInvoke("watchAccount", cb));
  }

  watchOrders(cb: OrderListener): void {
    void this.init.ensureInitialized("watchOrders");
    this.gateway.onOrders(this.safeInvoke("watchOrders", cb));
  }

  watchDepth(_symbol: string, cb: DepthListener): void {
    void this.init.ensureInitialized("watchDepth");
    this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
  }

  watchTicker(_symbol: string, cb: TickerListener): void {
    void this.init.ensureInitialized("watchTicker");
    this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
  }

  watchKlines(_symbol: string, interval: string, cb: KlineListener): void {
    void this.init.ensureInitialized(`watchKlines:${interval}`);
    this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
  }

  async createOrder(params: CreateOrderParams): Promise<Order> {
    await this.init.ensureInitialized("createOrder");
    return this.gateway.createOrder(params);
  }

  async cancelOrder(params: { symbol: string; orderId: number | string }): Promise<void> {
    await this.init.ensureInitialized("cancelOrder");
    await this.gateway.cancelOrder({ orderId: params.orderId });
  }

  async cancelOrders(params: { symbol: string; orderIdList: Array<number | string> }): Promise<void> {
    await this.init.ensureInitialized("cancelOrders");
    await this.gateway.cancelOrders({ orderIdList: params.orderIdList });
  }

  async cancelAllOrders(_params: { symbol: string }): Promise<void> {
    await this.init.ensureInitialized("cancelAllOrders");
    await this.gateway.cancelAllOrders();
  }

  private logError(context: string, error: unknown): void {
    if (process.env.BACKPACK_DEBUG === "1" || process.env.BACKPACK_DEBUG === "true") {
      console.error(`[BackpackExchangeAdapter] ${context} failed: ${extractMessage(error)}`);
    }
  }
}
