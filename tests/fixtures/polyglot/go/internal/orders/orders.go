// Package orders places and finds orders.
package orders

import "example.com/shop/internal/store"

// Service places orders into a store.
type Service struct {
	repo *store.Repo
}

// NewService makes a service over a repo.
func NewService(repo *store.Repo) *Service {
	return &Service{repo: repo}
}

// PlaceOrder checks an order and saves it.
func (s *Service) PlaceOrder(id string, total int64) (store.Order, error) {
	order := store.Order{ID: id, Total: total}

	if err := validate(order); err != nil {
		return order, err
	}

	s.repo.Save(order)

	return order, nil
}
