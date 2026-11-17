using System;
using Shop.Orders;

namespace Shop.Web;

/// <summary>The HTTP face of the orders.</summary>
public class OrdersController
{
    private readonly OrderService _orders;

    public OrdersController(OrderService orders)
    {
        _orders = orders;
    }

    /// <summary>POST /orders.</summary>
    public string Place(string id, long total)
    {
        try
        {
            var order = _orders.Place(id, total);

            return Render(order);
        }
        catch (ArgumentException refused)
        {
            return "400 " + refused.Message;
        }
    }

    /// <summary>GET /orders/{id}.</summary>
    public string Show(string id)
    {
        var order = _orders.Find(id);

        return order is null ? "404" : Render(order);
    }

    private static string Render(Order order) => order.Id + " " + order.Total;
}
