import { describe, expect, it } from 'vitest';
import { PaystackError } from '../src/paystack.js';
import { createShop } from '../src/shop.js';
import { MemoryStore } from '../src/store.js';
import { FakePaystack, testConfig } from './fakes.js';

const START = new Date('2026-10-22T11:00:00.000Z');
const minutes = (n: number) => new Date(START.getTime() + n * 60_000);

async function setup() {
  const paystack = new FakePaystack();
  const store = new MemoryStore();
  const clock = { now: START };
  const shop = createShop({ paystack, store, config: testConfig, now: () => clock.now });
  const jacket = paystack.addProduct({ name: 'Brown corduroy jacket', description: 'size L', price: 1850000 });
  const r = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '08031234567' });
  if (!r.ok) throw new Error('checkout failed in setup');
  const qty = () => paystack.products.get(jacket)!.quantity;
  return { paystack, store, clock, shop, jacket, ref: r.orderRef, qty };
}

describe('checkPayment', () => {
  it('not_found when there is no ref and no phone', async () => {
    const { shop } = await setup();
    expect((await shop.checkPayment({})).state).toBe('not_found');
    expect((await shop.checkPayment({ orderRef: 'ASA-ZZZZZZ' })).state).toBe('not_found');
  });

  it('paid when Paystack says success for the full amount', async () => {
    const { paystack, store, shop, ref, qty } = await setup();
    paystack.pay(ref);
    const r = await shop.checkPayment({ orderRef: ref });
    expect(r).toMatchObject({ state: 'paid', orderRef: ref, item: 'Brown corduroy jacket', amountNaira: 18500 });
    expect((await store.getOrder(ref))?.state).toBe('paid');
    expect(qty()).toBe(0); // already taken off at checkout, not taken off twice
  });

  it('already_confirmed when asked again after paying', async () => {
    const { paystack, shop, ref, qty } = await setup();
    paystack.pay(ref);
    await shop.checkPayment({ orderRef: ref });
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('already_confirmed');
    expect(qty()).toBe(0);
  });

  it('paid twice in parallel only finalises once', async () => {
    const { paystack, shop, ref } = await setup();
    paystack.pay(ref);
    const states = (await Promise.all([shop.checkPayment({ orderRef: ref }), shop.checkPayment({ orderRef: ref })])).map((r) => r.state);
    expect(states.sort()).toEqual(['already_confirmed', 'paid']);
  });

  it('not_yet with the hold time while the transfer has not landed', async () => {
    const { shop, ref } = await setup();
    expect(await shop.checkPayment({ orderRef: ref })).toMatchObject({ state: 'not_yet', holdUntil: '2026-10-22T11:30:00.000Z', holdUntilLagos: '12:30pm' });
  });

  it('never trusts the customer: no Paystack success, no sale', async () => {
    const { paystack, store, shop, ref } = await setup();
    for (const s of ['ongoing', 'pending', 'processing', 'queued', 'abandoned', 'pending_bank_transfer', 'something_new']) {
      paystack.setStatus(ref, s);
      expect((await shop.checkPayment({ orderRef: ref })).state).toBe('not_yet');
    }
    expect((await store.getOrder(ref))?.state).toBe('held');
  });

  it('expired after the hold runs out, and the stock goes back once', async () => {
    const { clock, shop, ref, qty } = await setup();
    clock.now = minutes(31);
    expect(await shop.checkPayment({ orderRef: ref })).toMatchObject({ state: 'expired', itemStillAvailable: true });
    expect(qty()).toBe(1);
    await shop.checkPayment({ orderRef: ref });
    expect(qty()).toBe(1);
  });

  it('release adds one to the current quantity, not an old number', async () => {
    const { paystack, clock, shop, jacket, ref, qty } = await setup();
    paystack.products.get(jacket)!.quantity = 3; // owner restocked by hand during the hold
    clock.now = minutes(31);
    await shop.checkPayment({ orderRef: ref });
    expect(qty()).toBe(4);
  });

  it('rejected_wrong_amount when Paystack bounced the transfer', async () => {
    const { store, shop, ref } = await setup();
    await store.markRejected(ref, 'amount did not match', '2026-10-22T11:05:00.000Z');
    expect(await shop.checkPayment({ orderRef: ref })).toMatchObject({ state: 'rejected_wrong_amount', holdUntil: '2026-10-22T11:30:00.000Z' });
  });

  it('spots a bounced transfer from verify even if the webhook never came', async () => {
    const { paystack, shop, ref } = await setup();
    paystack.bounce(ref);
    expect(await shop.checkPayment({ orderRef: ref })).toMatchObject({ state: 'rejected_wrong_amount', holdUntilLagos: '12:30pm' });
  });

  it('a correct payment after a rejected one still counts', async () => {
    const { paystack, store, shop, ref } = await setup();
    await store.markRejected(ref, 'amount did not match', '2026-10-22T11:05:00.000Z');
    paystack.pay(ref);
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('paid');
  });

  it('needs_owner when Paystack reports less than the order amount', async () => {
    const { paystack, store, shop, ref } = await setup();
    paystack.pay(ref, 1000000);
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('needs_owner');
    expect((await store.getOrder(ref))?.state).toBe('needs_owner');
  });

  it('failed releases the hold', async () => {
    const { paystack, shop, ref, qty } = await setup();
    paystack.setStatus(ref, 'failed');
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('failed');
    expect(qty()).toBe(1);
  });

  it('paid after the hold was released: retakes the unit if it is still there', async () => {
    const { paystack, store, clock, shop, ref, qty } = await setup();
    clock.now = minutes(31);
    await shop.checkPayment({ orderRef: ref });
    paystack.pay(ref);
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('paid');
    expect(qty()).toBe(0);
    expect((await store.getOrder(ref))?.state).toBe('paid');
  });

  it('paid after the hold was released and someone else bought it: needs_owner', async () => {
    const { paystack, store, clock, shop, jacket, ref } = await setup();
    clock.now = minutes(31);
    await shop.checkPayment({ orderRef: ref });
    const other = await shop.startCheckout({ itemId: jacket, customerName: 'Ada', customerPhone: '08099999999' });
    if (!other.ok) throw new Error('second checkout should work');
    paystack.pay(ref);
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('needs_owner');
    expect((await store.getOrder(ref))?.note).toMatch(/refund/i);
  });

  it('unavailable leaves stock and order untouched', async () => {
    const { paystack, store, clock, shop, ref, qty } = await setup();
    paystack.failVerify = new PaystackError('down', 'network');
    clock.now = minutes(31); // even past expiry we don't release blind
    expect((await shop.checkPayment({ orderRef: ref })).state).toBe('unavailable');
    expect(qty()).toBe(0);
    expect((await store.getOrder(ref))?.state).toBe('held');
  });

  it('finds the order by phone when the ref is missing', async () => {
    const { paystack, shop, ref } = await setup();
    paystack.pay(ref);
    expect(await shop.checkPayment({ customerPhone: '+234 803 123 4567' })).toMatchObject({ state: 'paid', orderRef: ref });
  });

  it('accepts a mangled ref', async () => {
    const { shop, ref } = await setup();
    const mangled = ref.toLowerCase().replace('-', ' ');
    expect((await shop.checkPayment({ orderRef: mangled })).orderRef).toBe(ref);
  });
});

describe('cancelCheckout', () => {
  it('releases a held order and puts the stock back', async () => {
    const { store, shop, ref, qty } = await setup();
    expect((await shop.cancelCheckout(ref)).state).toBe('cancelled');
    expect(qty()).toBe(1);
    expect((await store.getOrder(ref))?.state).toBe('released');
  });

  it('will not cancel something Paystack already has the money for', async () => {
    const { paystack, shop, ref, qty } = await setup();
    paystack.pay(ref);
    expect((await shop.cancelCheckout(ref)).state).toBe('paid');
    expect(qty()).toBe(0);
  });

  it('sends a paid order to the owner instead of cancelling', async () => {
    const { paystack, shop, ref } = await setup();
    paystack.pay(ref);
    await shop.checkPayment({ orderRef: ref });
    expect((await shop.cancelCheckout(ref)).state).toBe('needs_owner');
  });
});

describe('sweepExpired', () => {
  it('releases expired holds', async () => {
    const { clock, shop, qty } = await setup();
    clock.now = minutes(31);
    expect(await shop.sweepExpired()).toBe(1);
    expect(qty()).toBe(1);
  });

  it('does not release an order Paystack says is paid, it confirms it', async () => {
    const { paystack, store, clock, shop, ref, qty } = await setup();
    paystack.pay(ref);
    clock.now = minutes(31);
    expect(await shop.sweepExpired()).toBe(0);
    expect(qty()).toBe(0);
    expect((await store.getOrder(ref))?.state).toBe('paid');
  });

  it('leaves live holds alone', async () => {
    const { clock, shop, qty } = await setup();
    clock.now = minutes(10);
    expect(await shop.sweepExpired()).toBe(0);
    expect(qty()).toBe(0);
  });
});
