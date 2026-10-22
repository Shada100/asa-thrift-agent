import { PaystackError, type Paystack, type PsProduct, type PsTransferCharge, type PsVerify, type TransferChargeArgs } from '../src/paystack.js';

// in-memory stand-in for Paystack test mode, shaped after what the real API returned in the spike
export class FakePaystack implements Paystack {
  products = new Map<number, PsProduct>();
  charges = new Map<string, TransferChargeArgs & { status: string; paidKobo?: number }>();
  chargeCalls = 0;
  failNextCharge: PaystackError | null = null;
  failVerify: PaystackError | null = null;
  failProducts: PaystackError | null = null;
  private nextAccount = 1231800000;

  addProduct(p: Partial<PsProduct> & { name: string; price: number }) {
    const id = p.id ?? this.products.size + 1;
    this.products.set(id, {
      id,
      product_code: `PROD_${id}`,
      description: '',
      quantity: 1,
      unlimited: false,
      in_stock: true,
      active: true,
      ...p,
    });
    return id;
  }

  // what the customer's bank transfer does, as far as Paystack's API is concerned
  pay(reference: string, kobo?: number) {
    const c = this.charges.get(reference);
    if (!c) throw new Error(`no charge ${reference}`);
    c.status = 'success';
    c.paidKobo = kobo ?? c.amountKobo;
  }

  setStatus(reference: string, status: string) {
    this.charges.get(reference)!.status = status;
  }

  async listProducts() {
    if (this.failProducts) throw this.failProducts;
    return [...this.products.values()].map((p) => ({ ...p }));
  }

  async getProduct(id: number) {
    if (this.failProducts) throw this.failProducts;
    const p = this.products.get(id);
    if (!p) throw new PaystackError('Product not found', 'not_found', 404);
    return { ...p };
  }

  async setQuantity(id: number, quantity: number) {
    const p = this.products.get(id);
    if (!p) throw new PaystackError('Product not found', 'not_found', 404);
    p.quantity = quantity;
    p.in_stock = quantity > 0;
    return { ...p };
  }

  async createTransferCharge(a: TransferChargeArgs): Promise<PsTransferCharge> {
    this.chargeCalls++;
    if (this.failNextCharge) {
      const e = this.failNextCharge;
      this.failNextCharge = null;
      throw e;
    }
    this.charges.set(a.reference, { ...a, status: 'ongoing' });
    return {
      reference: a.reference,
      status: 'pending_bank_transfer',
      accountNumber: String(this.nextAccount++),
      accountName: 'PAYSTACK CHECKOUT',
      bankName: 'Test Bank',
      expiresAt: a.expiresAt,
      amountKobo: a.amountKobo,
    };
  }

  async verify(reference: string): Promise<PsVerify> {
    if (this.failVerify) throw this.failVerify;
    const c = this.charges.get(reference);
    if (!c) throw new PaystackError('Transaction reference not found', 'not_found', 404);
    return {
      status: c.status,
      amountKobo: c.paidKobo ?? c.amountKobo,
      requestedAmountKobo: c.amountKobo,
      gatewayResponse: c.status === 'success' ? 'Approved' : 'Awaiting Transfer',
    };
  }
}

export const testConfig = {
  paystackSecret: 'sk_test_x',
  mcpToken: 't',
  holdMinutes: 30,
  customerEmailDomain: 'example.com',
};
