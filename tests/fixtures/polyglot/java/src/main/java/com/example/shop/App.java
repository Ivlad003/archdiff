package com.example.shop;

import com.example.shop.orders.OrderService;
import com.example.shop.store.MemoryOrders;
import com.example.shop.web.OrderController;

/** The shop's program: the Java side of the sample. */
public final class App {
    private App() {
    }

    public static void main(String[] args) {
        OrderService service = new OrderService(new MemoryOrders());
        OrderController controller = new OrderController(service);
        System.out.println(controller.place(args[0], 1));
    }
}
