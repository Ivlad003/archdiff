Feature: State machines and control flow
  archdiff finds the state machines a repository has, explicit or written with literals, and frames the calls under a branch or a loop in a sequence.
  The scenarios here are the ones tests/cli.test.ts runs on tests/fixtures/machines.

  Scenario: An implicit machine written with literals
    Given src/order.ts sets order.status under a switch and an if on order.status
    When I run "archdiff diagram machine:src/order.ts#status"
    Then the Mermaid is a stateDiagram-v2
    And the transitions include new → paid by pay, paid → shipped by ship and any state → new by reset
    And refunded is listed as declared by the type and never set

  Scenario: An explicit XState machine
    When I run "archdiff diagram machine:src/light.ts#light --format mermaid"
    Then the initial state is green
    And yellow → red on TIMER, red → green after 5000 and red → red on PANIC are drawn

  Scenario: A Python class with a state
    When I run "archdiff diagram machine:src/door.py#state --format mermaid"
    Then the initial state is closed
    And closed → open by Door.open and closed → locked by Door.lock are drawn

  Scenario: Two entities with a field of one name
    Given a file that sets "order.status" with "order: Order" and "payment.status" with "payment: Payment"
    When I run "archdiff views"
    Then it lists "machine:src/flows.ts#Order.status" and "machine:src/flows.ts#Payment.status"
    And the payment's machine holds pending, settled and failed only

  Scenario: The list of machines
    When I run "archdiff diagram machines"
    Then the title is "State machines (3)"
    And an unknown machine exits 2

  Scenario: A sequence with fragments
    When I run "archdiff diagram sequence:src/checkout.ts#checkout"
    Then a loop fragment frames pay() with opt rush and opt not rush nested inside it
    And opt try and opt catch follow
