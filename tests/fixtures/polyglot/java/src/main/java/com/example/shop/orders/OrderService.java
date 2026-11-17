package com.example.shop.orders;

import com.example.shop.store.OrderRepository;
import java.util.Optional;

/** Places and finds orders. */
public class OrderService {
    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    /** Checks an order and saves it. */
    public Order place(String id, long total) {
        Order order = new Order(id, total);

        if (!order.valid()) {
            throw new IllegalArgumentException("negative total");
        }

        repository.save(order);
        Audit.record(order);

        return order;
    }

    public Optional<Order> find(String id) {
        return repository.read(id);
    }

    /** What the service writes down, kept beside it. */
    static final class Audit {
        private Audit() {
        }

        static void record(Order order) {
            System.out.println(order);
        }
    }
}
