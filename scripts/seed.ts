// puts the shop's (made up) stock into Paystack test mode. safe to re-run: it skips
// anything that already exists by name. --reset puts quantities back to the seed values.
const key = process.env.PAYSTACK_SECRET_KEY ?? '';
if (!key.startsWith('sk_test_')) throw new Error('seed only runs against a Paystack test key');

const stock = [
  { name: 'Brown corduroy jacket', description: 'Vintage, size L, soft wale, no flaws', price: 18500 },
  { name: 'Black leather biker jacket', description: 'Size M, real leather, light wear on the cuffs', price: 42000 },
  { name: 'Ankara print bomber', description: 'Size M, handmade by a Yaba tailor', price: 24000, quantity: 2 },
  { name: "Levi's 501 jeans", description: 'W32 L32, mid-wash, straight leg', price: 15000 },
  { name: 'Cream knit cardigan', description: 'Size S/M, chunky knit, one tiny pull at the hem', price: 12000 },
  { name: 'Adire maxi dress', description: 'Size M, indigo, cotton', price: 21500 },
  { name: 'Striped linen shirt', description: 'Size XL, blue and white, short sleeve', price: 9500 },
  { name: 'Vintage Nike windbreaker', description: 'Size L, 90s colour block', price: 27000 },
  { name: 'Brown leather tote bag', description: 'Large, structured, brass hardware', price: 16000 },
  { name: 'Pleated tennis skirt', description: 'Size S, white', price: 8000 },
];

async function ps(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.status) throw new Error(`${method} ${path}: ${json.message}`);
  return json.data;
}

const reset = process.argv.includes('--reset');
const existing: any[] = await ps('GET', '/product?perPage=100');

for (const item of stock) {
  const quantity = item.quantity ?? 1;
  const found = existing.find((p) => p.name === item.name);
  if (!found) {
    const p = await ps('POST', '/product', {
      name: item.name,
      description: item.description,
      price: item.price * 100,
      currency: 'NGN',
      unlimited: false,
      quantity,
    });
    console.log(`created  ${p.id}  ${item.name}`);
  } else if (reset) {
    await ps('PUT', `/product/${found.id}`, { quantity, price: item.price * 100 });
    console.log(`reset    ${found.id}  ${item.name} -> qty ${quantity}`);
  } else {
    console.log(`exists   ${found.id}  ${item.name} (qty ${found.quantity})`);
  }
}
