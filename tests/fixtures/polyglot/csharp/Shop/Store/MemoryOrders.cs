using System.Collections.Generic;
using Shop.Orders;

namespace Shop.Store;

/// <summary>Orders kept in memory.</summary>
public class MemoryOrders : IOrderRepository
{
    private readonly Dictionary<string, Order> _orders = new();

    public void Save(Order order)
    {
        _orders[order.Id] = order;
    }

    public Order? Read(string id)
    {
        return _orders.TryGetValue(id, out var order) ? order : null;
    }
}
