import { createOrderHandlers } from "../order-handlers";

const handlers = createOrderHandlers({
  exchangeName: "Paradex",
  defaultLimitTimeInForce: "GTC",
  supportsTrailingStop: false,
  supportsTriggerType: false,
  stopDefaultReduceOnly: true,
  stopDefaultClosePosition: true,
  stopPriceAsPrice: true,
  closeDefaultClosePosition: true,
});

export const {
  createLimitOrder,
  createMarketOrder,
  createStopOrder,
  createTrailingStopOrder,
  createClosePositionOrder,
} = handlers;
