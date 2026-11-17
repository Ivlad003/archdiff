// Command shop serves the orders: the Go side of the sample.
package main

import (
	"log"
	"net/http"

	"example.com/shop/internal/httpapi"
	"example.com/shop/internal/orders"
	"example.com/shop/internal/store"
)

func main() {
	repo := store.NewRepo()
	service := orders.NewService(repo)
	handler := httpapi.NewHandler(service)

	http.HandleFunc("/orders", handler.Place)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
