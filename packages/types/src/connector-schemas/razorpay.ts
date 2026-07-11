/** Razorpay connector type schemas */

/** Trigger: payment.captured webhook payload */
export interface RazorpayPaymentCapturedPayload {
  entity: 'event';
  account_id: string;
  event: 'payment.captured';
  contains: ['payment'];
  payload: {
    payment: {
      entity: {
        id: string;
        amount: number;      // in paise (smallest currency unit)
        currency: string;
        status: string;
        order_id: string | null;
        email: string;
        contact: string;
        created_at: number;
      };
    };
  };
}

/** Action: create payment link */
export interface RazorpayCreatePaymentInput {
  amount: number;     // in paise
  currency: string;   // e.g. 'INR'
  description?: string;
}

export interface RazorpayCreatePaymentOutput {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
}
