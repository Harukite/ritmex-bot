import type { Order, CreateOrderParams, TimeInForce } from "./types";
import type {
  BaseOrderIntent,
  ClosePositionIntent,
  LimitOrderIntent,
  MarketOrderIntent,
  StopOrderIntent,
  TrailingStopOrderIntent,
} from "./order-schema";
import { toStringBoolean } from "./order-schema";

export interface OrderHandlerConfig {
  exchangeName: string;
  defaultLimitTimeInForce: TimeInForce | "GTX";
  defaultMarketTimeInForce?: TimeInForce;
  defaultCloseTimeInForce?: TimeInForce;
  defaultStopTimeInForce?: TimeInForce;
  defaultStopTriggerType?: "UNSPECIFIED" | "TAKE_PROFIT" | "STOP_LOSS";
  supportsTrailingStop: boolean;
  supportsTriggerType: boolean;
  stopDefaultReduceOnly?: boolean;
  stopDefaultClosePosition?: boolean;
  closeDefaultClosePosition?: boolean;
  stopPriceAsPrice?: boolean;
}

export interface OrderHandlers {
  createLimitOrder(intent: LimitOrderIntent): Promise<Order>;
  createMarketOrder(intent: MarketOrderIntent): Promise<Order>;
  createStopOrder(intent: StopOrderIntent): Promise<Order>;
  createTrailingStopOrder(intent: TrailingStopOrderIntent): Promise<Order>;
  createClosePositionOrder(intent: ClosePositionIntent): Promise<Order>;
}

function applyCommonFields(params: CreateOrderParams, intent: BaseOrderIntent): CreateOrderParams {
  if (params.quantity === undefined) {
    params.quantity = intent.quantity;
  }
  if (params.timeInForce === undefined && intent.timeInForce) {
    params.timeInForce = intent.timeInForce;
  }
  if (intent.reduceOnly !== undefined) {
    params.reduceOnly = toStringBoolean(intent.reduceOnly);
  }
  if (intent.closePosition !== undefined) {
    params.closePosition = toStringBoolean(intent.closePosition);
  }
  return params;
}

export function createOrderHandlers(config: OrderHandlerConfig): OrderHandlers {
  return {
    async createLimitOrder(intent: LimitOrderIntent): Promise<Order> {
      const params: CreateOrderParams = applyCommonFields(
        {
          symbol: intent.symbol,
          side: intent.side,
          type: "LIMIT",
          quantity: intent.quantity,
          price: intent.price,
          timeInForce: intent.timeInForce ?? config.defaultLimitTimeInForce,
          slPrice: intent.slPrice,
          tpPrice: intent.tpPrice,
        },
        intent,
      );
      return intent.adapter.createOrder(params);
    },

    async createMarketOrder(intent: MarketOrderIntent): Promise<Order> {
      const params: CreateOrderParams = applyCommonFields(
        {
          symbol: intent.symbol,
          side: intent.side,
          type: "MARKET",
          quantity: intent.quantity,
          timeInForce: intent.timeInForce ?? config.defaultMarketTimeInForce,
        },
        intent,
      );
      return intent.adapter.createOrder(params);
    },

    async createStopOrder(intent: StopOrderIntent): Promise<Order> {
      const params: CreateOrderParams = applyCommonFields(
        {
          symbol: intent.symbol,
          side: intent.side,
          type: "STOP_MARKET",
          quantity: intent.quantity,
          stopPrice: intent.stopPrice,
          timeInForce: intent.timeInForce ?? (config.defaultStopTimeInForce ?? "GTC"),
          triggerType: config.supportsTriggerType ? (intent.triggerType ?? config.defaultStopTriggerType) : undefined,
          price: config.stopPriceAsPrice ? intent.stopPrice : undefined,
        },
        intent,
      );
      if (config.stopDefaultReduceOnly && intent.reduceOnly === undefined) {
        params.reduceOnly = "true";
      }
      if (config.stopDefaultClosePosition && intent.closePosition === undefined) {
        params.closePosition = "true";
      }
      return intent.adapter.createOrder(params);
    },

    async createTrailingStopOrder(intent: TrailingStopOrderIntent): Promise<Order> {
      if (!config.supportsTrailingStop) {
        throw new Error(`${config.exchangeName} does not support trailing stop orders`);
      }
      const params: CreateOrderParams = applyCommonFields(
        {
          symbol: intent.symbol,
          side: intent.side,
          type: "TRAILING_STOP_MARKET",
          quantity: intent.quantity,
          activationPrice: intent.activationPrice,
          callbackRate: intent.callbackRate,
          timeInForce: intent.timeInForce ?? "GTC",
        },
        intent,
      );
      return intent.adapter.createOrder(params);
    },

    async createClosePositionOrder(intent: ClosePositionIntent): Promise<Order> {
      const params: CreateOrderParams = applyCommonFields(
        {
          symbol: intent.symbol,
          side: intent.side,
          type: "MARKET",
          quantity: intent.quantity,
          reduceOnly: "true",
          timeInForce: intent.timeInForce ?? config.defaultCloseTimeInForce,
        },
        intent,
      );
      if (config.closeDefaultClosePosition && intent.closePosition === undefined) {
        params.closePosition = "true";
      }
      return intent.adapter.createOrder(params);
    },
  };
}
