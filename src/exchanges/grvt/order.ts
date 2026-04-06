import { createOrderHandlers } from "../order-handlers";

const handlers = createOrderHandlers({
  exchangeName: "GRVT",
  defaultLimitTimeInForce: "GTX",
  supportsTrailingStop: false,
  supportsTriggerType: true,
  defaultStopTriggerType: "STOP_LOSS",
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

