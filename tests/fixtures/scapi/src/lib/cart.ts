import type { AppClients } from "./api-clients";
import { log } from "./log";

/** Adds a product to a basket, reading the basket first and refreshing each of its items. */
export async function addToCart(clients: AppClients, basketId: string, productId: string) {
  const { data: basket } = await clients.shopperBasketsV2.getBasket({ parameters: { basketId } });
  if (!basket) {
    log("no basket");
    return null;
  } else {
    await clients.shopperBasketsV2.addItemToBasket({ parameters: { basketId }, body: [{ productId, quantity: 1 }] });
  }
  for (const item of basket.productItems ?? []) {
    await clients.shopperProducts.getProduct({ parameters: { id: item.productId } });
  }
  try {
    await clients.shopperBasketsV2.updateBasket({ parameters: { basketId }, body: {} });
  } catch (error) {
    log(String(error));
  }
  return basket;
}
