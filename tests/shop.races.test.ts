import { describe, expect, it } from 'vitest';
import { PaystackError } from '../src/paystack.js';
import { createShop } from '../src/shop.js';
import { MemoryStore } from '../src/store.js';
import { FakePaystack, testConfig } from './fakes.js';

const START = new Date('2026-10-22T11:00:00.000Z');
const later = (min: number) => new Date(START.getTime() + min * 60_000);

function world(quantity = 1) {
  const paystack = new FakePaystack();
  const store = new MemoryStore();
  const clock = { now: START };
  const shop = createShop({ paystack, store, config: testConfig, now: () => clock.now });
  const item = paystack.addProduct({ name: 'Brown corduroy jacket', price: 1850000, quantity });
  const qty = () => paystack.products.get(item)!.quantity;
  return { paystack, store, clock, shop, item, qty };
}

const A = { customerName: 'Tolu', customerPhone: '08031234567' };
const B = { customerName: 'Ada', customerPhone: '08099999999' };

// these found real double-sells in review, so each runs many times with random latency
const RUNS = 40;

describe('races', () => {
  it('a late payment after release and a new checkout never both get the piece', async () => {
    for (let i = 0; i < RUNS; i++) {
      const { paystack, store, clock, shop, item, qty } = world();
      const a = await shop.startCheckout({ itemId: item, ...A });
      if (!a.ok) throw new Error('setup');
      clock.now = later(31);
      await shop.checkPayment({ orderRef: a.orderRef }); // A's hold released
      paystack.pay(a.orderRef); // ...but A's money lands anyway
      paystack.maxDelayMs = 5;
      const [late, b] = await Promise.all([shop.checkPayment({ orderRef: a.orderRef }), shop.startCheckout({ itemId: item, ...B })]);
      const aOwns = late.state === 'paid';
      const bOwns = b.ok;
      expect(aOwns && bOwns, `run ${i}: both A and B got the jacket`).toBe(false);
      expect(qty()).toBeGreaterThanOrEqual(0);
      if (!aOwns) expect((await store.getOrder(a.orderRef))?.state).toBe('needs_owner');
    }
  });

  it('paying right at expiry while someone else browses ends paid and off sale', async () => {
    for (let i = 0; i < RUNS; i++) {
      const { paystack, store, clock, shop, item, qty } = world();
      const a = await shop.startCheckout({ itemId: item, ...A });
      if (!a.ok) throw new Error('setup');
      clock.now = later(30);
      paystack.pay(a.orderRef);
      paystack.maxDelayMs = 5;
      const [mine] = await Promise.all([shop.checkPayment({ orderRef: a.orderRef }), shop.findItems('jacket')]);
      expect(['paid', 'already_confirmed'], `run ${i}`).toContain(mine.state);
      expect((await store.getOrder(a.orderRef))?.state, `run ${i}`).toBe('paid');
      expect(qty(), `run ${i}: paid piece went back on sale`).toBe(0);
    }
  });

  it('a two-unit item never loses or invents a unit under checkout + sweep', async () => {
    for (let i = 0; i < RUNS; i++) {
      const { paystack, store, clock, shop, item, qty } = world(2);
      await shop.startCheckout({ itemId: item, ...A });
      clock.now = later(31); // A's hold is now due for release
      paystack.maxDelayMs = 5;
      await Promise.all([shop.startCheckout({ itemId: item, ...B }), shop.findItems('jacket'), shop.findItems('corduroy')]);
      const held = (await store.activeHolds(item)).length;
      expect(qty() + held, `run ${i}: qty ${qty()} + holds ${held}`).toBe(2);
    }
  });

  it('a check that loses the race to a needs_owner outcome is not told already_confirmed', async () => {
    for (let i = 0; i < RUNS; i++) {
      const { paystack, clock, shop, item } = world();
      const a = await shop.startCheckout({ itemId: item, ...A });
      if (!a.ok) throw new Error('setup');
      clock.now = later(31);
      await shop.checkPayment({ orderRef: a.orderRef });
      await shop.startCheckout({ itemId: item, ...B }); // B takes the jacket
      paystack.pay(a.orderRef); // A pays late
      paystack.maxDelayMs = 5;
      const results = await Promise.all([shop.checkPayment({ orderRef: a.orderRef }), shop.checkPayment({ orderRef: a.orderRef })]);
      for (const r of results) expect(r.state, `run ${i}`).toBe('needs_owner');
    }
  });
});

describe('stock fixes that fail', () => {
  it('if putting stock back fails, the hold stays and a later sweep finishes the job', async () => {
    const { paystack, store, clock, shop, item, qty } = world();
    const a = await shop.startCheckout({ itemId: item, ...A });
    if (!a.ok) throw new Error('setup');
    clock.now = later(31);
    paystack.failNextSetQuantity = new PaystackError('slow', 'timeout');
    await shop.sweepExpired();
    expect(qty()).toBe(0);
    expect((await store.getOrder(a.orderRef))?.state).toBe('held'); // not quietly marked released
    await shop.sweepExpired();
    expect(qty()).toBe(1);
    expect((await store.getOrder(a.orderRef))?.state).toBe('released');
  });

  it('a timed-out stock PUT at checkout that actually landed is recognised, not lost', async () => {
    const { paystack, store, shop, item, qty } = world();
    paystack.applyThenFailNextSetQuantity = new PaystackError('slow', 'timeout');
    const r = await shop.startCheckout({ itemId: item, ...A });
    // the decrement did happen, so the checkout carries on and the books add up
    expect(r.ok).toBe(true);
    expect(qty()).toBe(0);
    expect(await store.activeHolds(item)).toHaveLength(1);
  });

  it('a timed-out stock PUT that did not land is reported, nothing held', async () => {
    const { paystack, store, shop, item, qty } = world();
    paystack.failNextSetQuantity = new PaystackError('slow', 'timeout');
    expect(await shop.startCheckout({ itemId: item, ...A })).toMatchObject({ ok: false, reason: 'payment_unavailable' });
    expect(qty()).toBe(1);
    expect(await store.activeHolds()).toHaveLength(0);
  });

  it('if the charge fails and the stock cannot be put back, a sweep puts it back later', async () => {
    const { paystack, shop, item, qty } = world();
    paystack.failNextCharge = new PaystackError('down', 'api', 500);
    paystack.failNextSetQuantity = null;
    // decrement works, charge fails, then the put-back fails too
    const orig = paystack.setQuantity.bind(paystack);
    let calls = 0;
    paystack.setQuantity = async (id, q) => {
      calls++;
      if (calls === 2) throw new PaystackError('down', 'network');
      return orig(id, q);
    };
    expect((await shop.startCheckout({ itemId: item, ...A })).ok).toBe(false);
    expect(qty()).toBe(0);
    await shop.sweepExpired();
    expect(qty()).toBe(1);
  });
});
