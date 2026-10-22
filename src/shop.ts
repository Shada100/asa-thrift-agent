import type { Config } from './config.js';
import { newOrderRef, normalisePhone } from './ids.js';
import { PaystackError, type Paystack, type PsProduct } from './paystack.js';
import type { Store } from './store.js';
import type { CheckoutResult, Item, Order, PaymentResult } from './types.js';

export type * from './types.js';

export interface Shop {
  findItems(query: string): Promise<Item[]>;
  startCheckout(a: { itemId: number; customerName: string; customerPhone: string }): Promise<CheckoutResult>;
  checkPayment(a: { orderRef?: string; customerPhone?: string }): Promise<PaymentResult>;
  cancelCheckout(orderRef: string): Promise<PaymentResult>;
  sweepExpired(): Promise<number>;
}

interface Deps {
  paystack: Paystack;
  store: Store;
  config: Config;
  now?: () => Date;
}

const MAX_RESULTS = 5;

// words people wrap around what they actually want ("abeg is the jacket still available?")
const FILLER = new Set(
  'a an the is it its still available do you have any please abeg i want need for me my this that of in and or with get buy one some'.split(' '),
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => t.replace(/'s$/, '').replace(/s$/, ''))
    .filter((t) => t.length > 1 && !FILLER.has(t));
}

const naira = (kobo: number) => kobo / 100;

export function createShop({ paystack, store, config, now = () => new Date() }: Deps): Shop {
  function itemFrom(p: PsProduct, holds: Order[]): Item {
    const inStock = p.unlimited || p.quantity > 0;
    const mine = holds.filter((h) => h.productId === p.id);
    const heldUntil = mine.map((h) => h.expiresAt).sort()[0];
    return {
      id: p.id,
      code: p.product_code,
      name: p.name,
      description: p.description,
      priceNaira: naira(p.price),
      status: inStock ? 'available' : heldUntil ? 'held' : 'sold',
      ...(!inStock && heldUntil ? { heldUntil } : {}),
    };
  }

  async function alternatives(excludeId: number): Promise<Item[]> {
    try {
      const [products, holds] = await Promise.all([paystack.listProducts(), store.activeHolds()]);
      return products
        .filter((p) => p.active && p.id !== excludeId)
        .map((p) => itemFrom(p, holds))
        .filter((i) => i.status === 'available')
        .slice(0, 3);
    } catch {
      // suggestions are a nice-to-have, never worth failing the reply over
      return [];
    }
  }

  async function putStockBack(productId: number) {
    try {
      const fresh = await paystack.getProduct(productId);
      if (!fresh.unlimited) await paystack.setQuantity(productId, fresh.quantity + 1);
    } catch (err) {
      // the owner has to fix this one by hand in the dashboard
      console.error(`could not put stock back for product ${productId}`, err);
    }
  }

  async function findItems(query: string): Promise<Item[]> {
    await sweepExpired();
    const [products, holds] = await Promise.all([paystack.listProducts(), store.activeHolds()]);
    const wanted = tokens(query);

    const scored = products
      .filter((p) => p.active)
      .map((p) => {
        const haystack = tokens(`${p.name} ${p.description}`);
        const score = wanted.filter((w) => haystack.some((h) => h.startsWith(w))).length;
        return { item: itemFrom(p, holds), score };
      })
      // an empty query is "what do you have?", so show what's on the rail
      .filter((x) => (wanted.length ? x.score > 0 : x.item.status === 'available'));

    scored.sort((a, b) => b.score - a.score || Number(b.item.status === 'available') - Number(a.item.status === 'available'));
    return scored.slice(0, MAX_RESULTS).map((x) => x.item);
  }

  async function startCheckout(a: { itemId: number; customerName: string; customerPhone: string }): Promise<CheckoutResult> {
    const phone = normalisePhone(a.customerPhone);
    if (!phone) {
      return { ok: false, reason: 'bad_phone', message: 'That does not look like a Nigerian mobile number. Ask for it again.' };
    }
    const customerName = a.customerName.trim() || 'Customer';

    await sweepExpired();

    const result = await store.withLock(`product:${a.itemId}`, async (): Promise<CheckoutResult> => {
      const holds = await store.activeHolds(a.itemId);
      const existing = holds.find((h) => h.customerPhone === phone);
      if (existing) return checkoutOk(existing, true);

      let product: PsProduct;
      try {
        product = await paystack.getProduct(a.itemId);
      } catch (err) {
        if (err instanceof PaystackError && err.kind === 'not_found') {
          return { ok: false, reason: 'not_found', message: 'No item with that id.' };
        }
        return unavailable();
      }
      if (!product.active) return { ok: false, reason: 'not_found', message: 'That item is not listed any more.' };

      if (!product.unlimited && product.quantity <= 0) {
        return holds.length
          ? { ok: false, reason: 'held_by_someone_else', message: `Another customer is paying for ${product.name} right now.`, alternatives: await alternatives(product.id) }
          : { ok: false, reason: 'sold', message: `${product.name} has been sold.`, alternatives: await alternatives(product.id) };
      }

      // take it off the shelf in Paystack first, so the owner can't sell it in a DM meanwhile
      if (!product.unlimited) {
        try {
          await paystack.setQuantity(product.id, product.quantity - 1);
        } catch {
          return unavailable();
        }
      }

      const ref = newOrderRef();
      const expiresAt = new Date(now().getTime() + config.holdMinutes * 60_000).toISOString();
      let charge;
      try {
        charge = await paystack.createTransferCharge({
          reference: ref,
          email: `${ref.toLowerCase()}@${config.customerEmailDomain}`,
          amountKobo: product.price,
          expiresAt,
          metadata: {
            order_ref: ref,
            product_id: product.id,
            product_name: product.name,
            customer_name: customerName,
            customer_phone: phone,
          },
        });
      } catch (err) {
        console.error(`charge failed for ${ref}`, err);
        await putStockBack(product.id);
        return unavailable();
      }

      const order: Order = {
        ref,
        productId: product.id,
        productName: product.name,
        amountKobo: product.price,
        customerName,
        customerPhone: phone,
        bankName: charge.bankName,
        accountNumber: charge.accountNumber,
        accountName: charge.accountName,
        expiresAt: charge.expiresAt ?? expiresAt,
        state: 'held',
        createdAt: now().toISOString(),
      };
      await store.putOrder(order);
      return checkoutOk(order, false);
    });

    if (result === 'locked') {
      return {
        ok: false,
        reason: 'held_by_someone_else',
        message: 'Another customer is checking out this item at this moment.',
        alternatives: await alternatives(a.itemId),
      };
    }
    return result;
  }

  function checkoutOk(o: Order, reused: boolean): CheckoutResult {
    return {
      ok: true,
      orderRef: o.ref,
      item: o.productName,
      amountNaira: naira(o.amountKobo),
      bankName: o.bankName,
      accountNumber: o.accountNumber,
      accountName: o.accountName,
      expiresAt: o.expiresAt,
      reused,
    };
  }

  function unavailable(): CheckoutResult {
    return { ok: false, reason: 'payment_unavailable', message: 'Paystack is not responding. Nothing was held or charged.' };
  }

  async function checkPayment(): Promise<PaymentResult> {
    return { state: 'not_found', message: 'not built yet' };
  }

  async function cancelCheckout(): Promise<PaymentResult> {
    return { state: 'not_found', message: 'not built yet' };
  }

  async function sweepExpired(): Promise<number> {
    return 0;
  }

  return { findItems, startCheckout, checkPayment, cancelCheckout, sweepExpired };
}
