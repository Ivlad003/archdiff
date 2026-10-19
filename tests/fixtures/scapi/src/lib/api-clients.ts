import type { ShopperBasketsV2, ShopperOrders, ShopperProducts } from "commerce-sdk-isomorphic";

/** The SCAPI clients of one request, as the runtime hands them out. */
export interface AppClients {
  shopperBasketsV2: ShopperBasketsV2;
  shopperProducts: ShopperProducts;
  shopperOrders: ShopperOrders;
}

export function createApiClients(context: { siteId: string }): AppClients {
  return clientsOf(context.siteId) as AppClients;
}

function clientsOf(siteId: string): unknown {
  return { siteId };
}
