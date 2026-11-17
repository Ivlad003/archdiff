package com.example.shop.web;

import com.example.shop.orders.Order;
import com.example.shop.orders.OrderService;

/** The HTTP face of the orders. */
public class OrderController {
    private final OrderService orders;

    public OrderController(OrderService orders) {
        this.orders = orders;
    }

    /** POST /orders. */
    public String place(String id, long total) {
        try {
            Order order = orders.place(id, total);

            return render(order);
        } catch (IllegalArgumentException refused) {
            return "400 " + refused.getMessage();
        }
    }

    /** GET /orders/{id}. */
    public String show(String id) {
        return orders.find(id).map(this::render).orElse("404");
    }

    private String render(Order order) {
        return order.id() + " " + order.total();
    }
}
