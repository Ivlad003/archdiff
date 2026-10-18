# Agent Specification

## Purpose

A drawn change becomes a task a coding agent builds, in this repository, from the Chat tab or the terminal, with the contract as its guide and the user as the one who decides.

## Requirements

### Requirement: The agent is picked on the page, never implied

The system SHALL offer, in the Chat tab, the coding agents installed on this computer — Claude Code (`claude -p --output-format stream-json --verbose --permission-mode acceptEdits`), Cursor's CLI (`cursor-agent -p --output-format stream-json --trust`), Codex (`codex exec --json` in its workspace-write sandbox, resumed by `codex exec resume <id>`), OpenCode (`opencode run --format json --auto`, resumed by `--session <id>`) and a custom command of `archdiff.json` (`agent.command`, with the `protocol` it prints: `stream-json`, `codex` or `opencode`) — the ones not installed greyed out, and "none" (the tasks only written). `GET /api/agents` SHALL list them with whether each is installed, and the one picked first: `--agent` or `archdiff.json`'s `agent`, else the first installed; the page SHALL remember the pick in the browser. Every run SHALL name its agent, a follow-up the one that holds the session; an agent unknown or not installed SHALL be refused (400) by name. Every run SHALL start from a button or a command with the prompt as shown, and every prompt sent to an agent — a run, a document to become the contract, the mocks of a flow — SHALL be saved under `.archdiff/tasks/` (`GET /api/tasks` lists them, newest first). A POST whose Origin is not the server's own SHALL be refused (403): a page of another site cannot start an agent.

#### Scenario: No agent picked

- **WHEN** the reader picks "none", or no agent is installed
- **THEN** the Chat tab writes the task, says why it does not run it, and the run button is off

#### Scenario: Codex picked

- **WHEN** the reader picks Codex and runs a task
- **THEN** the run's events show its session, its messages, the files it wrote and its last message as the answer, and the follow-up resumes the same thread

#### Scenario: The prompt of the mocks is kept

- **WHEN** the Flow tab asks the agent for the mocks of `calls:src/lib/orders.ts#placeOrder`
- **THEN** `.archdiff/tasks/` holds a file named after the view with the prompt sent

### Requirement: The task comes from the drawing

The system SHALL read the saved drawing of a view against the code graph (`archdiff plan`): a shape with a name is a new module or function, an arrow an import or call, a deleted shape a removal, text a note; and write a Markdown task with the files and lines it touches, a warning for a new dependency between layers, and the rules to keep.

#### Scenario: A drawn module and arrow

- **WHEN** the drawing holds a shape `src/lib/refunds.ts` and an arrow from `orders.ts` to it
- **THEN** the task says "A new module `src/lib/refunds.ts` in layer **lib**" and "`src/lib/orders.ts` imports `src/lib/refunds.ts` (new)"

### Requirement: Every run carries the protocol

The system SHALL append to every new run the archdiff protocol: `ARCHITECTURE.md` is the contract to keep true; when a decision is the user's, write one fenced `archdiff-question` block with JSON `{"question", "options"}` and stop; finish with the files changed as `file:line`. A resumed session SHALL not repeat it.

#### Scenario: The agent asks

- **WHEN** the agent's text holds an `archdiff-question` block with three options
- **THEN** the Chat tab shows the question with three buttons and a field for another answer, and the chosen answer resumes the agent's session

### Requirement: The Chat tab's commands

The system SHALL offer "code this" (the drawing into the contract, then the agent builds what the contract names and the code lacks), "improve the diagram" (the agent reviews and edits the contract, asking about real choices), "from document" (a pasted note becomes the contract), `@` tags (`@module:`, `@fn:`, `@layer:`, `@dir:`, `@flow:`, `@type:`) with suggestions expanded into context, and slash lines `/code`, `/diagram …`, `/doc`.

#### Scenario: code this on a fresh contract

- **WHEN** "code this" is pressed on the intent view of a project whose contract names modules the code lacks
- **THEN** the agent runs with a task listing those modules, and when it finishes the picture reloads with them built

### Requirement: A question is answered, not built

The system SHALL send a question typed in the Chat tab's first row to the agent with the instruction to answer and change no file, with the selected shapes attached as tags (`@module:`, `@fn:`, `@logic:`, …) and, when the box is ticked, the current picture as `@view:<key>` with its options, every tag expanded into its Markdown; without an agent the question with its context SHALL go into the task box. The transcript SHALL show the question, fold the agent's tool calls and thoughts under one summary line, render the result as the answer, and list the checks and the exit under it.

#### Scenario: A question about the picture

- **WHEN** "What does this layer do?" is sent with the picture ticked
- **THEN** the prompt holds `@view:layer:lib` expanded into the picture's Markdown, the transcript's own row reads the question "(with the picture)", and the answer is rendered under the folded steps

### Requirement: The agent's work is visible

The system SHALL stream the agent's events into the Chat tab, light the shapes of the files it reads or edits while it works, reload the picture when it finishes, and offer the review against the base.

#### Scenario: Files touched

- **WHEN** the agent writes `src/lib/refunds.ts`
- **THEN** that shape lights on the canvas during the run

### Requirement: Mocks for a flow

The system SHALL generate the mock input and storages of a call flow from the types, or from a description through the agent when one is configured and answers JSON, and carry values to parameters and properties of the same name; nothing is executed.

#### Scenario: No agent, mocks from types

- **WHEN** mocks are asked for a `calls:` view without an agent
- **THEN** the answer's source is "types"

### Requirement: The checks run after the agent

The system SHALL, when an agent's run ends, run the contract check and the commands `archdiff.json` names in `checks`, each in a shell in the repository with a time limit, and append their results to the run's events before the exit (✔ with the command, or ✘ with the exit code and the tail of the output); `POST /api/checks` and the Chat tab's *run checks* SHALL run them on request. Claude Code SHALL be allowed exactly those commands, archdiff itself and the OpenSpec CLI (`--allowedTools Bash(<command>:*)`).

#### Scenario: One check passes, one fails

- **WHEN** archdiff.json names a command that exits 0 and one that writes "boom" and exits 3, and a run ends
- **THEN** the run's events hold "✔ archdiff check: the code follows ARCHITECTURE.md", a ✔ line for the first command and a ✘ line "(exit 3)" ending in "boom", then the exit

### Requirement: Every agent's stream is read like Claude's

The system SHALL read Cursor's stream-json (`chat_id` as the session, `--resume <chatId>` to continue) the way it reads Claude Code's, including the question protocol; Codex's events (`thread.started`, the `item.completed` of an agent message, a command, a file change, `turn.completed`) and OpenCode's (`text`, `tool_use`, the `sessionID` of every event) SHALL become the same kinds of events — the session, the text, the tool with the files it names, the answer, which for both is their last message.

#### Scenario: A question through Cursor

- **WHEN** a Cursor-format agent answers with an archdiff-question block and the user picks an option
- **THEN** the next run resumes the chat with the answer
