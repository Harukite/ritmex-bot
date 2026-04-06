export interface GrvtOrderLeg {
  instrument: string;
  size: string;
  limit_price?: string;
  is_buying_asset?: boolean;
}

export type GrvtTimeInForce =
  | "GOOD_TILL_TIME"
  | "ALL_OR_NONE"
  | "IMMEDIATE_OR_CANCEL"
  | "FILL_OR_KILL";

export interface GrvtOrderMetadata {
  client_order_id?: string;
  create_time?: string;
  broker?: string | null;
  trigger?: GrvtTriggerMetadata;
}

export interface GrvtOrderState {
  status?: string;
  reject_reason?: string | null;
  book_size?: string[];
  traded_size?: string[];
  update_time?: string;
  avg_fill_price?: string[];
}

export interface GrvtOrder {
  order_id: string;
  client_order_id?: string;
  sub_account_id?: string;
  is_market?: boolean;
  time_in_force?: GrvtTimeInForce;
  post_only?: boolean;
  reduce_only?: boolean;
  legs?: GrvtOrderLeg[];
  metadata?: GrvtOrderMetadata;
  state?: GrvtOrderState;
  instrument?: string;
}

export interface GrvtTrade {
  price: string;
  size: string;
  taker_side: "BUY" | "SELL";
  timestamp: string;
}

export interface GrvtTradeHistoryResponse {
  result?: GrvtTrade[];
}

export interface GrvtWebsocketMessage<T> {
  stream: string;
  selector: string;
  sequence_number?: string;
  feed: T;
}

export interface GrvtOrderUpdateFeed {
  order_id: string;
  client_order_id?: string;
  sub_account_id?: string;
  state?: GrvtOrderState;
  traded_size?: string[];
  update_time?: string;
}

export interface GrvtPositionUpdateFeed {
  instrument: string;
  size: string;
  entry_price?: string;
  mark_price?: string;
  unrealized_pnl?: string;
  sub_account_id?: string;
  update_time?: string;
}

export interface GrvtDepthUpdateFeed {
  instrument: string;
  bids: GrvtDepthLevel[];
  asks: GrvtDepthLevel[];
  event_time?: string;
}

export interface GrvtTickerUpdateFeed {
  instrument: string;
  mark_price?: string;
  last_trade_price?: string;
  best_bid_price?: string;
  best_ask_price?: string;
  volume_24h?: string;
}

export interface GrvtOpenOrdersResponse {
  result?: GrvtOrder[];
}

export interface GrvtPositionsResponse {
  result?: GrvtPosition[];
}

export interface GrvtPosition {
  instrument: string;
  size: string;
  entry_price?: string;
  mark_price?: string;
  unrealized_pnl?: string;
}

export interface GrvtAccountSnapshot {
  total_unrealized_pnl?: string;
  positions: GrvtPosition[];
  settle_currency?: string;
  available_balance?: string;
}

export interface GrvtBalancesResponse {
  result?: {
    total_unrealized_pnl?: string;
    positions?: GrvtPosition[];
  };
}

export interface GrvtDepthLevel {
  price: string;
  size: string;
}

export interface GrvtDepth {
  instrument: string;
  event_time?: string;
  bids: GrvtDepthLevel[];
  asks: GrvtDepthLevel[];
}

export interface GrvtTicker {
  instrument: string;
  mark_price?: string;
  last_trade_price?: string;
  best_bid_price?: string;
  best_ask_price?: string;
  volume_24h?: string;
}

export interface GrvtKline {
  open_time: number;
  close_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  number_of_trades?: number;
}

export interface GrvtSignature {
  signer: string;
  r: string;
  s: string;
  v: number;
  expiration: string;
  nonce: number;
}

export interface GrvtUnsignedOrderLeg {
  instrument: string;
  size: string;
  limit_price?: string;
  is_buying_asset: boolean;
}

export interface GrvtTriggerMetadata {
  trigger_type: "UNSPECIFIED" | "TAKE_PROFIT" | "STOP_LOSS";
  tpsl: {
    trigger_by: "UNSPECIFIED" | "INDEX" | "LAST" | "MID" | "MARK";
    trigger_price: string;
    close_position: boolean;
  };
}

export interface GrvtOrderMetadataInput {
  client_order_id: string;
  trigger?: GrvtTriggerMetadata;
  broker?: string | null;
}

export interface GrvtUnsignedOrder {
  sub_account_id: string;
  is_market: boolean;
  time_in_force: GrvtTimeInForce;
  post_only: boolean;
  reduce_only: boolean;
  legs: GrvtUnsignedOrderLeg[];
  metadata: GrvtOrderMetadataInput;
}

export interface GrvtSignedOrder extends GrvtUnsignedOrder {
  signature: GrvtSignature;
}
