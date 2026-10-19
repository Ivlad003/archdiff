import { createApiClients } from "@/lib/api-clients";
import { findOrder } from "@/lib/orders";

export async function loader({ params, context }: { params: { orderNo: string }; context: { siteId: string } }) {
  const clients = createApiClients(context);
  const order = await findOrder(clients.shopperOrders, params.orderNo);
  return { orderNo: order.data.orderNo, total: order.data.orderTotal };
}
