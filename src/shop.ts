import type { Config } from './config.js';
import { newOrderRef, normalisePhone, normaliseRef } from './ids.js';
import { PaystackError, type Paystack, type PsProduct, type PsVerify } from './paystack.js';
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

  async function findOrder(a: { orderRef?: string; customerPhone?: string }): Promise<Order | null> {
    const ref = a.orderRef ? normaliseRef(a.orderRef) : null;
    if (ref) {
      const o = await store.getOrder(ref);
      if (o) return o;
    }
    const phone = a.customerPhone ? normalisePhone(a.customerPhone) : null;
    return phone ? store.findActiveOrderByPhone(phone) : null;
  }

  const facts = (o: Order) => ({ orderRef: o.ref, item: o.productName, amountNaira: naira(o.amountKobo) });
  const expired = (o: Order) => now().getTime() >= new Date(o.expiresAt).getTime();

  // put the unit back on sale. guarded so a retry or a webhook can't add it back twice.
  async function release(o: Order): Promise<boolean> {
    if (await store.once(`release:${o.ref}`)) {
      await putStockBack(o.productId);
      await store.putOrder({ ...o, state: 'released' });
    }
    try {
      const p = await paystack.getProduct(o.productId);
      return p.active && (p.unlimited || p.quantity > 0);
    } catch {
      return false;
    }
  }

  async function sendToOwner(o: Order, note: string): Promise<PaymentResult> {
    await store.putOrder({ ...o, state: 'needs_owner', note });
    return { state: 'needs_owner', ...facts(o), message: note };
  }

  // the only place an order becomes paid, and only from Paystack's own answer
  async function settle(o: Order, v: PsVerify): Promise<PaymentResult> {
    if (v.amountKobo < o.amountKobo) {
      return sendToOwner(o, `Paystack shows ${naira(v.amountKobo)} paid against ${naira(o.amountKobo)}. The owner needs to sort this out.`);
    }
    if (!(await store.once(`paid:${o.ref}`))) {
      return { state: 'already_confirmed', ...facts(o), message: 'This payment was already confirmed.' };
    }

    if (o.state === 'released') {
      // money arrived after we gave the item back. keep the sale if the piece is still here.
      try {
        const p = await paystack.getProduct(o.productId);
        if (p.active && (p.unlimited || p.quantity > 0)) {
          if (!p.unlimited) await paystack.setQuantity(p.id, p.quantity - 1);
        } else {
          return sendToOwner(o, 'Paid after the hold expired and the item has since gone to someone else. The owner must arrange a refund.');
        }
      } catch {
        return sendToOwner(o, 'Paid after the hold expired and the stock could not be checked. The owner must confirm the item by hand.');
      }
    }

    await store.putOrder({ ...o, state: 'paid' });
    return { state: 'paid', ...facts(o), message: `Paystack confirmed ${naira(o.amountKobo)} received. The item is sold to this customer.` };
  }

  async function checkPayment(a: { orderRef?: string; customerPhone?: string }): Promise<PaymentResult> {
    const o = await findOrder(a);
    if (!o) return { state: 'not_found', message: 'No order found. Ask for the order reference or the phone number used at checkout.' };
    if (o.state === 'paid') return { state: 'already_confirmed', ...facts(o), message: 'This payment was already confirmed.' };
    if (o.state === 'needs_owner') return { state: 'needs_owner', ...facts(o), message: o.note ?? 'The owner is handling this order.' };

    let v: PsVerify;
    try {
      v = await paystack.verify(o.ref);
    } catch (err) {
      console.error(`verify failed for ${o.ref}`, err);
      return { state: 'unavailable', ...facts(o), message: 'Could not reach Paystack to check. Nothing has changed; try again in a minute.' };
    }

    if (v.status === 'success') return settle(o, v);

    if (o.state === 'released') {
      return { state: 'expired', ...facts(o), itemStillAvailable: await release(o), message: 'This hold already expired and the account number no longer works.' };
    }

    if (v.status === 'failed' || v.status === 'reversed') {
      return { state: 'failed', ...facts(o), itemStillAvailable: await release(o), message: 'Paystack marked this payment as failed. The hold is released.' };
    }

    const rejected = await store.getRejected(o.ref);
    if (rejected && !expired(o)) {
      return { state: 'rejected_wrong_amount', ...facts(o), holdUntil: o.expiresAt, message: `Paystack bounced a transfer to this account (${rejected}). The money goes back to the sender's bank. Only the exact amount is accepted.` };
    }

    // anything else (ongoing, pending, some status we've never seen) is "not paid yet"
    if (!expired(o)) {
      return { state: 'not_yet', ...facts(o), holdUntil: o.expiresAt, message: 'Paystack has not received the transfer yet.' };
    }
    return { state: 'expired', ...facts(o), itemStillAvailable: await release(o), message: 'The hold ran out before Paystack received the money. The account number no longer works.' };
  }

  async function cancelCheckout(orderRef: string): Promise<PaymentResult> {
    const o = await findOrder({ orderRef });
    if (!o) return { state: 'not_found', message: 'No order with that reference.' };
    if (o.state === 'paid' || o.state === 'needs_owner') {
      return sendToOwner(o, 'The customer wants to cancel an order that is already paid. Refunds are handled by the owner.');
    }
    if (o.state === 'held') {
      // the money may have landed while they were deciding
      try {
        const v = await paystack.verify(o.ref);
        if (v.status === 'success') return settle(o, v);
      } catch {
        return { state: 'unavailable', ...facts(o), message: 'Could not reach Paystack to check before cancelling. Nothing has changed.' };
      }
    }
    await release(o);
    return { state: 'cancelled', ...facts(o), message: 'Hold cancelled and the item is back on sale.' };
  }

  async function sweepExpired(): Promise<number> {
    const due = (await store.activeHolds()).filter(expired);
    let released = 0;
    for (const o of due) {
      try {
        const v = await paystack.verify(o.ref);
        if (v.status === 'success') {
          await settle(o, v);
          continue;
        }
      } catch {
        // can't tell if they paid, so leave it held and try again next time
        continue;
      }
      await release(o);
      released++;
    }
    return released;
  }

  return { findItems, startCheckout, checkPayment, cancelCheckout, sweepExpired };
}
