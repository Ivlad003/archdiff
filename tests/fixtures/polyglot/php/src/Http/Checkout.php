<?php
namespace App\Http;

use App\Domain\Orders;
use App\Store\OrderStore;

function checkout(string $id, int $total): array
{
    $orders = new Orders(new OrderStore());
    return $orders->place($id, $total);
}
