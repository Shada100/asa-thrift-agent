import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http.js';
import { createShop } from '../src/shop.js';
import { MemoryStore } from '../src/store.js';
import { FakePaystack, testConfig } from './fakes.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start() {
  const paystack = new FakePaystack();
  const jacket = paystack.addProduct({ name: 'Brown corduroy jacket', price: 1850000 });
  const store = new MemoryStore();
  const shop = createShop({ paystack, store, config: testConfig });
  const co = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '08031234567' });
  if (!co.ok) throw new Error('setup checkout failed');
  const app = createApp({ shop, store, config: testConfig });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { paystack, store, shop, base, co };
}

function post(base: string, event: unknown, signature?: string) {
  const body = JSON.stringify(event);
  const sig = signature ?? createHmac('sha512', testConfig.paystackSecret).update(body).digest('hex');
  return fetch(`${base}/paystack/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': sig },
    body,
  });
}

describe('paystack webhook', () => {
  it('a bad signature is 401 and changes nothing', async () => {
    const { paystack, store, base, co } = await start();
    paystack.pay(co.orderRef);
    const res = await post(base, { event: 'charge.success', data: { id: 1, reference: co.orderRef } }, 'nope');
    expect(res.status).toBe(401);
    expect((await store.getOrder(co.orderRef))?.state).toBe('held');
  });

  it('charge.success confirms the order through Paystack verify', async () => {
    const { paystack, store, base, co } = await start();
    paystack.pay(co.orderRef);
    expect((await post(base, { event: 'charge.success', data: { id: 1, reference: co.orderRef } })).status).toBe(200);
    expect((await store.getOrder(co.orderRef))?.state).toBe('paid');
  });

  it('a forged charge.success with a good signature still cannot mark unpaid orders sold', async () => {
    // belt and braces: we re-verify with Paystack instead of trusting the event body
    const { store, base, co } = await start();
    await post(base, { event: 'charge.success', data: { id: 1, reference: co.orderRef, status: 'success' } });
    expect((await store.getOrder(co.orderRef))?.state).toBe('held');
  });

  it('the same charge.success twice finalises once', async () => {
    const { paystack, shop, base, co } = await start();
    paystack.pay(co.orderRef);
    const evt = { event: 'charge.success', data: { id: 77, reference: co.orderRef } };
    await post(base, evt);
    await post(base, evt);
    expect((await shop.checkPayment({ orderRef: co.orderRef })).state).toBe('already_confirmed');
  });

  it('bank.transfer.rejected marks the order so check_payment says rejected_wrong_amount', async () => {
    const { shop, base, co } = await start();
    expect((await post(base, { event: 'bank.transfer.rejected', data: { id: 9, reference: co.orderRef, reason: 'amount mismatch' } })).status).toBe(200);
    expect((await shop.checkPayment({ orderRef: co.orderRef })).state).toBe('rejected_wrong_amount');
  });

  it('bank.transfer.rejected without our reference is matched by account number', async () => {
    const { shop, base, co } = await start();
    if (!co.ok) return;
    await post(base, { event: 'bank.transfer.rejected', data: { id: 10, account_number: co.accountNumber } });
    expect((await shop.checkPayment({ orderRef: co.orderRef })).state).toBe('rejected_wrong_amount');
  });

  it('an unknown event is 200 and does nothing', async () => {
    const { store, base, co } = await start();
    expect((await post(base, { event: 'subscription.create', data: { id: 3 } })).status).toBe(200);
    expect((await store.getOrder(co.orderRef))?.state).toBe('held');
  });

  // captured from Paystack test mode on 22 Oct: the ref lives under data.bank_transfer and there's no data.id
  it('handles the real bank.transfer.rejected shape', async () => {
    const { shop, base, co } = await start();
    const real = {
      event: 'bank.transfer.rejected',
      data: {
        bank_transfer: { amount: '1000000', message: 'incorrect amount sent', message_type: 'INCORRECT_AMOUNT', transaction_id: '6684511155', reference: co.orderRef },
        customer: { email: `${co.orderRef.toLowerCase()}@example.com`, domain: 'test' },
      },
    };
    expect((await post(base, real)).status).toBe(200);
    expect((await shop.checkPayment({ orderRef: co.orderRef })).state).toBe('rejected_wrong_amount');
  });

  it('two different rejections with no data.id are not mistaken for duplicates', async () => {
    const { store, base, co } = await start();
    const evt = (txn: string) => ({
      event: 'bank.transfer.rejected',
      data: { bank_transfer: { amount: '1000000', message: 'incorrect amount sent', transaction_id: txn, reference: 'ASA-ZZZZZZ' } },
    });
    await post(base, evt('1111111111'));
    // same length body, different transfer, must still be processed
    await post(base, { ...evt('2222222222'), data: { bank_transfer: { ...evt('2222222222').data.bank_transfer, reference: co.orderRef } } });
    expect(await store.getRejected(co.orderRef)).toMatchObject({ reason: 'incorrect amount sent' });
  });
});
