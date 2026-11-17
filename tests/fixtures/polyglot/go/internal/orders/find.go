package orders

import "example.com/shop/internal/store"

// FindOrder reads an order back: a method of Service written in another file than the type.
func (s *Service) FindOrder(id string) (store.Order, bool) {
	return s.lookup(id)
}

func (s *Service) lookup(id string) (store.Order, bool) {
	repo := store.NewRepo()

	return repo.Read(id)
}
