# Agent Specification

## Purpose

A drawn change becomes a task a coding agent builds, in this repository, from the Chat tab or the terminal, with the contract as its guide and the user as the one who decides.

## Requirements

### Requirement: The agent is picked on the page, never implied

The system SHALL offer, in the Chat tab, the coding agents installed on this computer — Claude Code (`claude -p --output-format stream-json --verbose --permission-mode acceptEdits`), Cursor's CLI (`cursor-agent -p --output-format stream-json --trust`), Codex (`codex exec --json` in its workspace-write sandbox, resumed by `codex exec resume <id>`), OpenCode (`opencode run --format json --auto`, resumed by `--session <id>`) and a custom command of `archdiff.json` (`agent.command`, with the `protocol` it prints: `stream-json`, `codex` or `opencode`) or of the user's settings — the ones not installed greyed out, and "none" (the tasks only written). `GET /api/agents` SHALL list them with whether each is installed, and the one picked first: `--agent` or `archdiff.json`'s `agent`, else the first installed; the page SHALL remember the pick in the browser. Every run SHALL name its agent, a follow-up the one that holds the session; an agent unknown or not installed SHALL be refused (400) by name. Every run SHALL start from a button or a command with the prompt as shown, and every prompt sent to an agent — a run, a document to become the contract, the mocks of a flow — SHALL be saved under `.archdiff/tasks/` (`GET /api/tasks` lists them, newest first). A POST whose Origin is not the server's own SHALL be refused (403): a page of another site cannot start an agent.

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

#### Scenario: An answer given before the turn ends

- **WHEN** the reader picks an option while the agent's turn still runs (its result, the checks after it)
- **THEN** the answer is kept and sent to the agent's session as soon as the turn ends, and the run's line says so; a question typed in the ask row meanwhile stays in its field

### Requirement: The Chat tab's commands

The system SHALL offer "code this" (the drawing into the contract, then the agent builds what the contract names and the code lacks), "improve the diagram" (the agent reviews and edits the contract, asking about real choices), "from document" (a pasted note becomes the contract), `@` tags (`@module:`, `@fn:`, `@layer:`, `@dir:`, `@flow:`, `@type:`) with suggestions expanded into context, and slash lines `/code`, `/diagram …`, `/doc`.

#### Scenario: code this on a fresh contract

- **WHEN** "code this" is pressed on the intent view of a project whose contract names modules the code lacks
- **THEN** the agent runs with a task listing those modules, and when it finishes the picture reloads with them built

### Requirement: A question is answered, not built

The system SHALL send a question typed in the Chat tab's first row to the agent with the instruction to answer and change no file, with the selected shapes attached as tags (`@module:`, `@fn:`, `@logic:`, …) and, when the box is ticked, the current picture as `@view:<key>` with its options, every tag expanded into its Markdown; without an agent the question with its context SHALL go into the task box. The transcript SHALL show the question, fold the agent's tool calls and thoughts under one summary line, render the result as the answer, and list the checks, the run's report and the exit under it.

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

The system SHALL, when an agent's run ends, run the contract check (held against the baseline of known violations, as `archdiff check` holds it) and the commands `archdiff.json` names in `checks`, each in a shell in the repository with a time limit, and append their results to the run's events before the exit (✔ with the command, or ✘ with the exit code and the tail of the output); `POST /api/checks` and the Chat tab's *run checks* SHALL run them on request. Claude Code SHALL be allowed exactly those commands, archdiff itself and the OpenSpec CLI (`--allowedTools Bash(<command>:*)`).

#### Scenario: One check passes, one fails

- **WHEN** archdiff.json names a command that exits 0 and one that writes "boom" and exits 3, and a run ends
- **THEN** the run's events hold "✔ archdiff check: the code follows ARCHITECTURE.md", a ✔ line for the first command and a ✘ line "(exit 3)" ending in "boom", then the exit

### Requirement: A run is reported against the state before it

The system SHALL, when a run is started from the page, record the violations the contract check finds at that moment — the imports against the contract's layers and the violations of the rules of `archdiff.json`, whether the baseline knows them or not — and, when the run ends, append to its events after the checks and before the exit, as events of the kind `report`, which of them the run fixed ("✔ the run fixed N violations"), which survive it ("• N violations survive the run", saying how many the baseline knows and marking each of those) and which it added ("✘ the run added N violations"), each violation on a line of its own with its file and line, the first ten of a group and then how many more there are. A violation SHALL be the same before and after by its rule, the module it is in and what that imports, not by its line. A group with no violation SHALL not be said, and a run that neither started with a violation nor left one SHALL add no such event; when the violations cannot be told (a configuration that does not read) the run SHALL go on without a report. The Chat tab SHALL show these events under the checks, not folded with the agent's steps: what was fixed in the colour of a check that passed, what was added in the colour of one that failed.

#### Scenario: A run fixes one violation and adds another

- **WHEN** the code has two imports against the contract and one of a rule that the baseline knows, and a run removes one of the imports and writes a new import against the contract
- **THEN** the run's events hold, after the contract check, "✔ the run fixed 1 violation" with the import removed, "• 2 violations survive the run (1 known, in archdiff-baseline.json)" with the two left, and "✘ the run added 1 violation" with the new one, then the exit

#### Scenario: A run that changes nothing

- **WHEN** a run edits no file of a repository with three violations
- **THEN** its events hold "• 3 violations survive the run" and nothing of fixing or adding

#### Scenario: Code that follows its contract

- **WHEN** a run starts and ends with no violation
- **THEN** its events hold the checks and no report

### Requirement: Every agent's stream is read like Claude's

The system SHALL read Cursor's stream-json (`chat_id` as the session, `--resume <chatId>` to continue) the way it reads Claude Code's, including the question protocol; Codex's events (`thread.started`, the `item.completed` of an agent message, a command, a file change, `turn.completed`) and OpenCode's (`text`, `tool_use`, the `sessionID` of every event) SHALL become the same kinds of events — the session, the text, the tool with the files it names, the answer, which for both is their last message.

#### Scenario: A question through Cursor

- **WHEN** a Cursor-format agent answers with an archdiff-question block and the user picks an option
- **THEN** the next run resumes the chat with the answer

### Requirement: An agent is found where it is installed, and started as what it is

The system SHALL look for an agent's command in the directories of the PATH and then where the agents' installers put them for the user — `~/.local/bin`, `~/.opencode/bin`, and npm's directory on Windows — and SHALL take a command given as a path for that file or nothing. On Windows, where a command installed by npm is a batch file, the system SHALL start what the file runs — the program it names, or the script it names with node (the one beside the shim, else the one the server runs on) — with the task as one argument exactly as it was written, and SHALL refuse a batch file that is no such shim, saying that it cannot take a task of several lines. An agent that cannot be started SHALL be offered as not installed, with the reason; stopping a run on Windows SHALL end the processes the agent started with it.

#### Scenario: Codex installed by npm on Windows

- **WHEN** `codex` is the shim `codex.cmd` and the reader runs a task of several lines with quotes, `&` and `%PATH%` in it
- **THEN** node runs the script the shim names, and the task reaches it whole as its last argument

#### Scenario: Claude Code off the server's PATH

- **WHEN** the server's PATH lacks `~/.local/bin` and `claude` is installed there
- **THEN** the Chat tab offers Claude Code, and the settings show the program started for it

#### Scenario: A batch file that is no shim

- **WHEN** an agent's command is a batch file that names no file beside itself
- **THEN** the agent is offered as not installed, and the reason names the file and says to name the program it runs

### Requirement: The agents and the keys are the user's settings

The system SHALL keep the user's settings in `<home>/.archdiff/settings.json` (`ARCHDIFF_HOME` names another home), written for the user alone and never in the repository: for a built-in agent the program to start when it is not found by its name, the model it is told to use (`--model` for Claude Code and Cursor, `-m` for OpenCode, the `model` configuration value for Codex) and, for Claude Code, whether it goes through OpenRouter; agents of the user's own (a name, a command, the protocol, the resume flag); and the keys — environment variables named `…_KEY` or `…_TOKEN`, each one line. Every agent run SHALL get the keys in its environment over the server's own, and no event of a run SHALL show a key's value. `GET /api/settings` SHALL list every agent with the program started for it or why it cannot run, and each key by its name and last four characters, never its value; `POST /api/settings` SHALL replace `agents` and `custom` when given and set (a string) or forget (null) each key of `keys`, refusing a wrong change whole with the field named, and a change to a file that does not read as settings. Both SHALL answer the computer archdiff runs on and refuse any other address with 403. Claude Code set to go through OpenRouter SHALL run with `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, OpenRouter's key (`OPENROUTER_API_KEY` of the settings, else of the server's environment) as `ANTHROPIC_AUTH_TOKEN` and an empty `ANTHROPIC_API_KEY`, and SHALL not be offered, saying why, while there is no key.

#### Scenario: A key is set

- **WHEN** the reader sets `OPENROUTER_API_KEY` in the settings and runs an agent that prints its environment
- **THEN** the settings list the key as set with its last four characters, the agent has it, and the run's events show `•••` in its place

#### Scenario: A model for OpenCode

- **WHEN** the settings give OpenCode the model `openrouter/anthropic/claude-sonnet-4.5`
- **THEN** every run of OpenCode ends its arguments with `-m openrouter/anthropic/claude-sonnet-4.5` before the task

#### Scenario: Claude Code through OpenRouter without a key

- **WHEN** Claude Code is set to go through OpenRouter and no `OPENROUTER_API_KEY` is set
- **THEN** Claude Code is offered as not installed, and the reason says the key is missing

#### Scenario: What is no key is refused

- **WHEN** a change sets `NODE_OPTIONS` among the keys
- **THEN** the change is refused with 400, the message says a key is named `…_KEY` or `…_TOKEN`, and nothing is written

#### Scenario: A request from another computer

- **WHEN** the server is bound to every address and the settings are asked for through another address than this computer's own
- **THEN** the answer is 403 and says the settings are read and changed on the computer archdiff runs on
