import type { ShopperOrders } from "commerce-sdk-isomorphic";

/** An order by its number, through a client typed with the SDK's class. */
export async function findOrder(orders: ShopperOrders, orderNo: string) {
  return orders.getOrder({ parameters: { orderNo } });
}
