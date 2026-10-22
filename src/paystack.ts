import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE = 'https://api.paystack.co';

export type PaystackErrorKind = 'timeout' | 'network' | 'api' | 'not_found';

export class PaystackError extends Error {
  constructor(
    message: string,
    public kind: PaystackErrorKind,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = 'PaystackError';
  }
}

export interface PsProduct {
  id: number;
  product_code: string;
  name: string;
  description: string;
  price: number;
  quantity: number;
  unlimited: boolean;
  in_stock: boolean;
  active: boolean;
}

export interface PsTransferCharge {
  reference: string;
  status: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  expiresAt: string;
  amountKobo: number;
}

export interface PsVerify {
  status: string;
  amountKobo: number;
  requestedAmountKobo?: number;
  gatewayResponse?: string;
  paidAt?: string;
}

export interface TransferChargeArgs {
  reference: string;
  email: string;
  amountKobo: number;
  expiresAt: string;
  metadata: Record<string, unknown>;
}

export interface Paystack {
  listProducts(): Promise<PsProduct[]>;
  getProduct(id: number): Promise<PsProduct>;
  setQuantity(id: number, quantity: number): Promise<PsProduct>;
  createTransferCharge(a: TransferChargeArgs): Promise<PsTransferCharge>;
  verify(reference: string): Promise<PsVerify>;
}

interface Options {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createPaystack(secret: string, opts: Options = {}): Paystack {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;

  async function once(method: string, path: string, body?: unknown) {
    let res: Response;
    try {
      res = await doFetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new PaystackError(`Paystack took longer than ${timeoutMs}ms`, 'timeout');
      }
      throw new PaystackError(`Could not reach Paystack: ${(err as Error)?.message}`, 'network');
    }

    const payload = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: any } | null;
    if (res.status === 404) throw new PaystackError(payload?.message ?? 'Not found', 'not_found', 404);
    if (!res.ok || !payload?.status) {
      throw new PaystackError(payload?.message ?? `Paystack returned ${res.status}`, 'api', res.status);
    }
    return payload.data;
  }

  // reads are safe to repeat, so one retry on a flaky network. writes are not.
  async function get(path: string) {
    try {
      return await once('GET', path);
    } catch (err) {
      if (err instanceof PaystackError && err.kind === 'network') return once('GET', path);
      throw err;
    }
  }

  return {
    async listProducts() {
      return ((await get('/product?perPage=100')) ?? []) as PsProduct[];
    },

    async getProduct(id) {
      return (await get(`/product/${id}`)) as PsProduct;
    },

    async setQuantity(id, quantity) {
      return (await once('PUT', `/product/${id}`, { quantity })) as PsProduct;
    },

    async createTransferCharge(a) {
      // no retry here on purpose: a timeout doesn't mean the charge wasn't created,
      // and a second attempt could hand the customer two different account numbers
      const d = await once('POST', '/charge', {
        email: a.email,
        amount: String(a.amountKobo),
        reference: a.reference,
        bank_transfer: { account_expires_at: a.expiresAt },
        metadata: a.metadata,
      });
      if (!d?.account_number || !d?.bank?.name) {
        throw new PaystackError('Charge came back without account details', 'api');
      }
      return {
        reference: d.reference,
        status: d.status,
        accountNumber: String(d.account_number),
        accountName: d.account_name,
        bankName: d.bank.name,
        expiresAt: d.account_expires_at,
        amountKobo: Number(d.amount ?? a.amountKobo),
      };
    },

    async verify(reference) {
      const d = await get(`/transaction/verify/${encodeURIComponent(reference)}`);
      // the top-level status only says the API call worked, data.status is the payment
      return {
        status: String(d?.status ?? ''),
        amountKobo: Number(d?.amount ?? 0),
        requestedAmountKobo: d?.requested_amount == null ? undefined : Number(d.requested_amount),
        gatewayResponse: d?.gateway_response ?? undefined,
        paidAt: d?.paid_at ?? undefined,
      };
    },
  };
}

export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
