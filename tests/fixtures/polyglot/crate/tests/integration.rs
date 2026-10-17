// An integration test: a crate of its own, rooted at this file.
mod util;

use sample::orders::{place_order, Order};

fn setup() -> Order {
    util::sample_order()
}

#[test]
fn places_an_order() {
    let order = setup();
    place_order(&order.id, order.total);
}
