/** Orders move through a fixed set of states: an implicit state machine, written with literals. */
export type OrderStatus = "new" | "paid" | "shipped" | "cancelled" | "refunded";

export interface Order {
  id: string;
  status: OrderStatus;
}

export function pay(order: Order): void {
  switch (order.status) {
    case "new":
      order.status = "paid";
      break;
    default:
      throw new Error(`cannot pay a ${order.status} order`);
  }
}

export function ship(order: Order): void {
  if (order.status === "paid") {
    order.status = "shipped";
  }
}

export function cancel(order: Order): void {
  if (order.status === "new" || order.status === "paid") order.status = "cancelled";
}

export function reset(order: Order): void {
  order.status = "new";
}
