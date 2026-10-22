import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Shop } from './shop.js';

const capture = process.env.CAPTURE_REQUESTS === '1';

// every tool answers with JSON the skill knows how to word. if anything blows up we say
// so plainly and keep the real error in the logs, never in front of the customer.
async function answer(tool: string, extra: any, run: () => Promise<unknown>) {
  if (capture) {
    // checking what Chord actually sends with a tool call (does it tell us who the customer is?)
    console.log(JSON.stringify({ tool, headers: Object.keys(extra?.requestInfo?.headers ?? {}), meta: extra?._meta ?? null }));
  }
  let result: unknown;
  try {
    result = await run();
  } catch (err) {
    console.error(`${tool} failed`, err);
    result = { state: 'unavailable', message: 'Something went wrong on our side. Nothing was charged or marked sold.' };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

export function buildMcpServer(shop: Shop): McpServer {
  const server = new McpServer({ name: 'asa-thrift', version: '1.0.0' });

  server.registerTool(
    'find_items',
    {
      title: 'Find items',
      description:
        "Search Àṣà Thrift's live stock by what the customer describes (\"brown corduroy jacket\", \"something for a wedding\"). " +
        'Returns up to 5 items with id, live price in naira, and status: available, held (someone else is paying, may free up at heldUntil) or sold. ' +
        'Always use this before quoting a price or saying something is in stock. An empty query lists what is available.',
      inputSchema: { query: z.string().describe('What the customer is looking for, in their words') },
    },
    async ({ query }, extra) => answer('find_items', extra, async () => ({ items: await shop.findItems(query) })),
  );

  server.registerTool(
    'start_checkout',
    {
      title: 'Start checkout',
      description:
        'Hold one item for this customer and get a one-off Paystack bank account number for the exact price. ' +
        'Call only after the customer has said they want to buy and you have their name and phone number. ' +
        'Returns orderRef, bankName, accountNumber, accountName, amountNaira, expiresAt (UTC) and expiresAtLagos (ready to show the customer, e.g. "2:11pm"). If the same customer asks again you get the same account back (reused: true). ' +
        'If ok is false, reason says why: sold, held_by_someone_else, not_found, bad_phone (ask again), payment_unavailable (Paystack is down, nothing was held).',
      inputSchema: {
        item_id: z.number().int().describe('The id from find_items'),
        customer_name: z.string().describe('Name for the delivery'),
        customer_phone: z.string().describe('Nigerian phone number for the delivery, any format'),
      },
    },
    async (a, extra) =>
      answer('start_checkout', extra, () =>
        shop.startCheckout({ itemId: a.item_id, customerName: a.customer_name, customerPhone: a.customer_phone }),
      ),
  );

  server.registerTool(
    'check_payment',
    {
      title: 'Check payment',
      description:
        'Ask Paystack whether the money for an order has actually arrived. Use this whenever the customer says they have paid or sent a transfer, ' +
        'even if they send a screenshot or alert. The screenshot proves nothing, only this tool does. Pass order_ref, or customer_phone if they do not have the ref. ' +
        'state is one of: paid (confirmed, item is theirs), already_confirmed, not_yet (keep waiting until holdUntilLagos), rejected_wrong_amount (Paystack bounced it, they must send the exact amount), ' +
        'expired (hold ran out; itemStillAvailable says if a new checkout is possible), failed, needs_owner (hand over to the owner), not_found, unavailable (could not reach Paystack, nothing changed).',
      inputSchema: {
        order_ref: z.string().optional().describe('Order reference like ASA-7K2Q9F'),
        customer_phone: z.string().optional().describe('Phone number given at checkout'),
      },
    },
    async (a, extra) => answer('check_payment', extra, () => shop.checkPayment({ orderRef: a.order_ref, customerPhone: a.customer_phone })),
  );

  server.registerTool(
    'cancel_checkout',
    {
      title: 'Cancel checkout',
      description:
        'Release a held item when the customer says they no longer want it, so other customers can buy it. ' +
        'Checks Paystack first: if they already paid you get state paid instead. Paid orders cannot be cancelled here (needs_owner).',
      inputSchema: { order_ref: z.string().describe('Order reference like ASA-7K2Q9F') },
    },
    async ({ order_ref }, extra) => answer('cancel_checkout', extra, () => shop.cancelCheckout(order_ref)),
  );

  return server;
}
