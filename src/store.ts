import { randomUUID } from 'node:crypto';
import type { Redis } from '@upstash/redis';
import type { Order } from './types.js';

export interface Store {
  getOrder(ref: string): Promise<Order | null>;
  putOrder(o: Order): Promise<void>;
  findActiveOrderByPhone(phone: string): Promise<Order | null>;
  ordersByPhone(phone: string): Promise<Order[]>; // newest first
  activeHolds(productId?: number): Promise<Order[]>;
  // true for exactly one caller per key. this is what stops double-processing.
  once(key: string, ttlSeconds?: number): Promise<boolean>;
  // waits its turn (up to waitMs) rather than failing straight away
  withLock<T>(key: string, fn: () => Promise<T>, opts?: LockOptions): Promise<T | 'locked'>;
  markRejected(ref: string, reason: string, at: string): Promise<void>;
  getRejected(ref: string): Promise<Rejection | null>;
}

export interface LockOptions {
  waitMs?: number;
}

export interface Rejection {
  reason: string;
  at?: string;
}

const DEFAULT_WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const byNewest = (a: Order, b: Order) => b.createdAt.localeCompare(a.createdAt);

function pickForPhone(orders: Order[]): Order | null {
  const sorted = [...orders].sort(byNewest);
  return sorted.find((o) => o.state === 'held') ?? sorted[0] ?? null;
}

export class MemoryStore implements Store {
  private orders = new Map<string, Order>();
  private seen = new Set<string>();
  private locks = new Set<string>();
  private rejected = new Map<string, Rejection>();

  async getOrder(ref: string) {
    const o = this.orders.get(ref);
    return o ? { ...o } : null;
  }

  async putOrder(o: Order) {
    this.orders.set(o.ref, { ...o });
  }

  async findActiveOrderByPhone(phone: string) {
    return pickForPhone(await this.ordersByPhone(phone));
  }

  async ordersByPhone(phone: string) {
    return [...this.orders.values()].filter((o) => o.customerPhone === phone).map((o) => ({ ...o })).sort(byNewest);
  }

  async activeHolds(productId?: number) {
    return [...this.orders.values()]
      .filter((o) => o.state === 'held' && (productId === undefined || o.productId === productId))
      .map((o) => ({ ...o }));
  }

  async once(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  async withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}) {
    const giveUpAt = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
    while (this.locks.has(key)) {
      if (Date.now() > giveUpAt) return 'locked' as const;
      await sleep(2);
    }
    this.locks.add(key);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
    }
  }

  async markRejected(ref: string, reason: string, at: string) {
    this.rejected.set(ref, { reason, at });
  }

  async getRejected(ref: string) {
    return this.rejected.get(ref) ?? null;
  }
}

const MONTH = 60 * 60 * 24 * 30;

export class RedisStore implements Store {
  constructor(private redis: Redis) {}

  async getOrder(ref: string) {
    return (await this.redis.get<Order>(`order:${ref}`)) ?? null;
  }

  async putOrder(o: Order) {
    const existing = await this.redis.get<Order>(`order:${o.ref}`);
    await this.redis.set(`order:${o.ref}`, o, { ex: MONTH });
    if (!existing) await this.redis.lpush(`phone:${o.customerPhone}`, o.ref);
    if (o.state === 'held') await this.redis.sadd('holds', o.ref);
    else await this.redis.srem('holds', o.ref);
  }

  async findActiveOrderByPhone(phone: string) {
    return pickForPhone(await this.ordersByPhone(phone));
  }

  async ordersByPhone(phone: string) {
    const refs = await this.redis.lrange<string>(`phone:${phone}`, 0, 19);
    const orders = await Promise.all(refs.map((r) => this.getOrder(r)));
    return orders.filter((o): o is Order => !!o).sort(byNewest);
  }

  async activeHolds(productId?: number) {
    const refs = await this.redis.smembers<string[]>('holds');
    const orders = await Promise.all(refs.map((r) => this.getOrder(r)));
    return orders.filter((o): o is Order => !!o && o.state === 'held' && (productId === undefined || o.productId === productId));
  }

  async once(key: string, ttlSeconds = MONTH) {
    return (await this.redis.set(`once:${key}`, 1, { nx: true, ex: ttlSeconds })) === 'OK';
  }

  async withLock<T>(key: string, fn: () => Promise<T>, opts: LockOptions = {}) {
    const token = randomUUID();
    const giveUpAt = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
    let backoff = 50;
    // ttl has to outlast the slowest checkout: three paystack calls at 8s each, a retry,
    // and a put-back. 60s covers that; it only matters if we die holding the lock.
    while ((await this.redis.set(`lock:${key}`, token, { nx: true, px: 60_000 })) !== 'OK') {
      if (Date.now() > giveUpAt) return 'locked' as const;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 500);
    }
    try {
      return await fn();
    } finally {
      if ((await this.redis.get(`lock:${key}`)) === token) await this.redis.del(`lock:${key}`);
    }
  }

  async markRejected(ref: string, reason: string, at: string) {
    await this.redis.set(`rejected:${ref}`, { reason, at }, { ex: MONTH });
  }

  async getRejected(ref: string) {
    const v = await this.redis.get<Rejection | string>(`rejected:${ref}`);
    // early records were plain strings
    return typeof v === 'string' ? { reason: v } : (v ?? null);
  }
}
