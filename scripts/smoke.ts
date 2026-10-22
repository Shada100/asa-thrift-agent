// talks to a running tool server the way Chord does (MCP over HTTP with the bearer token)
//   npm run smoke -- http://localhost:8787
//   npm run smoke -- https://<deployment> --checkout   (holds the windbreaker, checks, cancels)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2] ?? 'http://localhost:8787';
const token = process.env.MCP_TOKEN;
if (!token) throw new Error('MCP_TOKEN missing');

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
);

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  const out = JSON.parse(r.content[0].text);
  console.log(`\n${name} ${JSON.stringify(args)}\n`, JSON.stringify(out, null, 2));
  return out;
};

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
const { items } = await call('find_items', { query: 'jacket' });

if (process.argv.includes('--checkout')) {
  const all = (await call('find_items', { query: 'windbreaker' })).items;
  const target = all.find((i: any) => i.status === 'available') ?? items[0];
  const co = await call('start_checkout', { item_id: target.id, customer_name: 'Smoke Test', customer_phone: '08000000001' });
  if (co.ok) {
    await call('check_payment', { order_ref: co.orderRef });
    await call('cancel_checkout', { order_ref: co.orderRef });
    await call('find_items', { query: 'windbreaker' });
  }
}
await client.close();
