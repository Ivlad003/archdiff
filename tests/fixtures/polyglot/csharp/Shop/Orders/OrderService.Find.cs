using System;

namespace Shop.Orders;

// The reading half of the service: a part of the class in a file of its own.
public partial class OrderService
{
    public Order? Find(string id)
    {
        return _repository.Read(id);
    }

    private void Audit(Order order)
    {
        Console.WriteLine(order);
    }
}
