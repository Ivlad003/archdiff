// Package store keeps the orders.
package store

// Order is one order.
type Order struct {
	ID    string
	Total int64
}

// Saver is what a store of orders does.
type Saver interface {
	Save(order Order)
	Read(id string) (Order, bool)
}

// Repo keeps orders in memory.
type Repo struct {
	orders map[string]Order
}

// NewRepo makes an empty repo.
func NewRepo() *Repo {
	return &Repo{orders: map[string]Order{}}
}

// Save keeps an order.
func (r *Repo) Save(order Order) {
	r.orders[order.ID] = order
}

// Read gives an order back.
func (r *Repo) Read(id string) (Order, bool) {
	order, ok := r.orders[id]

	return order, ok
}
