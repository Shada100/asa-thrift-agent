import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store.js';
import type { Order } from '../src/types.js';

const order = (over: Partial<Order> = {}): Order => ({
  ref: 'ASA-AAAAAA',
  productId: 1,
  productName: 'Brown corduroy jacket',
  amountKobo: 1850000,
  customerName: 'Tolu',
  customerPhone: '+2348031234567',
  bankName: 'Test Bank',
  accountNumber: '1231804286',
  accountName: 'PAYSTACK CHECKOUT',
  expiresAt: '2026-10-22T12:00:00.000Z',
  state: 'held',
  createdAt: '2026-10-22T11:30:00.000Z',
  ...over,
});

describe('MemoryStore', () => {
  it('once returns true then false for the same key', async () => {
    const s = new MemoryStore();
    expect(await s.once('paid:ASA-AAAAAA')).toBe(true);
    expect(await s.once('paid:ASA-AAAAAA')).toBe(false);
    expect(await s.once('paid:ASA-BBBBBB')).toBe(true);
  });

  it('withLock makes a second caller wait its turn', async () => {
    const s = new MemoryStore();
    const order: string[] = [];
    let release!: () => void;
    const first = s.withLock('product:1', () => new Promise<void>((r) => (release = () => { order.push('first'); r(); })));
    const second = s.withLock('product:1', async () => { order.push('second'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]); // second is still waiting
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('withLock gives up after waiting too long', async () => {
    const s = new MemoryStore();
    const hog = s.withLock('k', () => new Promise((r) => setTimeout(r, 200)));
    expect(await s.withLock('k', async () => 'never', { waitMs: 30 })).toBe('locked');
    await hog;
  });

  it('withLock releases even when the work throws', async () => {
    const s = new MemoryStore();
    await expect(s.withLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await s.withLock('k', async () => 'ok')).toBe('ok');
  });

  it('findActiveOrderByPhone prefers the newest held order', async () => {
    const s = new MemoryStore();
    await s.putOrder(order({ ref: 'ASA-OLDOLD', createdAt: '2026-10-22T10:00:00.000Z' }));
    await s.putOrder(order({ ref: 'ASA-NEWNEW', createdAt: '2026-10-22T11:00:00.000Z' }));
    await s.putOrder(order({ ref: 'ASA-PAIDPA', createdAt: '2026-10-22T11:30:00.000Z', state: 'paid' }));
    expect((await s.findActiveOrderByPhone('+2348031234567'))?.ref).toBe('ASA-NEWNEW');
  });

  it('findActiveOrderByPhone falls back to the most recent order when none is held', async () => {
    const s = new MemoryStore();
    await s.putOrder(order({ ref: 'ASA-PAIDPA', state: 'paid' }));
    expect((await s.findActiveOrderByPhone('+2348031234567'))?.ref).toBe('ASA-PAIDPA');
    expect(await s.findActiveOrderByPhone('+2348000000000')).toBeNull();
  });

  it('activeHolds filters by product and state', async () => {
    const s = new MemoryStore();
    await s.putOrder(order({ ref: 'ASA-AAAAAA', productId: 1 }));
    await s.putOrder(order({ ref: 'ASA-BBBBBB', productId: 2 }));
    await s.putOrder(order({ ref: 'ASA-CCCCCC', productId: 1, state: 'released' }));
    expect((await s.activeHolds(1)).map((o) => o.ref)).toEqual(['ASA-AAAAAA']);
    expect(await s.activeHolds()).toHaveLength(2);
  });

  it('remembers rejected transfers', async () => {
    const s = new MemoryStore();
    expect(await s.getRejected('ASA-AAAAAA')).toBeNull();
    await s.markRejected('ASA-AAAAAA', 'amount mismatch', '2026-10-22T13:05:00.000Z');
    expect(await s.getRejected('ASA-AAAAAA')).toEqual({ reason: 'amount mismatch', at: '2026-10-22T13:05:00.000Z' });
  });

  it('hands back copies, so callers cannot edit stored orders by accident', async () => {
    const s = new MemoryStore();
    await s.putOrder(order());
    const o = (await s.getOrder('ASA-AAAAAA'))!;
    o.state = 'paid';
    expect((await s.getOrder('ASA-AAAAAA'))?.state).toBe('held');
  });
});
