"""A door with a state, written as Python classes write them."""


class Door:
    def __init__(self):
        self.state = "closed"

    def open(self):
        if self.state == "closed":
            self.state = "open"

    def lock(self):
        match self.state:
            case "closed":
                self.state = "locked"
            case "open":
                raise ValueError("close it first")
