// The SCAPI families the storefront-next runtime's clients serve, each with its base path and operations (method and
// path template), read from @salesforce/storefront-next-runtime 1.4.0 (dist/scapi.d.ts) by scripts/scapi-table.mjs.
// apis.ts reads the runtime a repository installed first; this table stands in when there is none. Do not edit by hand.

import type { ScapiTable } from "./apis.ts";

export const SCAPI_TABLE_VERSION = "1.4.0";

export const SCAPI_TABLE: ScapiTable = {
  "ShopperBasketsV1": {
    "basePath": "/checkout/shopper-baskets/v1",
    "operations": {
      "createBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets"
      },
      "transferBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/actions/transfer"
      },
      "mergeBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/actions/merge"
      },
      "getBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}"
      },
      "deleteBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}"
      },
      "updateBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}"
      },
      "updateAsAgentBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/agent"
      },
      "updateBillingAddressForBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/billing-address"
      },
      "addCouponToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/coupons"
      },
      "removeCouponFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/coupons/{couponItemId}"
      },
      "updateCustomerForBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/customer"
      },
      "addGiftCertificateItemToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/gift-certificate-items"
      },
      "removeGiftCertificateItemFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/gift-certificate-items/{giftCertificateItemId}"
      },
      "updateGiftCertificateItemInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/gift-certificate-items/{giftCertificateItemId}"
      },
      "addItemToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items"
      },
      "updateItemsInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items"
      },
      "removeItemFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items/{itemId}"
      },
      "updateItemInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items/{itemId}"
      },
      "addTaxesForBasketItem": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items/{itemId}/taxes"
      },
      "addPaymentInstrumentToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-instruments"
      },
      "removePaymentInstrumentFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-instruments/{paymentInstrumentId}"
      },
      "updatePaymentInstrumentInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-instruments/{paymentInstrumentId}"
      },
      "getPaymentMethodsForBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-methods"
      },
      "addPriceAdjustmentToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-adjustments"
      },
      "removePriceAdjustmentFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-adjustments/{priceAdjustmentId}"
      },
      "updatePriceAdjustmentInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-adjustments/{priceAdjustmentId}"
      },
      "getPriceBooksForBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-books"
      },
      "addPriceBooksToBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-books"
      },
      "createShipmentForBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments"
      },
      "removeShipmentFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}"
      },
      "updateShipmentForBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}"
      },
      "updateShippingAddressForShipment": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address"
      },
      "updateShippingMethodForShipment": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method"
      },
      "getShippingMethodsForShipment": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-methods"
      },
      "updateAsStorefrontBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/storefront"
      },
      "getTaxesFromBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/taxes"
      },
      "addTaxesForBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/taxes"
      }
    }
  },
  "ShopperBasketsV2": {
    "basePath": "/checkout/shopper-baskets/v2",
    "operations": {
      "createBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets"
      },
      "transferBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/actions/transfer"
      },
      "mergeBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/actions/merge"
      },
      "getBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}"
      },
      "deleteBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}"
      },
      "updateBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}"
      },
      "promoteTemporaryBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/actions/promote"
      },
      "updateAsAgentBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/agent"
      },
      "updateBillingAddressForBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/billing-address"
      },
      "addCouponToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/coupons"
      },
      "removeCouponFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/coupons/{couponItemId}"
      },
      "updateCustomerForBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/customer"
      },
      "addGiftCertificateItemToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/gift-certificate-items"
      },
      "removeGiftCertificateItemFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/gift-certificate-items/{giftCertificateItemId}"
      },
      "updateGiftCertificateItemInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/gift-certificate-items/{giftCertificateItemId}"
      },
      "addItemToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items"
      },
      "updateItemsInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items"
      },
      "removeItemFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items/{itemId}"
      },
      "updateItemInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items/{itemId}"
      },
      "addTaxesForBasketItem": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/items/{itemId}/taxes"
      },
      "addPaymentInstrumentToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-instruments"
      },
      "removePaymentInstrumentFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-instruments/{paymentInstrumentId}"
      },
      "updatePaymentInstrumentInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-instruments/{paymentInstrumentId}"
      },
      "getPaymentMethodsForBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/payment-methods"
      },
      "addPriceAdjustmentToBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-adjustments"
      },
      "removePriceAdjustmentFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-adjustments/{priceAdjustmentId}"
      },
      "updatePriceAdjustmentInBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-adjustments/{priceAdjustmentId}"
      },
      "getPriceBooksForBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-books"
      },
      "addPriceBooksToBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/price-books"
      },
      "createShipmentForBasket": {
        "method": "POST",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments"
      },
      "removeShipmentFromBasket": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}"
      },
      "updateShipmentForBasket": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}"
      },
      "updateShippingAddressForShipment": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-address"
      },
      "updateShippingMethodForShipment": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-method"
      },
      "getShippingMethodsForShipment": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/shipments/{shipmentId}/shipping-methods"
      },
      "updateAsStorefrontBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/storefront"
      },
      "getTaxesFromBasket": {
        "method": "GET",
        "path": "/organizations/{organizationId}/baskets/{basketId}/taxes"
      },
      "addTaxesForBasket": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/baskets/{basketId}/taxes"
      }
    }
  },
  "ShopperConfigurations": {
    "basePath": "/configuration/shopper-configurations/v1",
    "operations": {
      "getConfigurations": {
        "method": "GET",
        "path": "/organizations/{organizationId}/configurations"
      }
    }
  },
  "ShopperConsents": {
    "basePath": "/shopper/shopper-consents/v1",
    "operations": {
      "getSubscriptions": {
        "method": "GET",
        "path": "/organizations/{organizationId}/subscriptions"
      },
      "updateSubscription": {
        "method": "POST",
        "path": "/organizations/{organizationId}/subscriptions"
      },
      "updateSubscriptions": {
        "method": "POST",
        "path": "/organizations/{organizationId}/subscriptions/actions/bulk"
      }
    }
  },
  "ShopperContext": {
    "basePath": "/shopper/shopper-context/v1",
    "operations": {
      "getShopperContext": {
        "method": "GET",
        "path": "/organizations/{organizationId}/shopper-context/{usid}"
      },
      "createShopperContext": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/shopper-context/{usid}"
      },
      "deleteShopperContext": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/shopper-context/{usid}"
      },
      "updateShopperContext": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/shopper-context/{usid}"
      }
    }
  },
  "ShopperCustomers": {
    "basePath": "/customer/shopper-customers/v1",
    "operations": {
      "registerCustomer": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers"
      },
      "resetPassword": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/password/actions/reset"
      },
      "getResetPasswordToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/password/actions/create-reset-token"
      },
      "getExternalProfile": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/external-profile"
      },
      "registerExternalProfile": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/external-profile"
      },
      "getCustomer": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}"
      },
      "updateCustomer": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/customers/{customerId}"
      },
      "createCustomerAddress": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/{customerId}/addresses"
      },
      "getCustomerAddress": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/addresses/{addressName}"
      },
      "removeCustomerAddress": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/customers/{customerId}/addresses/{addressName}"
      },
      "updateCustomerAddress": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/customers/{customerId}/addresses/{addressName}"
      },
      "getCustomerBaskets": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/baskets"
      },
      "getCustomerOrders": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/orders"
      },
      "updateCustomerPassword": {
        "method": "PUT",
        "path": "/organizations/{organizationId}/customers/{customerId}/password"
      },
      "createCustomerPaymentInstrument": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-instruments"
      },
      "getCustomerPaymentInstrument": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-instruments/{paymentInstrumentId}"
      },
      "deleteCustomerPaymentInstrument": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-instruments/{paymentInstrumentId}"
      },
      "updateCustomerPaymentInstrument": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-instruments/{paymentInstrumentId}"
      },
      "deleteCustomerPaymentMethodReference": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-method-references/{paymentMethodReferenceId}"
      },
      "setupCustomerPaymentMethodReference": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-method-references/actions/setup"
      },
      "completeCustomerPaymentMethodReferenceSetup": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/{customerId}/payment-method-references/actions/complete"
      },
      "getCustomerProductLists": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists"
      },
      "createCustomerProductList": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists"
      },
      "getCustomerProductList": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}"
      },
      "deleteCustomerProductList": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}"
      },
      "updateCustomerProductList": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}"
      },
      "createCustomerProductListItem": {
        "method": "POST",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}/items"
      },
      "getCustomerProductListItem": {
        "method": "GET",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}/items/{itemId}"
      },
      "deleteCustomerProductListItem": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}/items/{itemId}"
      },
      "updateCustomerProductListItem": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/customers/{customerId}/product-lists/{listId}/items/{itemId}"
      },
      "getPublicProductListsBySearchTerm": {
        "method": "GET",
        "path": "/organizations/{organizationId}/product-lists"
      },
      "getPublicProductList": {
        "method": "GET",
        "path": "/organizations/{organizationId}/product-lists/{listId}"
      },
      "getPublicProductListItems": {
        "method": "GET",
        "path": "/organizations/{organizationId}/product-lists/{listId}/items"
      },
      "getProductListItem": {
        "method": "GET",
        "path": "/organizations/{organizationId}/product-lists/{listId}/items/{itemId}"
      }
    }
  },
  "ShopperDeliveryEstimates": {
    "basePath": "/product/shopper-delivery-estimates/v1",
    "operations": {
      "getDeliveryEstimates": {
        "method": "GET",
        "path": "/organizations/{organizationId}/delivery-estimates"
      }
    }
  },
  "ShopperExperience": {
    "basePath": "/experience/shopper-experience/v1",
    "operations": {
      "getPages": {
        "method": "GET",
        "path": "/organizations/{organizationId}/pages"
      },
      "getPage": {
        "method": "GET",
        "path": "/organizations/{organizationId}/pages/{pageId}"
      },
      "getComponent": {
        "method": "GET",
        "path": "/organizations/{organizationId}/components/{componentId}"
      },
      "getContent": {
        "method": "GET",
        "path": "/organizations/{organizationId}/contents/{id}"
      },
      "getMultipleContent": {
        "method": "GET",
        "path": "/organizations/{organizationId}/contents"
      },
      "searchContent": {
        "method": "GET",
        "path": "/organizations/{organizationId}/content-search"
      },
      "getContentFolder": {
        "method": "GET",
        "path": "/organizations/{organizationId}/folders/{id}"
      },
      "getContentFolders": {
        "method": "GET",
        "path": "/organizations/{organizationId}/folders"
      },
      "resolveQualifiers": {
        "method": "POST",
        "path": "/organizations/{organizationId}/qualifiers/resolve"
      }
    }
  },
  "ShopperGiftCertificates": {
    "basePath": "/pricing/shopper-gift-certificates/v1",
    "operations": {
      "getGiftCertificate": {
        "method": "POST",
        "path": "/organizations/{organizationId}/gift-certificate"
      }
    }
  },
  "ShopperLogin": {
    "basePath": "/shopper/auth/v1",
    "operations": {
      "authenticateCustomer": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/login"
      },
      "authorizePasswordlessCustomer": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/passwordless/login"
      },
      "logoutCustomer": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/logout"
      },
      "authorizeCustomer": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/authorize"
      },
      "getAccessToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/token"
      },
      "getSessionBridgeAccessToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/session-bridge/token"
      },
      "getTrustedSystemAccessToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/trusted-system/token"
      },
      "getTrustedAgentAuthorizationToken": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/trusted-agent/authorize"
      },
      "getTrustedAgentAccessToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/trusted-agent/token"
      },
      "getPasswordResetToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/password/reset"
      },
      "resetPassword": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/password/action"
      },
      "getPasswordLessAccessToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/passwordless/token"
      },
      "revokeToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/revoke"
      },
      "introspectToken": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/introspect"
      },
      "getUserInfo": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/userinfo"
      },
      "getWellknownOpenidConfiguration": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/.well-known/openid-configuration"
      },
      "getJwksUri": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/jwks"
      },
      "authorizeWebauthnRegistration": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/webauthn/register/authorize"
      },
      "startWebauthnUserRegistration": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/webauthn/register/start"
      },
      "finishWebauthnUserRegistration": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/webauthn/register/finish"
      },
      "startWebauthnAuthentication": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/webauthn/authenticate/start"
      },
      "finishWebauthnAuthentication": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/webauthn/authenticate/finish"
      },
      "getPasskeyUserByLoginId": {
        "method": "GET",
        "path": "/organizations/{organizationId}/oauth2/webauthn/passkey/user/{loginId}"
      },
      "deletePasskeyUser": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/oauth2/webauthn/passkey/user/{loginId}"
      },
      "deletePasskeyCredential": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/oauth2/webauthn/passkey/user/{loginId}/credentials/{credentialId}"
      },
      "requestOtp": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/otp/request"
      },
      "verifyOtp": {
        "method": "POST",
        "path": "/organizations/{organizationId}/oauth2/otp/verify"
      }
    }
  },
  "ShopperOrders": {
    "basePath": "/checkout/shopper-orders/v1",
    "operations": {
      "createOrder": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders"
      },
      "getOmsMetaData": {
        "method": "GET",
        "path": "/organizations/{organizationId}/orders/oms-meta-data"
      },
      "getOrder": {
        "method": "GET",
        "path": "/organizations/{organizationId}/orders/{orderNo}"
      },
      "guestOrderLookup": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders/{orderNo}/lookup"
      },
      "failOrder": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders/{orderNo}/actions/fail"
      },
      "cancelOmsOrder": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders/{orderNo}/actions/oms-cancel-order"
      },
      "returnOmsOrder": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders/{orderNo}/actions/oms-return-order"
      },
      "requestOrderAccessCode": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders/{orderNo}/actions/request-access-code"
      },
      "createPaymentInstrumentForOrder": {
        "method": "POST",
        "path": "/organizations/{organizationId}/orders/{orderNo}/payment-instruments"
      },
      "removePaymentInstrumentFromOrder": {
        "method": "DELETE",
        "path": "/organizations/{organizationId}/orders/{orderNo}/payment-instruments/{paymentInstrumentId}"
      },
      "updatePaymentInstrumentForOrder": {
        "method": "PATCH",
        "path": "/organizations/{organizationId}/orders/{orderNo}/payment-instruments/{paymentInstrumentId}"
      },
      "getPaymentMethodsForOrder": {
        "method": "GET",
        "path": "/organizations/{organizationId}/orders/{orderNo}/payment-methods"
      },
      "getTaxesFromOrder": {
        "method": "GET",
        "path": "/organizations/{organizationId}/orders/{orderNo}/taxes"
      }
    }
  },
  "ShopperPayments": {
    "basePath": "/checkout/shopper-payments/v1",
    "operations": {
      "getPaymentConfiguration": {
        "method": "GET",
        "path": "/organizations/{organizationId}/payment-configuration"
      },
      "getPaymentInstrumentBalance": {
        "method": "POST",
        "path": "/organizations/{organizationId}/payment-instruments/balance"
      }
    }
  },
  "ShopperProducts": {
    "basePath": "/product/shopper-products/v1",
    "operations": {
      "getProducts": {
        "method": "GET",
        "path": "/organizations/{organizationId}/products"
      },
      "getProduct": {
        "method": "GET",
        "path": "/organizations/{organizationId}/products/{id}"
      },
      "getProductImages": {
        "method": "GET",
        "path": "/organizations/{organizationId}/products/{productId}/images"
      },
      "getProductPrices": {
        "method": "GET",
        "path": "/organizations/{organizationId}/products/{productId}/prices"
      },
      "getProductPromotions": {
        "method": "GET",
        "path": "/organizations/{organizationId}/products/{productId}/promotions"
      },
      "getCategories": {
        "method": "GET",
        "path": "/organizations/{organizationId}/categories"
      },
      "getCategory": {
        "method": "GET",
        "path": "/organizations/{organizationId}/categories/{id}"
      }
    }
  },
  "ShopperPromotions": {
    "basePath": "/pricing/shopper-promotions/v1",
    "operations": {
      "getPromotions": {
        "method": "GET",
        "path": "/organizations/{organizationId}/promotions"
      },
      "getPromotionsForCampaign": {
        "method": "GET",
        "path": "/organizations/{organizationId}/promotions/campaigns/{campaignId}"
      }
    }
  },
  "ShopperSearch": {
    "basePath": "/search/shopper-search/v1",
    "operations": {
      "productSearch": {
        "method": "GET",
        "path": "/organizations/{organizationId}/product-search"
      },
      "getSearchSuggestions": {
        "method": "GET",
        "path": "/organizations/{organizationId}/search-suggestions"
      }
    }
  },
  "ShopperSeo": {
    "basePath": "/site/shopper-seo/v1",
    "operations": {
      "getUrlMapping": {
        "method": "GET",
        "path": "/organizations/{organizationId}/url-mapping"
      }
    }
  },
  "ShopperStores": {
    "basePath": "/store/shopper-stores/v1",
    "operations": {
      "getStores": {
        "method": "GET",
        "path": "/organizations/{organizationId}/stores"
      },
      "searchStores": {
        "method": "GET",
        "path": "/organizations/{organizationId}/store-search"
      }
    }
  }
};
