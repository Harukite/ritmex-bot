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
import { ParadexGateway, type ParadexGatewayOptions } from "./gateway";
import { createSafeInvoke, createInitManager } from "../adapter-utils";

export interface ParadexCredentials {
  privateKey?: string;
  walletAddress?: string;
  sandbox?: boolean;
  pollIntervals?: ParadexGatewayOptions["pollIntervals"];
  watchReconnectDelayMs?: number;
  usePro?: boolean;
  symbol?: string;
}

export class ParadexExchangeAdapter implements ExchangeAdapter {
  readonly id = "paradex";

  private readonly gateway: ParadexGateway;
  private readonly symbol: string;
  private readonly safeInvoke = createSafeInvoke("ParadexExchangeAdapter");
  private readonly init: ReturnType<typeof createInitManager>;

  constructor(credentials: ParadexCredentials = {}) {
    const privateKey = credentials.privateKey ?? process.env.PARADEX_PRIVATE_KEY;
    const walletAddress = credentials.walletAddress ?? process.env.PARADEX_WALLET_ADDRESS;
    const sandbox = credentials.sandbox ?? (process.env.PARADEX_SANDBOX === "true");
    const symbol = credentials.symbol ?? process.env.PARADEX_SYMBOL ?? process.env.TRADE_SYMBOL ?? "BTC/USDC";
    const usePro = credentials.usePro ?? this.parseBooleanEnv(process.env.PARADEX_USE_PRO);
    const watchReconnectDelayMs =
      credentials.watchReconnectDelayMs ?? this.parseNumberEnv(process.env.PARADEX_RECONNECT_DELAY_MS);

    this.gateway = new ParadexGateway({
      symbol,
      displaySymbol: symbol,
      privateKey,
      walletAddress,
      sandbox,
      pollIntervals: credentials.pollIntervals,
      watchReconnectDelayMs,
      usePro,
      logger: (context, error) => this.logError(context, error),
    });

    this.symbol = symbol;
    this.init = createInitManager("ParadexExchangeAdapter", () =>
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
    void this.init.ensureInitialized(`watchDepth:${symbol}`);
    this.gateway.onDepth(this.safeInvoke("watchDepth", cb));
  }

  watchTicker(symbol: string, cb: TickerListener): void {
    void this.init.ensureInitialized(`watchTicker:${symbol}`);
    this.gateway.onTicker(this.safeInvoke("watchTicker", cb));
  }

  watchKlines(symbol: string, interval: string, cb: KlineListener): void {
    void this.init.ensureInitialized(`watchKlines:${symbol}:${interval}`);
    this.gateway.watchKlines(interval, this.safeInvoke("watchKlines", cb));
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

  private logError(context: string, error: unknown): void {
    const detail = extractMessage(error);
    if (context === "initialize" && typeof error === "string" && /initialized/i.test(error)) {
      if (process.env.PARADEX_DEBUG === "1" || process.env.PARADEX_DEBUG === "true") {
        console.info(`[ParadexExchangeAdapter] ${error}`);
      }
      return;
    }
    const message = `[ParadexExchangeAdapter] ${context} failed: ${detail}`;
    const criticalContexts = [
      "initialize",
      "accountPoll",
      "watchBalanceLoop",
      "orderPoll",
      "orderPollOpen",
      "orderPollClosed",
    ];
    if (
      criticalContexts.some((prefix) => context.startsWith(prefix)) ||
      process.env.PARADEX_DEBUG === "1" ||
      process.env.PARADEX_DEBUG === "true"
    ) {
      console.error(message);
    }
  }

  private parseBooleanEnv(value: string | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
    return true;
  }

  private parseNumberEnv(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
