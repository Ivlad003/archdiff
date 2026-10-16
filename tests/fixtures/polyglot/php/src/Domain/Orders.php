<?php
namespace App\Domain;

use App\Store\OrderStore;

/** Orders: the PHP side of the sample. */
class Orders
{
    public function __construct(private OrderStore $store)
    {
    }

    public function place(string $id, int $total): array
    {
        $order = ['id' => $id, 'total' => $total];
        $this->validate($order);
        $this->store->save($order);
        return $order;
    }

    private function validate(array $order): void
    {
        if ($order['total'] < 0) {
            throw new \InvalidArgumentException('negative');
        }
    }
}
