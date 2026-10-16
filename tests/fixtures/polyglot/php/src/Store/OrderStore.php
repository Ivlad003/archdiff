<?php
namespace App\Store;

class OrderStore
{
    private array $rows = [];

    public function save(array $order): void
    {
        $this->rows[$order['id']] = $order;
    }

    public function read(string $id): ?array
    {
        return $this->rows[$id] ?? null;
    }
}
