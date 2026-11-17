using Shop.Orders;
using Shop.Store;

namespace Shop.Tests;

public class OrderServiceTests
{
    public void PlacesAnOrder()
    {
        var service = new OrderService(new MemoryOrders());
        service.Place("a", 1);
    }
}
