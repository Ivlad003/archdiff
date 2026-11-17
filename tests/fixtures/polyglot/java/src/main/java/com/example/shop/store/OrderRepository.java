package com.example.shop.store;

import com.example.shop.orders.Order;
import java.util.Optional;

/** What a store of orders does. */
public interface OrderRepository {
    void save(Order order);

    Optional<Order> read(String id);
}
