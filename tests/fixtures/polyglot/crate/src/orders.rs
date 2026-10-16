//! Orders: the Rust side of the sample.
use crate::store::{read_order, save_order};

pub struct Order {
    pub id: String,
    pub total: i64,
}

pub fn place_order(id: &str, total: i64) -> Order {
    let order = Order { id: id.to_string(), total };
    validate(&order);
    save_order(&order);
    order
}

fn validate(order: &Order) {
    assert!(order.total >= 0);
}

pub fn find_order(id: &str) -> Option<Order> {
    read_order(id)
}
