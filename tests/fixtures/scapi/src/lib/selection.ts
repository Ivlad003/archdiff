import { shopperStore } from "./state";

export function selected(): number {
  return shopperStore.getState().selected;
}
