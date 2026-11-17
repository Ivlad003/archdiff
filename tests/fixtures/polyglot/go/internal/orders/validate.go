package orders

import (
	"errors"

	"example.com/shop/internal/store"
)

var errNegative = errors.New("negative total")

func validate(order store.Order) error {
	if order.Total < 0 {
		return errNegative
	}

	return nil
}
