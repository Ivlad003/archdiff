"""A store kept in memory."""
rows = {}


def save_order(order):
    rows[order["id"]] = order


def read_order(order_id):
    return rows.get(order_id)
