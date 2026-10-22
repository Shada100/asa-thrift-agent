import { describe, expect, it } from 'vitest';
import { PaystackError } from '../src/paystack.js';
import { createShop } from '../src/shop.js';
import { MemoryStore } from '../src/store.js';
import { FakePaystack, testConfig } from './fakes.js';

const NOW = new Date('2026-10-22T11:00:00.000Z');

function setup() {
  const paystack = new FakePaystack();
  const store = new MemoryStore();
  const shop = createShop({ paystack, store, config: testConfig, now: () => NOW });
  const jacket = paystack.addProduct({ name: 'Brown corduroy jacket', description: 'Vintage, size L, soft wale', price: 1850000 });
  return { paystack, store, shop, jacket };
}

const tolu = { customerName: 'Tolu', customerPhone: '0803 123 4567' };
const ada = { customerName: 'Ada', customerPhone: '08099999999' };

describe('findItems', () => {
  it('finds by a word in the description and caps at 5', async () => {
    const { paystack, shop } = setup();
    for (let i = 0; i < 7; i++) paystack.addProduct({ name: `Shirt ${i}`, description: 'striped linen', price: 950000 });
    expect((await shop.findItems('corduroy'))[0].name).toBe('Brown corduroy jacket');
    expect(await shop.findItems('linen')).toHaveLength(5);
  });

  it('ignores filler words and ranks the closest match first', async () => {
    const { paystack, shop } = setup();
    paystack.addProduct({ name: 'Black leather biker jacket', description: 'size M', price: 4200000 });
    const found = await shop.findItems('abeg is the brown corduroy jacket still available?');
    expect(found.map((i) => i.name)).toEqual(['Brown corduroy jacket', 'Black leather biker jacket']);
  });

  it('shows prices in naira', async () => {
    const { shop } = setup();
    expect((await shop.findItems('jacket'))[0].priceNaira).toBe(18500);
  });

  it('shows a held item as held with heldUntil, and a zero-stock unheld item as sold', async () => {
    const { paystack, shop } = setup();
    const skirt = paystack.addProduct({ name: 'Pleated tennis skirt', price: 800000 });
    await shop.startCheckout({ itemId: skirt, ...tolu });
    const bag = paystack.addProduct({ name: 'Leather tote bag', price: 1600000, quantity: 0 });
    const [s] = await shop.findItems('skirt');
    expect(s.status).toBe('held');
    expect(s.heldUntil).toBe('2026-10-22T11:30:00.000Z');
    expect((await shop.findItems('tote'))[0]).toMatchObject({ id: bag, status: 'sold' });
  });

  it('skips products the owner has switched off', async () => {
    const { paystack, shop } = setup();
    paystack.addProduct({ name: 'Hidden jacket', price: 100000, active: false });
    expect((await shop.findItems('jacket')).map((i) => i.name)).toEqual(['Brown corduroy jacket']);
  });
});

describe('startCheckout', () => {
  it('freezes the live price and reduces Paystack quantity by one', async () => {
    const { paystack, shop, jacket } = setup();
    const r = await shop.startCheckout({ itemId: jacket, ...tolu });
    paystack.products.get(jacket)!.price = 2500000; // owner edits the price afterwards
    expect(r).toMatchObject({ ok: true, amountNaira: 18500, bankName: 'Test Bank', reused: false, expiresAt: '2026-10-22T11:30:00.000Z', expiresAtLagos: '12:30pm' });
    expect(paystack.products.get(jacket)!.quantity).toBe(0);
    const charge = [...paystack.charges.values()][0];
    expect(charge.amountKobo).toBe(1850000);
    expect(charge.email).toMatch(/^asa-[a-z0-9]{6}@example\.com$/);
    expect(charge.metadata).toMatchObject({ product_id: jacket, customer_name: 'Tolu', customer_phone: '+2348031234567' });
  });

  it('saves the order as held with the normalised phone', async () => {
    const { store, shop, jacket } = setup();
    const r = await shop.startCheckout({ itemId: jacket, ...tolu });
    if (!r.ok) throw new Error('expected ok');
    expect(await store.getOrder(r.orderRef)).toMatchObject({ state: 'held', customerPhone: '+2348031234567', amountKobo: 1850000 });
  });

  it('returns the same account when the same phone asks twice', async () => {
    const { paystack, shop, jacket } = setup();
    const first = await shop.startCheckout({ itemId: jacket, ...tolu });
    const second = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '+2348031234567' });
    expect(second).toMatchObject({ ok: true, reused: true });
    if (first.ok && second.ok) expect(second.accountNumber).toBe(first.accountNumber);
    expect(paystack.chargeCalls).toBe(1);
  });

  it('turns away a second customer while the item is held', async () => {
    const { paystack, shop, jacket } = setup();
    paystack.addProduct({ name: 'Vintage Nike windbreaker', price: 2700000 });
    await shop.startCheckout({ itemId: jacket, ...tolu });
    const r = await shop.startCheckout({ itemId: jacket, ...ada });
    expect(r).toMatchObject({ ok: false, reason: 'held_by_someone_else' });
    if (!r.ok) expect(r.alternatives?.map((i) => i.name)).toEqual(['Vintage Nike windbreaker']);
  });

  it('says sold when stock is gone and nobody holds it', async () => {
    const { paystack, shop, jacket } = setup();
    paystack.products.get(jacket)!.quantity = 0;
    expect(await shop.startCheckout({ itemId: jacket, ...tolu })).toMatchObject({ ok: false, reason: 'sold' });
  });

  it('last unit, two customers at once: only one gets an account number', async () => {
    const { paystack, shop, jacket } = setup();
    const results = await Promise.all([
      shop.startCheckout({ itemId: jacket, ...tolu }),
      shop.startCheckout({ itemId: jacket, ...ada }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'held_by_someone_else')).toHaveLength(1);
    expect(paystack.chargeCalls).toBe(1);
    expect(paystack.products.get(jacket)!.quantity).toBe(0);
  });

  it('a charge failure puts the stock back and reports payment_unavailable', async () => {
    const { paystack, store, shop, jacket } = setup();
    paystack.failNextCharge = new PaystackError('Paystack returned 500', 'api', 500);
    const r = await shop.startCheckout({ itemId: jacket, ...tolu });
    expect(r).toMatchObject({ ok: false, reason: 'payment_unavailable' });
    expect(paystack.products.get(jacket)!.quantity).toBe(1);
    expect(await store.activeHolds()).toHaveLength(0);
  });

  it('a charge timeout is not retried', async () => {
    const { paystack, shop, jacket } = setup();
    paystack.failNextCharge = new PaystackError('slow', 'timeout');
    const r = await shop.startCheckout({ itemId: jacket, ...tolu });
    expect(r).toMatchObject({ ok: false, reason: 'payment_unavailable' });
    expect(paystack.chargeCalls).toBe(1);
  });

  it('Paystack down before anything changed: payment_unavailable, nothing touched', async () => {
    const { paystack, shop, jacket } = setup();
    paystack.failProducts = new PaystackError('down', 'network');
    expect(await shop.startCheckout({ itemId: jacket, ...tolu })).toMatchObject({ ok: false, reason: 'payment_unavailable' });
    expect(paystack.chargeCalls).toBe(0);
    paystack.failProducts = null;
    expect(paystack.products.get(jacket)!.quantity).toBe(1);
  });

  it('rejects a bad phone number before holding anything', async () => {
    const { paystack, shop, jacket } = setup();
    const r = await shop.startCheckout({ itemId: jacket, customerName: 'Tolu', customerPhone: '12345' });
    expect(r).toMatchObject({ ok: false, reason: 'bad_phone' });
    expect(paystack.chargeCalls).toBe(0);
    expect(paystack.products.get(jacket)!.quantity).toBe(1);
  });

  it('says not_found for an item id that does not exist', async () => {
    const { shop } = setup();
    expect(await shop.startCheckout({ itemId: 999, ...tolu })).toMatchObject({ ok: false, reason: 'not_found' });
  });
});
