# Congruence

A local dashboard for the work happening across your projects and agent harnesses. Keep using Codex, Claude, or another MCP client to do the work; publish progress into a workspace here.

Read the [project documentation](docs/README.md) for the vision, product concepts, architecture, and roadmap.

## First MVP

- Create, edit, and switch between workspaces, with zero or more repository references.
- View, search, and filter agent work: **In progress**, **Blocked**, and **Done**. Select a title and subtitle in the left panel to read its full details in the centre.
- Opt in to reporting through a local Streamable HTTP MCP endpoint. Reuse the returned short `workId` to update the same card across follow-ups.
- Refer to workspaces and messages with short eight-character IDs; existing internal identifiers remain compatible.
- Keep a fixed activity title, a current subtitle and summary, and compare saved versions in the **Version history** popup.
- Keep workspace and activity data in `.local/state.json`, including across restarts.
- Use the dashboard on narrow screens as well as desktop. Saved dashboard changes arrive through server-sent events.
- Send follow-up messages to existing Codex Desktop chats, Codex sessions on a shared App Server, and Claude Code Desktop sessions through the Congruence mod, with saved delivery receipts and replies.
- Switch from **Activity** to a workspace-specific React dashboard built by an agent, with an optional managed Node/TypeScript backend.
- Review assembled dashboard commands before running a backend action, sending to an existing activity, or preparing a new Codex/Claude Desktop composer.

Repository references are paths or URLs for context; Congruence does not clone or scan them. Work status reflects the latest explicit agent report. It does not infer that an interrupted agent finished. Messaging targets an existing connected session; Congruence does not launch replacement agents or silently resume chats in a different runtime.

## Run locally

Requires Node.js **24.13+** and pnpm **11.18**. From the repository root:

```sh
pnpm install
pnpm build
pnpm start
```

Open **http://127.0.0.1:4310**. Create your first workspace, then use **Agents** to connect a harness. The production build serves the web app and API from one Node process.

For development:

```sh
pnpm dev
```

Vite prints the frontend URL (normally http://127.0.0.1:5173). It proxies `/api` and `/mcp` to the backend on port 4310. In development, the backend serves only the API and MCP; it does not serve an earlier web build from `apps/web/dist`, and its root page points to the Vite URL. After changing route schemas, run `pnpm generate` to refresh the checked-in OpenAPI document and generated client.

The backend accepts `PORT` and `CONGRUENCE_DATA_DIR`. Its default data directory is relative to this checkout, independent of the working directory. Run **one server process per data directory**. The file store serializes writes inside that process; it is not an interprocess database. Stop the server before manually editing or restoring the JSON file. Invalid data causes startup to fail without overwriting the original file.

The dashboard opens an SSE connection at `/api/events`. Committed workspace and activity changes (including MCP writes) emit a `change` event with `{ resource, workspaceId }`; identical activity retries emit nothing. The browser reloads current data on connection and reconnection, so events need no replay history. A comment heartbeat every 15 seconds keeps the stream alive without fetching data. Streams close during server shutdown and reconnect automatically after a restart.

## Connect Codex for progress reporting

In **Codex Desktop**, open **Settings → MCP servers** and add an HTTP server named `congruence` with URL `http://127.0.0.1:4310/mcp`. If the server is already configured, no CLI session is needed.

Alternatively, with the app running and Codex CLI installed:

```sh
codex mcp add congruence --url http://127.0.0.1:4310/mcp
```

Start a fresh harness session and check that the tools are available. This command adds an MCP configuration; the application itself never edits your harness configuration. For another MCP-compatible harness, configure the same HTTP URL using that harness’s settings. See the [official Codex MCP setup example](https://developers.openai.com/learn/docs-mcp).

Reporting starts only when the human requests **report activity to congruence** or sends exactly **CGR:ACT**. Connecting alone does not start reporting or trigger setup. Once enabled and any required reporting setup is complete, the agent must create the current activity with **In progress** before doing the work if no activity exists. It must not wait until completion to create the card. The agent keeps updating the same activity across turns and follow-ups until the human explicitly switches activity or stops reporting. Each new task or follow-up must first return that item to **In progress**, even if it was **Done** or **Blocked**. If anything prevents finishing the current task, report **Blocked** and explain the obstacle and required next step. Return to **In progress** when the blocker is resolved, and report **Done** only when the current task is complete. Waiting, interruption, and ending a turn do not imply completion. Status transitions are meaningful updates even if little or no summary text changes. Marking work done does not turn reporting off.

`CGR:ACT` is custom shorthand, not a built-in Codex command. It appears first in Congruence's MCP instructions for discovery. To recognize it reliably before discovering MCP tools, Codex needs the mapping in already-loaded guidance. An optional rule for `~/.codex/AGENTS.md` (all projects), or a repository's `AGENTS.md` (that project), is:

> Report to Congruence only when the human requests “report activity to congruence” or sends exactly `CGR:ACT`. Then discover its MCP tools, create the current activity as `in_progress` before work if needed, and reuse it until the human explicitly switches it or stops reporting. Set it to `in_progress` before each new task or follow-up, `blocked` if anything prevents completion, and `done` only after completion.

Congruence does not install this rule. Start a fresh Codex session after adding it; [Codex loads AGENTS.md guidance before working](https://learn.chatgpt.com/docs/agent-configuration/agents-md). Other harnesses need equivalent loaded guidance for the shorthand.

The MCP tools are:

| Tool                      | Purpose                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `list_workspaces`         | Discover available workspace IDs and repository references.                          |
| `list_activity`           | Read the latest activity in a workspace.                                             |
| `publish_activity`        | Create or update a work item in an existing workspace.                               |
| `get_agent_settings`      | Read active connection settings and proposed changes, including their review status. |
| `propose_agent_settings`  | Request a settings change for human review; never applies it directly.               |
| `list_dashboards`         | Discover one workspace's custom dashboards and published versions.                   |
| `create_dashboard`        | Create a starter and return its absolute internal source directory.                  |
| `get_dashboard_directory` | Locate an existing dashboard and its authoring instructions.                         |
| `publish_dashboard`       | Build and activate a frontend and optional backend version.                          |
| `link_dashboard_session`  | Bind a prepared request to the actual new native chat after the human sends it.      |

After the human enables reporting or requests setup, the MCP instructions ask agents to identify their host from session context and available local evidence: **Codex Desktop**, **Codex CLI**, **Claude Code in the desktop app**, or **Claude Code CLI**. An executable path alone is not evidence of Desktop versus CLI. Agents inspect the current settings before proposing changes.

A Codex agent can propose a verified Codex executable path, local shared-server URL or control socket. Claude Code has no connection settings, so Claude agents propose nothing. The proposal includes its host, evidence, reason, workspace, and a stable request ID. The **Agents** button shows a count when changes need approval. Open it to review pending requests, with before/proposed values and **Approve and apply** / **Reject** buttons. The sidebar has **MCP setup** and **Agent settings**, with provider tabs for Codex Desktop and Claude Code Desktop. Pending changes appear under Agent settings. Its **Past requests** section stays closed until opened and shows decisions for the selected provider. **Reapply** restores only the saved fields after checking that their current values still match the review, records a new approved request, and preserves the original decision. **Delete** removes a past request after an inline confirmation, without changing active settings. Pending requests must be reviewed first. Messaging instructions are part of MCP setup. Changes affect all workspaces in the installation. Only the fields in the approved request change; connections reset immediately. A proposal never launches its executable.

Pending requests and decisions persist alongside settings in `.local/agent-settings.json`. Repeating a request with the same ID is safe. Requests whose affected settings changed while waiting must be rejected and proposed again, preventing an old approval from overwriting newer choices. There is no MCP approval tool: approving an MCP tool call only authorizes submitting a proposal, and approval in chat is not a frontend decision. The instructions forbid agents from approving their own requests or bypassing review through file, environment, or HTTP changes. Humans can still edit settings directly under **Agents**.

Publishing has an enforced setup prerequisite for Codex. When `codexCommand` is unset, `publish_activity` returns `CONFIGURATION_REQUIRED` for a Codex report, without saving it, until a current executable proposal exists. Reading settings or finding the executable alone does not satisfy this prerequisite. `get_agent_settings` and `list_workspaces` return configuration status and the required next step. Reporting resumes while a proposal awaits frontend approval; the executable remains unset. Human rejection permits reporting with an explicit rejected-configuration notice, without requesting the same approval again. Unrelated or outdated proposals do not satisfy setup.

Example `publish_activity` input:

```json
{
  "workspaceId": "an-existing-workspace-id",
  "title": "Application improvements",
  "subtitle": "Workspace settings: checking persistence",
  "summary": "- Editing\n  - Names and repository paths can be changed.\n  - Empty names are rejected.\n- Remaining check: Reload the app and verify saved values.",
  "status": "in_progress",
  "source": "codex"
}
```

Creation omits `workId` and `workKey`. Congruence generates a short random Work ID and returns it with the saved activity in that same call. Updates supply the returned `workId`, never a new ID. Each workspace also has an immutable `shortId`, accepted as `workspaceId` by the API and MCP tools. Internal workspace IDs and Work Keys remain accepted for compatibility, but are not displayed in activity details or message envelopes. Use an optional stable `requestId` UUID to make creation retries safe; it remains an internal retry token. Unknown identifiers are rejected rather than creating another card. No reservation call or pool of unused identifiers is needed.

The title is immutable after creation; a changed title is rejected. Choose a short, generic title for the kind of work (for example, **Weather report**); put exact locations, dates, versions, quantities, and current outcomes in `subtitle` and `summary`. Existing titles stay unchanged. Keep titles and subtitles in plain text. Use `subtitle` for specific context or the current phase, and write `summary` in Markdown as the current state rather than appending a running log. The summary should add useful detail beyond the title and subtitle, and repeat their information only when adding relevant new information.

The app uses the full browser width. The left Activity panel lists titles, subtitles, and status icons; the selected activity opens in the centre, with repositories on the right on wide screens. New reports keep the current selection, and search and status filters select a matching activity when needed. On narrow screens, the scrollable list appears above the selected details. Activity details render Markdown, including nested lists, emphasis, links, code, tables, and task lists. The Markdown source is stored unchanged for version comparisons. Every real change saves a numbered version, including changes to the messaging destination. Select an activity and open **Version history** to compare revisions in a dialog that uses 80% of the window width. Its compact header and timeline leave more vertical space for content. Drag the From and To pins along the saved versions; nodes keep fixed spacing instead of stretching across the popup, and longer timelines scroll. Pins snap to version nodes and also support keyboard selection. The side-by-side diff aligns matching and similar edited lines, leaves blank cells opposite inserted or deleted lines, and highlights changed words within each pair. Wrapped lines share a row height so later lines remain aligned. Removed text has no strikethrough, and added text has no underline; both retain their color highlights. Select **Render Markdown** in the Summary comparison to preview both versions with formatting. The latest version remains visible in the activity details. `GET /api/workspaces/:workspaceId/activity/:activityId/versions` returns its snapshots, oldest first. Earlier content cannot be reconstructed for activities created before versioning; migration preserves their last stored state as version 1, keeps message relationships, and backs up the original file.

The history dialog stays at the maximum available height with 20px above and below it. Its content scrolls inside; changing versions, preview modes, or loading states does not resize the window.

Reporting instructions ask agents to edit subtitles and summaries surgically: retain unchanged wording, order, indentation, and line breaks; update or remove outdated facts; and add new bullets or sub-bullets for new facts. Current accuracy takes priority over minimizing the diff. For new summary content, group related facts under a short `- Topic` parent bullet, with each supporting fact on a two-space-indented `  - Fact` sub-bullet line. For example, daily forecasts belong under one Forecast bullet, not in a flat list of top-level bullets. Independent facts can stay at the top level. On updates, preserve existing groups and edit or add facts within the relevant group; do not reorganize unchanged content for style alone. Keep one fact per line without manual line wrapping. Agents should prefer ASD-STE100 Simplified Technical English, using short, clear sentences, active voice, and consistent terms. This guidance lives in the MCP instructions and publishing tool description, with a nested example on the `summary` input field, not in each delivered message.

`sourceUrl` is an optional real HTTP(S) reference, such as a pull request. Desktop session links are separate from source links. `source` is a reported label, not verified identity. Publishing replaces the item's reported content; include `sourceUrl` again if you want to retain it. An identical update leaves the card, revision, and last-update timestamp unchanged.

To link the publishing agent, also include `agentTarget: {"provider":"codex-desktop","sessionId":"<actual CODEX_THREAD_ID>"}`. Codex exposes the current chat ID through its `CODEX_THREAD_ID` tool environment variable. Claude Code Desktop needs no `agentTarget`: its `desktopSession` (below) also routes messages. An MCP transport session ID is not a chat ID. The first supplied target links an unbound item; later progress reports preserve the established destination, including any choice the user makes in the message dialog. Reports without a target still work.

Selected activity details show **Open in Codex** or **Open in Claude** immediately before **Message agent**. Codex Desktop links use the linked chat ID and the [documented `codex://threads/<id>` route](https://learn.chatgpt.com/docs/app/commands#deep-links). Opening a desktop session works independently of messaging configuration and sends no prompt. The browser may ask permission to open the installed app.

Claude reporters must additionally supply `desktopSession: {"provider":"claude","sessionId":"local_<actual desktop session ID>"}` using the exact native ID. Claude Desktop puts this ID in the agent's tool environment as `CLAUDE_CODE_HOST_SESSION_ID` and sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop`. Its MCP requests send the User-Agent `claude-code/<version> (claude-desktop, …)`. `publish_activity` refuses a request with that User-Agent with `DESKTOP_SESSION_REQUIRED` when neither the report nor the stored item has a `desktopSession`; nothing is saved, and the error tells the agent how to read the ID. Claude Code CLI reports are not affected. The environment variable and the User-Agent were observed in Claude Desktop **4.4212.0**; they are not documented public APIs and may change. The local Code session route `claude://code/continue?session=local_...` was verified in installed Claude Desktop **4.4212.0**; it is not a documented public API and may change. A CLI session ID is not a desktop ID; never invent a desktop ID from it. The desktop reference works even when the mod is not installed. `desktopSession` can also identify a verified Codex chat with provider `codex-desktop`. A shared App Server session alone does not establish a local Desktop destination.

Desktop references can be added to existing activities and persist across later reports and restarts. Changing the messaging destination clears a separate desktop reference so it cannot open the previous agent; a selected Codex Desktop target supplies its own link. Until a desktop session is known, **Open in desktop** is disabled with an explanatory tooltip.

## Message connected agents

Open **Agents**, select your client, and follow its setup instructions. After the agent publishes an activity, select it in the left panel and choose **Message agent** in its details. The linked chat is selected automatically; check its name and working directory, then send your message. **Change** opens the session picker. Older items without a reported target require one selection. Congruence never guesses the originating chat from its name, repository, or position in the list. The selection and message history persist across dashboard restarts and later progress reports.

Delivered messages use a readable plain-text envelope: a `---` separator, the human's message, and another separator before the activity title, short Work ID, and short Workspace ID. Message markers also use a unique eight-character ID. Reporting and update rules live in the MCP connection instructions and publishing tool description instead of being repeated in every message. Context alone never enables or resumes reporting. Internal retry IDs and legacy UUID markers remain supported for delivery receipts. Existing data is backed up before short workspace and message IDs are assigned, preserving saved selections, activity history, and message relationships.

### Codex Desktop

Keep the linked chat open in Codex Desktop. The optional session picker lists saved interactive chats matching the workspace’s absolute local repository paths; workspaces without those paths show recent local chats. Refresh sessions after creating a chat. The `saved` label describes a saved chat, not its live open/idle state. **Open chat in Desktop** opens the selected chat. An unavailable linked chat stays selected until you explicitly change it.

Congruence uses the installed `codex queue --thread <id> --message <text>` command to enqueue input in that existing chat. An open idle Desktop chat can wake and respond; busy chats process queued input when ready. A closed chat may need to be opened before consuming its queue. No interactive CLI session or shared WebSocket server is required. Approvals remain in Desktop.

The backend needs a Codex executable supporting `queue` and the App Server history APIs, under the same user and Codex home as Desktop. Open **Agents → Agent settings → Codex Desktop**, review the **Codex executable** path, and choose **Save and test**. Windows Desktop installations are detected automatically; otherwise enter the full executable path. These installation-wide settings are saved in `.local/agent-settings.json` and apply immediately, including after backend restarts. When required settings are empty, **Message agent** is disabled and a warning icon explains where to configure the agent on hover or keyboard focus. Settings are managed in **Agents**, outside the message dialog. This was verified with Codex `0.166.0-alpha.5.1` on Windows. See the [Codex queue reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

A separate stdio metadata process reads saved chat lists and history; it never resumes chats or starts turns. While the message dialog is open, pending Desktop receipts are checked every two seconds. Each outgoing message has a unique marker so its reply is matched to the correct turn. Reopening the dialog also reconciles persisted receipts after a dashboard restart. MCP remains responsible for explicit activity progress updates.

### Codex CLI with a shared App Server

Start a shared App Server and connect your terminal client to it:

```sh
codex app-server --listen ws://127.0.0.1:4500
```

In another terminal, in your project directory:

```sh
codex --remote ws://127.0.0.1:4500
```

Congruence defaults to that loopback endpoint. Open **Agents → Agent settings → Codex CLI** to change the shared server URL or use an existing App Server control socket through `codex app-server proxy`, then choose **Save and test**. Saved frontend settings take precedence over legacy `CONGRUENCE_CODEX_COMMAND`, `CONGRUENCE_CODEX_URL`, and `CONGRUENCE_CODEX_SOCKET` defaults. The server never changes your authentication, sandbox, or approval policy.

The shared-server entries show only chats loaded in that runtime; Desktop entries use the queue route above. Active shared-server chats receive `turn/steer` with the expected active turn ID; idle chats receive `turn/start`. A racing or unloaded turn is rejected instead of being silently restarted. Command/file approvals with an available preview can be answered once in the message dialog. Other input requests remain in the native Codex client. App Server is an experimental integration; see the [official protocol documentation](https://learn.chatgpt.com/docs/app-server).

### Claude Code Desktop

Claude Code Desktop sessions receive messages through the **Congruence mod** in `apps/claude-mod`, a Claude Code plugin with a hooks module. It needs no CLI.

1. Open **Agents → Agent settings → Claude Code Desktop** and choose **Apply**. Congruence adds the mod folder to `CLAUDE_CODE_PLUGIN_DIRS` and sets `CONGRUENCE_URL` to this server in the `env` block of the Claude Code user settings (`~/.claude/settings.json`, or `settings.json` in `CLAUDE_CONFIG_DIR`). Other settings and other plugin folders stay unchanged.
2. Restart Claude Desktop. Local Code sessions that you open after the restart load the mod. **Refresh** shows how many sessions are connected.
3. Report progress from the session with its `desktopSession` (see [Connect Codex for progress reporting](#connect-codex-for-progress-reporting)). That native `local_…` ID also addresses the session for messages, so **Message agent** selects it with no `agentTarget`.

The mod reads `CLAUDE_CODE_HOST_SESSION_ID` and does nothing in sessions without it, such as CLI sessions. It also does nothing when `CONGRUENCE_URL` is not a loopback `http` origin; it then writes one line in the transcript. Every two seconds it asks Congruence for messages for its session. While Congruence does not answer, the wait doubles after each try, up to 30 seconds, so a session can take up to 30 seconds to connect after the server starts again. Congruence hands out each message once. The mod submits it with `$.prompt.submit({ asUser: true })`, which starts a turn when the session is idle. Without `asUser`, Claude Code adds its own frame that says a plugin submitted the prompt; with it, Claude reads the message as your own words. On `turn.complete`, the mod sends Claude's final answer back as the reply. The mod keeps the link between a message and its turn in `$.state`, so a reload of the mod during the turn does not lose the reply. A message marker that you type or paste yourself is ignored. The message states are: `sending` while Congruence holds the message, `queued` when the mod received it, `accepted` when Claude started the turn, and `replied` with the answer. A message for an offline session waits, also across a server restart, until the session polls again. If you stopped the session's last turn with Esc, Claude Code refuses new prompts until you type in that session; the message then shows `Not delivered`. Approvals stay in Claude Desktop.

If a Claude Desktop session reports work but does not run the mod, Congruence counts it in the **Agents** badge and highlights **Apply** on the Claude Code Desktop tab. `publish_activity` also returns `claudeDesktop.nextStep`, so the agent tells you once. The badge clears when the session connects or when you choose **Apply**. Congruence keeps this state in memory only.

The session picker lists connected sessions in the workspace's repository folders and sessions that an activity of the workspace reported. **Remove from config file** takes the folder and the URL out of the settings again. Restart existing Claude Desktop sessions after upgrading the mod so they recognize short message markers; the updated mod also accepts legacy UUID markers. Mods require Claude Code 2.1.287 or later; this was verified with the mod tests on Claude Code 2.1.309. To check the mod itself, run `claude plugin validate apps/claude-mod` and `claude plugin test apps/claude-mod`.

Congruence does not integrate with the Claude Code CLI. A CLI session can still report progress through the MCP endpoint, but it cannot receive dashboard messages, and its cards keep **Message agent** disabled.

**Delivery states:** `queued` means the Desktop queue write succeeded or the Congruence mod received the message; it does not confirm that the model read it. `accepted` means Codex acknowledged the input or the matching input appeared in the saved Desktop chat. `replied` means the agent responded to that message. Offline shared-server sessions fail clearly. A lost acknowledgment is marked `unknown`, including interrupted sends recovered after a server restart. Messages are never replayed automatically; repeated requests with the same message ID return the existing receipt. Work status still changes only through explicit activity reports.

## Repository layout

```text
apps/
  web/src/
    app/                    React application shell
    features/               Workspace forms, live updates, activity views
    components/             Reusable UI and dialog components
    panels/                 Built-in dashboard panels
  server/src/
    features/               HTTP routes grouped by feature
    mcp/                    MCP tools using the same application store
    storage/                JSON persistence and application operations
  claude-mod/               Claude Code mod that delivers messages in Desktop sessions
packages/
  contracts/                Handwritten TypeBox schemas and inferred types
  api-client/               Generated OpenAPI client and fetch error handling
scripts/                    API generation, server build, isolated test server
tests/e2e/                  Browser tests through the actual MCP endpoint
```

This is a TypeScript modular monolith in a pnpm workspace. React/Vite, Tailwind, a small shadcn-style button primitive, and Lucide form the frontend. Fastify uses its native Ajv validation with the official TypeBox provider. TypeBox is also used for browser form and persisted-data validation. The official MCP SDK adapts the same JSON Schemas for tool input/output validation. Dependencies use free, open-source licenses; no paid service is required to run the dashboard. External harnesses have their own terms and account requirements.

The contract pipeline is **TypeBox → Fastify route schemas → OpenAPI → Orval → generated fetch client**. The generated client has its own generated TypeScript types; it does not import `contracts` or validate responses at runtime. Browser form validation imports the shared contracts explicitly. Generated files are committed for straightforward development.

## Verification

```sh
pnpm exec playwright install chromium
pnpm check
```

`check` builds and type-checks the packages, runs storage/HTTP/MCP and agent messaging tests, then runs Chromium against fresh isolated data directories. Messaging tests cover Codex routing through a protocol double, retries, session isolation, approval handling, restart recovery, and the actual Claude bridge process with a simulated MCP host. Browser tests cover workspace/activity flows, messaging, replies, setup, and mobile layouts. Screenshots are saved under `.local/screenshots/`. Tests do not write to the normal `.local/state.json` or send prompts to real agents.

Individual commands: `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` (requires a built frontend). The Claude Desktop mod has its own tests, which need the Claude Code CLI: `claude plugin test apps/claude-mod`.

## Deliberately deferred

This version binds to loopback, without user accounts or dashboard sign-in. Remote access, shared workspaces, external-service notifications, the knowledge vault, and discovery of independent harness runtimes are future work. Custom dashboards run trusted local code; backend code has the server user's file and network access. Do not expose this local MVP through a public proxy.

## Agent-built workspace dashboards

Ask an agent connected to Congruence MCP to build a dashboard for a specific workspace. It uses `create_dashboard`, reads the returned `DASHBOARD.md`, edits React and optional Node/TypeScript source in the returned absolute directory, then calls `publish_dashboard`. Existing dashboards are discoverable with `list_dashboards` and `get_dashboard_directory`. Dashboard creation does not enable activity reporting.

**Activity** is always the first option in the panel dropdown. Each workspace remembers its selected view. Custom dashboards use the main content area; Activity retains its title/subtitle list on the left and selected activity in the centre. Refresh the page after publication to load the latest version. Editing source alone does not publish it; a failed build preserves the previous working version.

Congruence keeps dashboard source, immutable published releases, and private backend data under `<CONGRUENCE_DATA_DIR>/dashboards/` (normally `.local/dashboards/`). An optional backend can fetch HTTP data, read files, query databases, and collect data while the dashboard or browser is closed. Congruence starts published backends on server startup and replaces them on publication. The server must remain running for background work. Additional dependencies belong to the dashboard's own source package.

Dashboard forms freely assemble inputs from people and data sources. Their `api.reviewCommand` call opens Congruence's review dialog. The backend may resolve data during preparation; the review displays the resulting input snapshot and prompt. Confirmation executes that exact snapshot once. Publishing another version makes an unexecuted review stale and requires a fresh review. Backend action results and command receipts remain available in recent runs. A server interruption does not automatically replay a possibly completed action.

An **agent** command targets an existing linked activity or a new native Desktop chat. A new chat produces a **prepared** link for Codex or Claude: open it, verify the folder/project/environment, model and effort in the native app, and press Send there. Congruence does not send that initial prompt. The reviewed prompt includes a request marker so the receiving agent can call `link_dashboard_session` with its actual native session ID; only then is the new activity created. The marker is a correlation identifier, not an authentication token, and linking does not enable ongoing activity reporting. If native handoff is unavailable, copy the prepared prompt into the chosen Desktop chat.

Dashboard frontends run in a sandboxed iframe and use the host bridge for data and review. This separates their UI from Congruence's controls. Backends and build dependencies are trusted local code, with ordinary Node access; the iframe does not sandbox backend services. Keep secrets in backend data or environment variables, never in frontend bundles. See each generated `DASHBOARD.md` for the exact module and bridge API.
