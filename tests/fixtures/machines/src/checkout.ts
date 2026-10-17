import { cancel, pay, ship, type Order } from "./order.ts";

/** A checkout with branches and a loop, for the fragments of its sequence. */
export function checkout(orders: Order[], rush: boolean): number {
  let shipped = 0;

  for (const order of orders) {
    pay(order);

    if (rush) {
      ship(order);
      shipped++;
    } else {
      cancel(order);
    }
  }

  try {
    audit(shipped);
  } catch {
    cancel(orders[0]!);
  }

  return shipped;
}

export function audit(count: number): void {
  if (count < 0) throw new Error("negative");
}
