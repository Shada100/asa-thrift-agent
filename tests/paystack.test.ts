import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPaystack, PaystackError, verifyWebhookSignature } from '../src/paystack.js';

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;

function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// trimmed copy of what /charge actually returned in test mode
const chargeResponse = {
  status: true,
  message: 'Charge attempted',
  data: {
    reference: 'ASA-7K2Q9F',
    status: 'pending_bank_transfer',
    display_text: 'Please make a transfer to the account specified',
    account_name: 'PAYSTACK CHECKOUT',
    account_number: '1231804286',
    bank: { slug: 'test-bank', name: 'Test Bank', id: 24 },
    account_expires_at: '2026-10-22T12:13:13.000Z',
    amount: 100000,
  },
};

const chargeArgs = {
  reference: 'ASA-7K2Q9F',
  email: 'asa-7k2q9f@example.com',
  amountKobo: 100000,
  expiresAt: '2026-10-22T12:13:13.000Z',
  metadata: { order_ref: 'ASA-7K2Q9F' },
};

describe('paystack client', () => {
  it('verify reads data.status, not the top-level status', async () => {
    const { fn } = fakeFetch(() => json({ status: true, data: { status: 'ongoing', amount: 100000, requested_amount: 100000 } }));
    const ps = createPaystack('sk_test_x', { fetch: fn });
    const v = await ps.verify('ASA-7K2Q9F');
    expect(v.status).toBe('ongoing');
    expect(v.amountKobo).toBe(100000);
    expect(v.requestedAmountKobo).toBe(100000);
  });

  it('createTransferCharge maps the account fields', async () => {
    const { fn, calls } = fakeFetch(() => json(chargeResponse));
    const ps = createPaystack('sk_test_x', { fetch: fn });
    const c = await ps.createTransferCharge(chargeArgs);
    expect(c).toEqual({
      reference: 'ASA-7K2Q9F',
      status: 'pending_bank_transfer',
      accountNumber: '1231804286',
      accountName: 'PAYSTACK CHECKOUT',
      bankName: 'Test Bank',
      expiresAt: '2026-10-22T12:13:13.000Z',
      amountKobo: 100000,
    });
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.amount).toBe('100000');
    expect(sent.bank_transfer.account_expires_at).toBe(chargeArgs.expiresAt);
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer sk_test_x' });
  });

  it('createTransferCharge throws when the account number is missing', async () => {
    const broken = { ...chargeResponse, data: { ...chargeResponse.data, account_number: undefined } };
    const { fn } = fakeFetch(() => json(broken));
    const ps = createPaystack('sk_test_x', { fetch: fn });
    await expect(ps.createTransferCharge(chargeArgs)).rejects.toMatchObject({ kind: 'api' });
  });

  it('GETs retry once on a network error', async () => {
    let n = 0;
    const { fn, calls } = fakeFetch(() => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return json({ status: true, data: { status: 'success', amount: 100 } });
    });
    const ps = createPaystack('sk_test_x', { fetch: fn });
    await expect(ps.verify('X')).resolves.toMatchObject({ status: 'success' });
    expect(calls).toHaveLength(2);
  });

  it('POST /charge never retries', async () => {
    const { fn, calls } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const ps = createPaystack('sk_test_x', { fetch: fn });
    await expect(ps.createTransferCharge(chargeArgs)).rejects.toMatchObject({ kind: 'network' });
    expect(calls).toHaveLength(1);
  });

  it('gives up after the timeout', async () => {
    const { fn } = fakeFetch(
      (_url, init) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    const ps = createPaystack('sk_test_x', { fetch: fn, timeoutMs: 20 });
    await expect(ps.createTransferCharge(chargeArgs)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('a 404 from verify becomes kind not_found', async () => {
    const { fn } = fakeFetch(() => json({ status: false, message: 'Transaction reference not found' }, 404));
    const ps = createPaystack('sk_test_x', { fetch: fn });
    const err = await ps.verify('NOPE').catch((e) => e);
    expect(err).toBeInstanceOf(PaystackError);
    expect(err.kind).toBe('not_found');
  });

  it('a 400 validation error becomes kind api with the message', async () => {
    const { fn } = fakeFetch(() => json({ status: false, message: '"email" must be a valid email' }, 400));
    const ps = createPaystack('sk_test_x', { fetch: fn });
    await expect(ps.createTransferCharge(chargeArgs)).rejects.toMatchObject({ kind: 'api', httpStatus: 400 });
  });

  it('listProducts and setQuantity talk to the products API', async () => {
    const product = { id: 7, product_code: 'PROD_x', name: 'Brown corduroy jacket', description: 'size L', price: 1850000, quantity: 1, unlimited: false, in_stock: true, active: true };
    const { fn, calls } = fakeFetch((url, init) =>
      init.method === 'PUT' ? json({ status: true, data: { ...product, quantity: 0 } }) : json({ status: true, data: [product] }),
    );
    const ps = createPaystack('sk_test_x', { fetch: fn });
    expect((await ps.listProducts())[0].name).toBe('Brown corduroy jacket');
    expect((await ps.setQuantity(7, 0)).quantity).toBe(0);
    expect(calls[1].url).toMatch(/\/product\/7$/);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ quantity: 0 });
  });
});

describe('webhook signature', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ASA-7K2Q9F' } });
  const good = createHmac('sha512', 'sk_test_x').update(body).digest('hex');

  it('accepts the right HMAC', () => {
    expect(verifyWebhookSignature(body, good, 'sk_test_x')).toBe(true);
  });

  it('rejects a wrong or missing one', () => {
    expect(verifyWebhookSignature(body, good.replace(/.$/, '0'), 'sk_test_x')).toBe(false);
    expect(verifyWebhookSignature(body, 'short', 'sk_test_x')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, 'sk_test_x')).toBe(false);
  });
});
