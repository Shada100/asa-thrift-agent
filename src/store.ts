import { randomUUID } from 'node:crypto';
import type { Redis } from '@upstash/redis';
import type { Order } from './types.js';

export interface Store {
  getOrder(ref: string): Promise<Order | null>;
  putOrder(o: Order): Promise<void>;
  findActiveOrderByPhone(phone: string): Promise<Order | null>;
  activeHolds(productId?: number): Promise<Order[]>;
  // true for exactly one caller per key. this is what stops double-processing.
  once(key: string, ttlSeconds?: number): Promise<boolean>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T | 'locked'>;
  markRejected(ref: string, reason: string): Promise<void>;
  getRejected(ref: string): Promise<string | null>;
}

const byNewest = (a: Order, b: Order) => b.createdAt.localeCompare(a.createdAt);

function pickForPhone(orders: Order[]): Order | null {
  const sorted = [...orders].sort(byNewest);
  return sorted.find((o) => o.state === 'held') ?? sorted[0] ?? null;
}

export class MemoryStore implements Store {
  private orders = new Map<string, Order>();
  private seen = new Set<string>();
  private locks = new Set<string>();
  private rejected = new Map<string, string>();

  async getOrder(ref: string) {
    const o = this.orders.get(ref);
    return o ? { ...o } : null;
  }

  async putOrder(o: Order) {
    this.orders.set(o.ref, { ...o });
  }

  async findActiveOrderByPhone(phone: string) {
    return pickForPhone([...this.orders.values()].filter((o) => o.customerPhone === phone).map((o) => ({ ...o })));
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

  async withLock<T>(key: string, fn: () => Promise<T>) {
    if (this.locks.has(key)) return 'locked' as const;
    this.locks.add(key);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
    }
  }

  async markRejected(ref: string, reason: string) {
    this.rejected.set(ref, reason);
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
    const refs = await this.redis.lrange<string>(`phone:${phone}`, 0, 19);
    const orders = await Promise.all(refs.map((r) => this.getOrder(r)));
    return pickForPhone(orders.filter((o): o is Order => !!o));
  }

  async activeHolds(productId?: number) {
    const refs = await this.redis.smembers<string[]>('holds');
    const orders = await Promise.all(refs.map((r) => this.getOrder(r)));
    return orders.filter((o): o is Order => !!o && o.state === 'held' && (productId === undefined || o.productId === productId));
  }

  async once(key: string, ttlSeconds = MONTH) {
    return (await this.redis.set(`once:${key}`, 1, { nx: true, ex: ttlSeconds })) === 'OK';
  }

  async withLock<T>(key: string, fn: () => Promise<T>) {
    const token = randomUUID();
    // 10s is far longer than a checkout should take; it only matters if we crash mid-way
    const got = await this.redis.set(`lock:${key}`, token, { nx: true, px: 10_000 });
    if (got !== 'OK') return 'locked' as const;
    try {
      return await fn();
    } finally {
      if ((await this.redis.get(`lock:${key}`)) === token) await this.redis.del(`lock:${key}`);
    }
  }

  async markRejected(ref: string, reason: string) {
    await this.redis.set(`rejected:${ref}`, reason, { ex: MONTH });
  }

  async getRejected(ref: string) {
    return (await this.redis.get<string>(`rejected:${ref}`)) ?? null;
  }
}
