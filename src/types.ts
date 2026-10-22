export type ItemStatus = 'available' | 'held' | 'sold';

export interface Item {
  id: number;
  code: string;
  name: string;
  description: string;
  priceNaira: number;
  status: ItemStatus;
  heldUntil?: string;
  heldUntilLagos?: string;
}

export type OrderState = 'held' | 'paid' | 'released' | 'needs_owner';

export interface Order {
  ref: string;
  productId: number;
  productName: string;
  amountKobo: number;
  customerName: string;
  customerPhone: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  expiresAt: string;
  state: OrderState;
  createdAt: string;
  note?: string;
  // when and why the hold ended, so a repeat question gets the real history back
  releasedAt?: string;
  releaseReason?: 'cancelled' | 'expired' | 'failed';
}

export type CheckoutResult =
  | {
      ok: true;
      orderRef: string;
      item: string;
      amountNaira: number;
      bankName: string;
      accountNumber: string;
      accountName: string;
      expiresAt: string;
      expiresAtLagos: string;
      reused: boolean;
    }
  | {
      ok: false;
      reason: 'not_found' | 'sold' | 'held_by_someone_else' | 'payment_unavailable' | 'bad_phone';
      message: string;
      alternatives?: Item[];
    };

export type PaymentState =
  | 'paid'
  | 'already_confirmed'
  | 'not_yet'
  | 'rejected_wrong_amount'
  | 'expired'
  | 'failed'
  | 'needs_owner'
  | 'cancelled'
  | 'not_found'
  | 'unavailable';

export interface PaymentResult {
  state: PaymentState;
  orderRef?: string;
  item?: string;
  amountNaira?: number;
  holdUntil?: string;
  holdUntilLagos?: string;
  itemStillAvailable?: boolean;
  bouncedAtLagos?: string;
  alreadyCancelled?: boolean;
  cancelledAtLagos?: string;
  otherOpenOrders?: { orderRef: string; item: string }[];
  message: string;
}
