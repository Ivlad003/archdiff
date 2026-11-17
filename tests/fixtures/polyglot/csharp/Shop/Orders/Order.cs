namespace Shop.Orders;

/// <summary>One order.</summary>
public record Order(string Id, long Total)
{
    /// <summary>Whether the order may be placed.</summary>
    public bool IsValid() => Total >= 0;
}
