package orders

import (
	"testing"

	"example.com/shop/internal/store"
)

func TestPlaceOrder(t *testing.T) {
	service := NewService(store.NewRepo())

	if _, err := service.PlaceOrder("a", -1); err == nil {
		t.Fatal("a negative total must be refused")
	}
}
