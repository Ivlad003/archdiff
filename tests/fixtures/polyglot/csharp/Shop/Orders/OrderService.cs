using System;

namespace Shop.Orders
{
    /// <summary>
    /// Places and finds orders.
    /// </summary>
    public partial class OrderService
    {
        private readonly IOrderRepository _repository;

        public OrderService(IOrderRepository repository)
        {
            _repository = repository;
        }

        /// <summary>Checks an order and saves it.</summary>
        public Order Place(string id, long total)
        {
            var order = new Order(id, total);

            if (!order.IsValid())
            {
                throw new ArgumentException("negative total");
            }

            _repository.Save(order);
            Audit(order);

            return order;
        }
    }
}
