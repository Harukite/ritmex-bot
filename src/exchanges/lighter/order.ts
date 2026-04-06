import { createOrderHandlers } from "../order-handlers";

const handlers = createOrderHandlers({
  exchangeName: "Lighter",
  defaultLimitTimeInForce: "GTC",
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

