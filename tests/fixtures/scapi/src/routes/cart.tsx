import { createApiClients } from "@/lib/api-clients";
import { addToCart } from "@/lib/cart";

export async function action({ request, context }: { request: Request; context: { siteId: string } }) {
  const form = await request.formData();
  const clients = createApiClients(context);
  const basket = await addToCart(clients, String(form.get("basketId")), String(form.get("productId")));
  return { currency: basket?.currency, items: basket?.productItems?.map((item) => item.c_fromStoreId) };
}

export default function Cart() {
  return <h1>Cart & Checkout</h1>;
}
