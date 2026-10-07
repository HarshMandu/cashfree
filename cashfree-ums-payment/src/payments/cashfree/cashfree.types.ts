export interface CashfreeCreateOrderRequest {
  order_id: string;
  order_amount: number;
  order_currency: string;
  customer_details: {
    customer_id: string;
    customer_phone: string;
    customer_email?: string;
  };
}

export interface CashfreeCreateOrderResponse {
  cf_order_id: string;
  order_id: string;
  order_status: string;
  payment_session_id: string;
}

export interface CashfreeOrderResponse {
  order_id: string;
  order_status: string;
}
