use crate::orders::Order;

pub fn save_order(_order: &Order) {}

pub fn read_order(_id: &str) -> Option<Order> {
    None
}
