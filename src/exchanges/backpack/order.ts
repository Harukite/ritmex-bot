import { createOrderHandlers } from "../order-handlers";

const handlers = createOrderHandlers({
  exchangeName: "Backpack",
  defaultLimitTimeInForce: "GTX",
  supportsTrailingStop: false,
  supportsTriggerType: false,
});

export const {
  createLimitOrder,
  createMarketOrder,
  createStopOrder,
  createTrailingStopOrder,
  createClosePositionOrder,
} = handlers;
