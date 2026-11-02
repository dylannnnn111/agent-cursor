# Agent Cursor

See where your coding agent is working, live, in VS Code.

When Claude Code reads or edits a file, Agent Cursor shows it like a second person in the file with you:

- **A marker on the line the agent is on**, with what it's doing ("Claude · editing"), pulsing while it works
- **Changed lines glow** in the agent's colour, then fade out over a few seconds
- **Badges in the file explorer**: ✦ where the agent is right now, ✎ files it changed, • files it read
- **An Agent panel** in the sidebar: your files, with the agent's marker sliding from file to file as it moves, and a feed of everything it did
- **Follow mode**: VS Code opens each file the agent moves to and scrolls to where it's working (it waits while you're typing)
- **Every agent gets its own colour**, so parallel sessions and subagents show up side by side

No setup to learn. Install it, connect Claude Code once, then just watch.

![Two Claude Code sessions working in the same folder, each shown in its own colour in the Agent panel and the editor](docs/demo.gif)

## Install

1. Install **Agent Cursor**: download the `.vsix` from [Releases](https://github.com/dylannnnn111/agent-cursor/releases) and in VS Code run *Extensions: Install from VSIX...* (Marketplace listing coming)
2. Run **Agent Cursor: Connect Claude Code** from the Command Palette (or the button in the Agent panel). Pick *All projects* or *Only this folder*.
3. Start a new Claude Code session in the folder you have open. Running sessions need a restart to pick up the hooks.

Want to see it first? **Agent Cursor: Run the Demo** plays a made-up session over the files in your workspace. Nothing is changed on disk.

## How it works

Claude Code [hooks](https://code.claude.com/docs/en/hooks) run a small script on every tool call. Agent Cursor's script (`hook/hook.js`, no dependencies) keeps only what the editor needs - which tool, which file, the line range, a short description - and appends it as one line to `~/.agent-cursor/events.jsonl`. The extension follows that file and draws the agent.

- The hooks run with `async: true`, so they never slow the agent down, and the script always exits 0 without printing anything, so it can't change what the agent does.
- Edits are placed by finding the edited text in the file, or from the patch Claude Code reports when there is one.
- Each VS Code window only shows agents working inside its own folders.
- **Nothing leaves your machine.** No network calls, no telemetry. Prompts are cut to 120 characters, code snippets to 4,000, and the log rolls over at 2 MB.

Connecting adds one hook entry per event to the Claude Code settings file you picked (a backup is saved next to it the first time). **Agent Cursor: Disconnect Claude Code** removes them and leaves your own hooks alone.

## Settings

| Setting | Default | |
|---|---|---|
| `agentCursor.follow` | `false` | Open each file the agent moves to |

Colours can be changed under `workbench.colorCustomizations` (`agentCursor.agent0` to `agentCursor.agent4`).

## Limits

- Claude Code only for now. Anything that can write a line of JSON per action could feed it - see `hook/hook.js` for the format.
- The file explorer only allows a one-character badge and a colour, so the moving marker lives in the Agent panel.
- Needs Node.js on your machine for the hook. Without it, on macOS and Linux it falls back to VS Code's own runtime.

## Develop

```sh
npm install
npm test          # unit tests (node:test)
npm run package   # builds agent-cursor-<version>.vsix
```

Press F5 in VS Code to open an Extension Development Host with it loaded.

MIT licence. Built by [Dylan Lewis](https://dylanlewis.au).
