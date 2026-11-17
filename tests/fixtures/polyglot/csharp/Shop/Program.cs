using Microsoft.AspNetCore.Builder;
using Serilog;
using Shop.Orders;
using Shop.Web;

// The shop's program: the C# side of the sample.
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var controller = new OrdersController(new OrderService(new MemoryOrders()));

Log.Information("starting");
app.MapPost("/orders", (string id, long total) => controller.Place(id, total));
app.MapGet("/orders/{id}", controller.Show);
app.Run();
