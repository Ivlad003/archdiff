package com.example.shop.store;

import com.example.shop.orders.*;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/** Orders kept in memory. */
public class MemoryOrders implements OrderRepository {
    private final Map<String, Order> orders = new HashMap<>();

    @Override
    public void save(Order order) {
        orders.put(order.id(), order);
    }

    @Override
    public Optional<Order> read(String id) {
        return Optional.ofNullable(orders.get(id));
    }
}
