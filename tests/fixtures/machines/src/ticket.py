from transitions import Machine


class Ticket:
    """A support ticket whose life the `transitions` package keeps."""

    def __init__(self):
        self.machine = Machine(
            model=self,
            states=["open", "assigned", "closed"],
            transitions=[
                {"trigger": "assign", "source": "open", "dest": "assigned"},
                ["close", "assigned", "closed"],
            ],
            initial="open",
        )
        self.machine.add_transition("reopen", ["closed", "assigned"], "open")
