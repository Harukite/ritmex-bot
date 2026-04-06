import { createOrderHandlers } from "../order-handlers";

const handlers = createOrderHandlers({
  exchangeName: "Aster",
  defaultLimitTimeInForce: "GTX",
  supportsTrailingStop: true,
  supportsTriggerType: true,
});

export const {
  createLimitOrder,
  createMarketOrder,
  createStopOrder,
  createTrailingStopOrder,
  createClosePositionOrder,
} = handlers;

