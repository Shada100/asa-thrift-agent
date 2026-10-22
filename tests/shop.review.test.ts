import { describe, expect, it } from 'vitest';
import { createShop } from '../src/shop.js';
import { MemoryStore } from '../src/store.js';
import { FakePaystack, testConfig } from './fakes.js';

const NOW = new Date('2026-10-22T11:00:00.000Z');

function setup() {
  const paystack = new FakePaystack();
  const store = new MemoryStore();
  // a minute passes between calls, so "newest" means something
  let tick = 0;
  const shop = createShop({ paystack, store, config: testConfig, now: () => new Date(NOW.getTime() + tick++ * 60_000) });
  return { paystack, store, shop };
}

describe('customer with two things on hold', () => {
  it('"I\'ve paid" by phone finds the one that is actually paid, not just the newest', async () => {
    const { paystack, shop } = setup();
    const jacket = paystack.addProduct({ name: 'Brown corduroy jacket', price: 1850000 });
    const bag = paystack.addProduct({ name: 'Brown leather tote bag', price: 1600000 });
    const first = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '08031234567' });
    const second = await shop.startCheckout({ itemId: bag, customerName: 'Tolu', customerPhone: '08031234567' });
    if (!first.ok || !second.ok) throw new Error('setup');
    paystack.pay(first.orderRef); // paid for the jacket, the older hold
    expect(await shop.checkPayment({ customerPhone: '08031234567' })).toMatchObject({ state: 'paid', orderRef: first.orderRef });
  });

  it('when neither is paid, it says so and lists the other open order', async () => {
    const { paystack, shop } = setup();
    const jacket = paystack.addProduct({ name: 'Brown corduroy jacket', price: 1850000 });
    const bag = paystack.addProduct({ name: 'Brown leather tote bag', price: 1600000 });
    const first = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '08031234567' });
    await shop.startCheckout({ itemId: bag, customerName: 'Tolu', customerPhone: '08031234567' });
    const r = await shop.checkPayment({ customerPhone: '08031234567' });
    expect(r.state).toBe('not_yet');
    if (first.ok) expect(r.otherOpenOrders).toEqual([{ orderRef: first.orderRef, item: 'Brown corduroy jacket' }]);
  });
});

describe('an old bounce', () => {
  it('says when it bounced and warns not to send the money twice', async () => {
    const { paystack, store, shop } = setup();
    const jacket = paystack.addProduct({ name: 'Brown corduroy jacket', price: 1850000 });
    const co = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '08031234567' });
    if (!co.ok) throw new Error('setup');
    await store.markRejected(co.orderRef, 'incorrect amount sent', '2026-10-22T11:05:00.000Z');
    const r = await shop.checkPayment({ orderRef: co.orderRef });
    expect(r).toMatchObject({ state: 'rejected_wrong_amount', bouncedAtLagos: '12:05pm' });
    expect(r.message).toMatch(/not to send it again/);
  });
});

describe('plurals', () => {
  it('"any dresses?" finds the dress, "jeans" finds the jeans', async () => {
    const { paystack, shop } = setup();
    paystack.addProduct({ name: 'Adire maxi dress', description: 'Size M, indigo, cotton', price: 2150000 });
    paystack.addProduct({ name: "Levi's 501 jeans", description: 'W32 L32, mid-wash', price: 1500000 });
    paystack.addProduct({ name: 'Brown leather tote bag', description: 'Large', price: 1600000 });
    expect((await shop.findItems('any dresses?')).map((i) => i.name)).toEqual(['Adire maxi dress']);
    expect((await shop.findItems('do you have jeans')).map((i) => i.name)).toEqual(["Levi's 501 jeans"]);
    expect((await shop.findItems('bags')).map((i) => i.name)).toEqual(['Brown leather tote bag']);
  });
});
