package com.example.shop.orders;

/** One order. */
public record Order(String id, long total) {
    /** Whether the order may be placed. */
    public boolean valid() {
        return total >= 0;
    }
}
