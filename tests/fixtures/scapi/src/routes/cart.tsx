import { createApiClients } from "@/lib/api-clients";
import { addToCart } from "@/lib/cart";

export async function action({ request, context }: { request: Request; context: { siteId: string } }) {
  const form = await request.formData();
  const clients = createApiClients(context);
  return addToCart(clients, String(form.get("basketId")), String(form.get("productId")));
}

export default function Cart() {
  return <h1>Cart & Checkout</h1>;
}
