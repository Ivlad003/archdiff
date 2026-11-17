package com.example.shop.orders;

import com.example.shop.store.MemoryOrders;

class OrderServiceTest {
    void placesAnOrder() {
        OrderService service = new OrderService(new MemoryOrders());
        service.place("a", 1);
    }
}
