// A helper module of the integration tests, reached by `mod util;` from each test file.
use sample::orders::Order;

pub fn sample_order() -> Order {
    Order { id: "a".to_string(), total: 1 }
}
