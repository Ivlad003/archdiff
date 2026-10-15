import { readFileSync } from "node:fs";
import type { Order } from "../lib/orders.ts";

const rows = new Map<string, Order>();

export function saveOrder(order: Order): void {
  rows.set(order.id, order);
}

export function readOrder(id: string): Order | null {
  readFileSync("/dev/null");
  return rows.get(id) ?? null;
}
