/** Orders: the domain of the sample. */
import { readOrder, saveOrder } from "@/db/store";
import { log } from "./log.ts";

export interface Order { id: string; total: number }

export function placeOrder(id: string, total: number): Order {
  const order: Order = { id, total };
  validate(order);
  saveOrder(order);
  log(`placed ${id}`);
  return order;
}

function validate(order: Order): void {
  if (order.total < 0) throw new Error("negative");
}

export function findOrder(id: string): Order | null {
  return readOrder(id);
}

export class OrderService {
  constructor(private readonly prefix: string) {}
  place(total: number): Order {
    return placeOrder(this.nextId(), total);
  }
  private nextId(): string {
    return `${this.prefix}-${Date.now()}`;
  }
}
