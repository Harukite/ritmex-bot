import { createOrderHandlers } from "../order-handlers";

const handlers = createOrderHandlers({
  exchangeName: "StandX",
  defaultLimitTimeInForce: "GTX",
  defaultMarketTimeInForce: "IOC",
  defaultCloseTimeInForce: "IOC",
  supportsTrailingStop: false,
  supportsTriggerType: false,
  stopDefaultReduceOnly: true,
  stopDefaultClosePosition: true,
  closeDefaultClosePosition: true,
});

export const {
  createLimitOrder,
  createMarketOrder,
  createStopOrder,
  createTrailingStopOrder,
  createClosePositionOrder,
} = handlers;
