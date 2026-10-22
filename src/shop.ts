import type { Config } from './config.js';
import { lagosTime, newOrderRef, normalisePhone, normaliseRef } from './ids.js';
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

// rough plural -> singular so "dresses", "bags", "jeans" match what's on the rail.
// both the query and the stock go through this, so it only has to be consistent.
function singular(t: string): string {
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (/(ss|sh|ch|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) return t.slice(0, -1);
  return t;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((t) => singular(t.replace(/'s$/, '')))
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
      ...(!inStock && heldUntil ? { heldUntil, heldUntilLagos: lagosTime(heldUntil) } : {}),
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

  type StockChange = 'ok' | 'none_left' | 'failed';

  // the one place stock moves. callers already holding the product lock (checkout) use this
  // directly; everyone else goes through changeStock so two flows can't read-modify-write at once.
  async function changeStockUnlocked(productId: number, delta: 1 | -1): Promise<StockChange> {
    let p: PsProduct;
    try {
      p = await paystack.getProduct(productId);
    } catch (err) {
      console.error(`stock read failed for product ${productId}`, err);
      return 'failed';
    }
    if (p.unlimited) return 'ok';
    if (delta < 0 && (!p.active || p.quantity <= 0)) return 'none_left';
    const target = p.quantity + delta;
    try {
      await paystack.setQuantity(productId, target);
      return 'ok';
    } catch (err) {
      // a timeout doesn't mean the PUT didn't land. look before deciding.
      try {
        if ((await paystack.getProduct(productId)).quantity === target) return 'ok';
      } catch {}
      console.error(`stock write failed for product ${productId}`, err);
      return 'failed';
    }
  }

  async function changeStock(productId: number, delta: 1 | -1): Promise<StockChange> {
    const r = await store.withLock(`product:${productId}`, () => changeStockUnlocked(productId, delta));
    return r === 'locked' ? 'failed' : r;
  }

  async function stillAvailable(productId: number): Promise<boolean> {
    try {
      const p = await paystack.getProduct(productId);
      return p.active && (p.unlimited || p.quantity > 0);
    } catch {
      return false;
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
      const took = await changeStockUnlocked(product.id, -1);
      if (took === 'none_left') return { ok: false, reason: 'sold', message: `${product.name} has been sold.`, alternatives: await alternatives(product.id) };
      if (took === 'failed') return unavailable();

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
        if ((await changeStockUnlocked(product.id, 1)) === 'failed') {
          // couldn't put it back. park an already-expired hold so the next sweep retries it.
          await store.putOrder({
            ref, productId: product.id, productName: product.name, amountKobo: product.price,
            customerName, customerPhone: '', bankName: '', accountNumber: '', accountName: '',
            expiresAt: now().toISOString(), state: 'held', createdAt: now().toISOString(),
            note: 'charge failed, stock still to go back',
          });
        }
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
      expiresAtLagos: lagosTime(o.expiresAt),
      reused,
    };
  }

  function unavailable(): CheckoutResult {
    return { ok: false, reason: 'payment_unavailable', message: 'Paystack is not responding. Nothing was held or charged.' };
  }

  const facts = (o: Order) => ({ orderRef: o.ref, item: o.productName, amountNaira: naira(o.amountKobo) });
  const expired = (o: Order) => now().getTime() >= new Date(o.expiresAt).getTime();
  const busy: PaymentResult = { state: 'unavailable', message: 'This order is being updated right now. Try again in a moment.' };
  const notFound: PaymentResult = { state: 'not_found', message: 'No order found. Ask for the order reference or the phone number used at checkout.' };

  async function sendToOwner(o: Order, note: string): Promise<PaymentResult> {
    await store.putOrder({ ...o, state: 'needs_owner', note });
    return { state: 'needs_owner', ...facts(o), message: note };
  }

  // settle and release both run under the order's lock and re-read the order inside it, so
  // whatever they decide is based on the latest state, not a copy someone else has since changed.
  // lock order is always order -> product, never the other way round.
  function underOrderLock(ref: string, fn: (o: Order) => Promise<PaymentResult>): Promise<PaymentResult> {
    return store
      .withLock(`order:${ref}`, async () => {
        const o = await store.getOrder(ref);
        return o ? fn(o) : notFound;
      })
      .then((r) => (r === 'locked' ? busy : r));
  }

  // the only place an order becomes paid, and only from Paystack's own answer
  function settle(ref: string, v: PsVerify): Promise<PaymentResult> {
    return underOrderLock(ref, async (o) => {
      if (o.state === 'paid') return { state: 'already_confirmed', ...facts(o), message: 'This payment was already confirmed.' };
      if (o.state === 'needs_owner') return { state: 'needs_owner', ...facts(o), message: o.note ?? 'The owner is handling this order.' };
      if (v.amountKobo < o.amountKobo) {
        return sendToOwner(o, `Paystack shows ${naira(v.amountKobo)} paid against ${naira(o.amountKobo)}. The owner needs to sort this out.`);
      }
      if (o.state === 'released') {
        // money arrived after we gave the item back. keep the sale if the piece is still here.
        const took = await changeStock(o.productId, -1);
        if (took === 'none_left') return sendToOwner(o, 'Paid after the hold expired and the item has since gone to someone else. The owner must arrange a refund.');
        if (took === 'failed') return sendToOwner(o, 'Paid after the hold expired and the stock could not be checked. The owner must confirm the item by hand.');
      }
      await store.putOrder({ ...o, state: 'paid' });
      return { state: 'paid', ...facts(o), message: `Paystack confirmed ${naira(o.amountKobo)} received. The item is sold to this customer.` };
    });
  }

  // put the unit back on sale. if Paystack won't take the change, the hold stays and the next sweep tries again.
  async function release(ref: string): Promise<{ released: boolean; available: boolean; productId?: number }> {
    let productId: number | undefined;
    let released = false;
    await underOrderLock(ref, async (o) => {
      productId = o.productId;
      if (o.state !== 'held') {
        released = o.state === 'released';
        return busy; // nothing to do, someone already moved it on
      }
      if ((await changeStock(o.productId, 1)) === 'failed') return busy;
      await store.putOrder({ ...o, state: 'released' });
      released = true;
      return busy;
    });
    return { released, available: productId === undefined ? false : await stillAvailable(productId), productId };
  }

  async function verifyOrUnavailable(o: Order): Promise<PsVerify | PaymentResult> {
    try {
      return await paystack.verify(o.ref);
    } catch (err) {
      console.error(`verify failed for ${o.ref}`, err);
      return { state: 'unavailable', ...facts(o), message: 'Could not reach Paystack to check. Nothing has changed; try again in a minute.' };
    }
  }

  async function checkOne(o: Order): Promise<PaymentResult> {
    if (o.state === 'paid') return { state: 'already_confirmed', ...facts(o), message: 'This payment was already confirmed.' };
    if (o.state === 'needs_owner') return { state: 'needs_owner', ...facts(o), message: o.note ?? 'The owner is handling this order.' };

    const v = await verifyOrUnavailable(o);
    if ('state' in v) return v;
    if (v.status === 'success') return settle(o.ref, v);

    if (o.state === 'released') {
      return { state: 'expired', ...facts(o), itemStillAvailable: await stillAvailable(o.productId), message: 'This hold already expired and the account number no longer works.' };
    }

    if (v.status === 'failed' || v.status === 'reversed') {
      const r = await release(o.ref);
      return { state: 'failed', ...facts(o), itemStillAvailable: r.available, message: 'Paystack marked this payment as failed. The hold is released.' };
    }

    // two ways to learn paystack bounced a wrong amount: the webhook, or verify's free-text
    // gateway_response afterwards. we've seen the webhook not come the second time, so check both.
    const stored = await store.getRejected(o.ref);
    const bounced = stored ?? (/incorrect amount/i.test(v.gatewayResponse ?? '') ? { reason: v.gatewayResponse as string } : null);
    if (bounced && !expired(o)) {
      const when = bounced.at ? ` at ${lagosTime(bounced.at)}` : '';
      return {
        state: 'rejected_wrong_amount',
        ...facts(o),
        holdUntil: o.expiresAt,
        holdUntilLagos: lagosTime(o.expiresAt),
        ...(bounced.at ? { bouncedAtLagos: lagosTime(bounced.at) } : {}),
        // the bounce record sticks around, so a correct transfer sent since may still be landing
        message: `Paystack bounced a transfer to this account${when} (${bounced.reason}); that money goes back to the sender's bank. Only the exact amount is accepted. If the customer has already sent the exact amount since then, it may still be on its way: tell them not to send it again and to check back in a few minutes.`,
      };
    }

    // anything else (ongoing, pending, some status we've never seen) is "not paid yet"
    if (!expired(o)) {
      return { state: 'not_yet', ...facts(o), holdUntil: o.expiresAt, holdUntilLagos: lagosTime(o.expiresAt), message: 'Paystack has not received the transfer yet.' };
    }
    const r = await release(o.ref);
    return { state: 'expired', ...facts(o), itemStillAvailable: r.available, message: 'The hold ran out before Paystack received the money. The account number no longer works.' };
  }

  async function checkPayment(a: { orderRef?: string; customerPhone?: string }): Promise<PaymentResult> {
    const ref = a.orderRef ? normaliseRef(a.orderRef) : null;
    if (ref) {
      const o = await store.getOrder(ref);
      if (o) return checkOne(o);
    }
    const phone = a.customerPhone ? normalisePhone(a.customerPhone) : null;
    if (!phone) return notFound;

    const orders = await store.ordersByPhone(phone);
    const held = orders.filter((o) => o.state === 'held');
    if (held.length > 1) {
      // they've got more than one thing on hold: if any of them is paid, that's the one they mean
      for (const o of held) {
        const v = await verifyOrUnavailable(o);
        if (!('state' in v) && v.status === 'success') return settle(o.ref, v);
      }
      const newest = await checkOne(held[0]);
      return { ...newest, otherOpenOrders: held.slice(1).map((o) => ({ orderRef: o.ref, item: o.productName })) };
    }
    const pick = held[0] ?? orders[0];
    return pick ? checkOne(pick) : notFound;
  }

  async function cancelCheckout(orderRef: string): Promise<PaymentResult> {
    const ref = normaliseRef(orderRef);
    const o = ref ? await store.getOrder(ref) : null;
    if (!o) return { state: 'not_found', message: 'No order with that reference.' };
    if (o.state === 'paid' || o.state === 'needs_owner') {
      return sendToOwner(o, 'The customer wants to cancel an order that is already paid. Refunds are handled by the owner.');
    }
    if (o.state === 'held') {
      // the money may have landed while they were deciding
      const v = await verifyOrUnavailable(o);
      if ('state' in v) return { ...v, message: 'Could not reach Paystack to check before cancelling. Nothing has changed.' };
      if (v.status === 'success') return settle(o.ref, v);
    }
    await release(o.ref);
    return { state: 'cancelled', ...facts(o), message: 'Hold cancelled and the item is back on sale.' };
  }

  async function sweepExpired(): Promise<number> {
    const due = (await store.activeHolds()).filter(expired);
    let released = 0;
    for (const o of due) {
      try {
        const v = await paystack.verify(o.ref);
        if (v.status === 'success') {
          await settle(o.ref, v);
          continue;
        }
      } catch (err) {
        // a charge paystack never created (it failed at checkout) can't have been paid.
        // anything else: we can't tell, so leave it held and try again next time.
        if (!(err instanceof PaystackError && err.kind === 'not_found')) continue;
      }
      if ((await release(o.ref)).released) released++;
    }
    return released;
  }

  return { findItems, startCheckout, checkPayment, cancelCheckout, sweepExpired };
}
