"""Orders: the Python side of the sample."""
import json
from app.store import save_order, read_order


def place_order(order_id: str, total: int) -> dict:
    order = {"id": order_id, "total": total}
    validate(order)
    save_order(order)
    print(json.dumps(order))
    return order


def validate(order: dict) -> None:
    if order["total"] < 0:
        raise ValueError("negative")


def find_order(order_id: str):
    return read_order(order_id)
