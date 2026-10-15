import { OrderService } from "@/lib/orders";

export async function action(request: { total: number }) {
  const service = new OrderService("web");
  return service.place(request.total);
}

export default function Checkout() {
  return null;
}
