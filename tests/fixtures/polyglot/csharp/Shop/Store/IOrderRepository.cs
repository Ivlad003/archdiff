using Shop.Orders;

namespace Shop.Store;

/// <summary>What a store of orders does.</summary>
public interface IOrderRepository
{
    void Save(Order order);

    Order? Read(string id);
}
