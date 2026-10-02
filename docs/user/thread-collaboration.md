# Work with another thread

Agents can discover and communicate with other threads connected to the same T3 Code server, including threads in other projects or worktrees. Open the threads you want to work together, then ask one agent to delegate work, for example:

> Ask the Reviewer thread in my API project to review the current changes. Answer any questions it has, then use its feedback to finish the task.

The agent discovers the destination by its stable thread ID. Names, projects, and working directories help distinguish similarly named threads. Only the context supplied with a request is shared; the source thread's entire conversation is not copied. File context includes its working directory so relative paths remain meaningful across worktrees.

Expand **Thread collaboration** in a conversation to see requests, questions, answers, results, and delivery state. Thread names link to the corresponding conversation. Incoming conversation messages are labelled with their source agent rather than “You”. These records survive page refreshes.

A busy thread receives requests in order after its current turn. A thread waiting for your answer or approval stays blocked until you respond; another agent cannot approve it. A waiting agent can explicitly receive collaboration messages through its wait tool, allowing two agents to ask each other questions without blocking each other's progress. Replies and questions resume an idle source thread automatically. Ordinary status changes do not start new turns.

**Queued** means the request is stored, **Starting** means a new provider turn has been submitted, **Processing** means the provider has started that turn (or explicitly received the request through its wait tool), **Waiting for information** identifies an outstanding question, and **Replied** confirms that the recipient returned an explicit result. Delivery state is shown separately for each message. A wait timeout only ends that wait: the agent can still query the same request. Retries must reuse the original request or message key.

Archived or deleted threads cannot receive new requests. A stopped provider session can start again for an open thread. Provider failures are recorded on the request. After a server restart, queued work remains queued or resumes when its destination is ready. Work already submitted to a provider is marked failed with an explanation rather than being automatically repeated, because its side effects may already have happened.

The collaboration tools use T3 Code's existing provider MCP connection. Codex, Claude Code, Cursor, Grok, OpenCode, and Antigravity use the same request protocol; the selected provider installation must support the MCP connection that T3 Code supplies. Collaboration is limited to one server, even when the client is connected to several servers.
