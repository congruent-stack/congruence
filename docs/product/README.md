# Product

A workspace groups related work and context. It can reference zero, one, or many repositories, so research, planning, and other noncoding work fit alongside software projects. Repository references do not imply cloning or scanning.

## Current MVP

Create, edit, and switch workspaces. Each workspace shows agent work in progress, blocked, or done, with the latest summary and optional source link. Search and filters help find an update.

Agents publish through MCP only after the human requests “report activity to congruence” or exactly `CGR:ACT`. Once enabled, agents create a missing activity as **In progress** before working and return it to **In progress** before each new task or follow-up. If anything prevents completion, they report **Blocked** with the obstacle and required next step; after the obstacle is resolved, they return to **In progress**, then **Done** when the task is complete. Reporting stays with the current item across follow-ups until the human explicitly changes it or stops reporting. Each activity has a fixed title, a mutable subtitle, and a short generated Work ID. Workspaces and message markers also use short IDs; internal identifiers remain compatible with existing data. Reports replace the current summary; saved versions remain available in a comparison popup. Congruence does not infer completion from a stopped session. Real HTTP(S) links can lead to supporting work.

Agent execution stays in the existing harness. Codex Desktop supports MCP progress reporting and messages through its local queue. Open idle chats can wake; busy chats process queued messages when ready. Saved chats are discovered by workspace repository paths, with recent local chats shown for workspaces without local paths. Saved does not imply that a chat is currently open.

Select an activity from the left list to read its details in the centre, message its linked chat, and read delivery receipts and replies. Agents report their actual chat ID with the activity; the dialog selects it automatically and offers Change as an override. Older unlinked items require a session choice, and unavailable linked chats never silently switch to another chat in the repository. The dialog can also open the selected Codex Desktop chat. Desktop approvals remain in Desktop. Codex sessions on a shared App Server support steering active turns or starting a turn in an idle chat. Claude Code Desktop sessions receive messages through the Congruence mod, installed from Agents, and the reply is Claude's final answer for that turn. Claude Code in a terminal can report progress but does not receive dashboard messages. Session selection survives activity updates; work statuses change through explicit agent reports.

## Future direction

Workspaces may gain notifications from Slack, Teams, Jira, and email, and a knowledge/context vault. See the [roadmap](../roadmap/README.md).

## Workspace dashboards

The view dropdown always starts with Activity, followed by agent-built React dashboards scoped to the current workspace. Activity keeps its left list and central reader; a custom dashboard occupies the main area. The app remembers each workspace's selected view. Agents receive internal source paths through MCP, implement an optional Node/TypeScript backend, and publish a working version. A page refresh loads the latest published version.

Dashboards can combine human input with HTTP, file, or database data. Commands have an agent-prompt or backend-action type. Congruence shows the assembled inputs and prompt before confirmation and executes the reviewed snapshot. Backends can keep collecting data and already-confirmed jobs keep running while the browser is closed, while the server is running.

For an agent prompt, the human chooses an existing activity or prepares a new native Codex/Claude Desktop chat. New chat links fill the composer; the human checks project/environment, model, and effort and presses Send in Desktop. Preparing a prompt does not create an activity or claim a running session. The receiving agent links the request using its actual native session ID. Ongoing activity reporting remains a separate opt-in.
