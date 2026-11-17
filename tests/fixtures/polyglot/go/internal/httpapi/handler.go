// Package httpapi is the HTTP face of the orders.
package httpapi

import (
	"encoding/json"
	"net/http"

	"example.com/shop/internal/orders"
)

// Handler serves the orders over HTTP.
type Handler struct {
	orders *orders.Service
}

// NewHandler makes a handler over the orders.
func NewHandler(service *orders.Service) *Handler {
	return &Handler{orders: service}
}

// Place handles POST /orders.
func (h *Handler) Place(w http.ResponseWriter, r *http.Request) {
	order, err := h.orders.PlaceOrder(r.URL.Query().Get("id"), 1)

	switch {
	case err != nil:
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		json.NewEncoder(w).Encode(order)
	}
}
