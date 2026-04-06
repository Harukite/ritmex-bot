import type { DepthLevel, OrderSide, OrderType, TimeInForce } from "../types";

export interface AsterSpotRateLimit {
  rateLimitType: string;
  interval: string;
  intervalNum: number;
  limit: number;
}

export interface AsterSpotExchangeFilter {
  filterType: string;
  [key: string]: string | number | boolean | undefined;
}

export interface AsterFuturesSymbolFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minPrice?: string;
  maxPrice?: string;
  minQty?: string;
  maxQty?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface AsterFuturesSymbolInfo {
  symbol: string;
  pair?: string;
  contractType?: string;
  pricePrecision?: number;
  quantityPrecision?: number;
  baseAssetPrecision?: number;
  quotePrecision?: number;
  underlyingType?: string;
  filters?: AsterFuturesSymbolFilter[];
}

export interface AsterFuturesExchangeInfo {
  timezone?: string;
  serverTime?: number;
  symbols?: AsterFuturesSymbolInfo[];
}

export interface AsterSpotAssetInfo {
  asset: string;
}

export interface AsterSpotSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  baseAssetPrecision?: number;
  quotePrecision?: number;
  pricePrecision?: number;
  quantityPrecision?: number;
  orderTypes: string[];
  timeInForce: string[];
  ocoAllowed: boolean;
  filters: AsterSpotExchangeFilter[];
}

export interface AsterSpotExchangeInfo {
  timezone: string;
  serverTime: number;
  rateLimits: AsterSpotRateLimit[];
  exchangeFilters: AsterSpotExchangeFilter[];
  assets?: AsterSpotAssetInfo[];
  symbols: AsterSpotSymbolInfo[];
}

export interface AsterSpotDepth {
  lastUpdateId: number;
  E?: number;
  T?: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface AsterSpotTrade {
  id: number;
  price: string;
  qty: string;
  baseQty?: string;
  quoteQty?: string;
  time: number;
  isBuyerMaker: boolean;
}

export interface AsterSpotHistoricalTrade extends AsterSpotTrade {
  isBestMatch?: boolean;
}

export interface AsterSpotAggTrade {
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
  M?: boolean;
}

export interface AsterSpotKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
}

export interface AsterSpotTicker24h {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  prevClosePrice: string;
  lastPrice: string;
  lastQty: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
  baseAsset?: string;
  quoteAsset?: string;
}

export interface AsterSpotPriceTicker {
  symbol: string;
  price: string;
  time?: number;
}

export interface AsterSpotBookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  time?: number;
}

export interface AsterSpotCommissionRate {
  symbol: string;
  makerCommissionRate: string;
  takerCommissionRate: string;
}

export interface CreateSpotOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  timeInForce?: TimeInForce;
  quantity?: number | string;
  quoteOrderQty?: number | string;
  price?: number | string;
  newClientOrderId?: string;
  stopPrice?: number | string;
  recvWindow?: number;
}

export interface CancelSpotOrderParams {
  symbol: string;
  orderId?: number | string;
  origClientOrderId?: string;
  recvWindow?: number;
}

export interface QuerySpotOrderParams extends CancelSpotOrderParams {}

export interface SpotOpenOrdersParams {
  symbol?: string;
  recvWindow?: number;
  orderIdList?: Array<number | string>;
  origClientOrderIdList?: string[];
}

export interface SpotAllOrdersParams {
  symbol: string;
  orderId?: number;
  startTime?: number;
  endTime?: number;
  limit?: number;
  recvWindow?: number;
}

export interface AsterSpotAccountBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface AsterSpotAccount {
  feeTier: number;
  canTrade: boolean;
  canDeposit: boolean;
  canWithdraw: boolean;
  canBurnAsset?: boolean;
  updateTime: number;
  makerCommission?: string;
  takerCommission?: string;
  buyerCommission?: string;
  sellerCommission?: string;
  balances: AsterSpotAccountBalance[];
}

export interface SpotUserTradesParams {
  symbol?: string;
  orderId?: number;
  startTime?: number;
  endTime?: number;
  fromId?: number;
  limit?: number;
  recvWindow?: number;
}

export interface AsterSpotUserTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: OrderSide;
  price: string;
  qty: string;
  quoteQty?: string;
  commission: string;
  commissionAsset: string;
  time: number;
  counterpartyId?: number;
  maker: boolean;
  buyer: boolean;
}
