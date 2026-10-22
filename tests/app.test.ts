import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http.js';
import { createShop, type Shop } from '../src/shop.js';
import { MemoryStore } from '../src/store.js';
import { FakePaystack, testConfig } from './fakes.js';

let server: Server | undefined;

afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(shop?: Shop) {
  const paystack = new FakePaystack();
  paystack.addProduct({ name: 'Brown corduroy jacket', description: 'size L', price: 1850000 });
  const store = new MemoryStore();
  const realShop = shop ?? createShop({ paystack, store, config: testConfig });
  const app = createApp({ shop: realShop, store, config: testConfig });
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, paystack };
}

async function connect(base: string, token = testConfig.mcpToken) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const textOf = (r: any) => JSON.parse(r.content[0].text);

describe('http app', () => {
  it('401 without the bearer token', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    await expect(connect(base, 'wrong')).rejects.toThrow();
  });

  it('health says test mode', async () => {
    const { base } = await start();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, mode: 'test' });
  });

  it('lists exactly the four tools', async () => {
    const { base } = await start();
    const client = await connect(base);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['cancel_checkout', 'check_payment', 'find_items', 'start_checkout']);
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(40);
    await client.close();
  });

  it('find_items round-trips through MCP', async () => {
    const { base } = await start();
    const client = await connect(base);
    const r = await client.callTool({ name: 'find_items', arguments: { query: 'corduroy jacket' } });
    expect(textOf(r).items[0]).toMatchObject({ name: 'Brown corduroy jacket', priceNaira: 18500, status: 'available' });
    await client.close();
  });

  it('a whole checkout and payment check works over MCP', async () => {
    const { base, paystack } = await start();
    const client = await connect(base);
    const co = textOf(
      await client.callTool({ name: 'start_checkout', arguments: { item_id: 1, customer_name: 'Tolu', customer_phone: '08031234567' } }),
    );
    expect(co).toMatchObject({ ok: true, amountNaira: 18500, bankName: 'Test Bank' });
    paystack.pay(co.orderRef);
    const paid = textOf(await client.callTool({ name: 'check_payment', arguments: { order_ref: co.orderRef } }));
    expect(paid.state).toBe('paid');
    await client.close();
  });

  it('a throwing shop becomes a safe unavailable message', async () => {
    const boom = async () => {
      throw new Error('kaboom with sk_test_secret inside');
    };
    const shop = { findItems: boom, startCheckout: boom, checkPayment: boom, cancelCheckout: boom, sweepExpired: boom } as unknown as Shop;
    const { base } = await start(shop);
    const client = await connect(base);
    const r = await client.callTool({ name: 'find_items', arguments: { query: 'x' } });
    const text = JSON.stringify(r);
    expect(textOf(r).state).toBe('unavailable');
    expect(text).not.toMatch(/sk_test|kaboom|at .*\.ts/);
    await client.close();
  });
});
