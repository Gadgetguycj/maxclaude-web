# Session status model

A light is a current evidence claim.
A stored state flag never establishes it.
Every successful scan checks the current Zellij controller, Claude PID, and Linux start ticks against the native pane inventory.
The inventory is reused until a socket, server, Claude identity, or controlling terminal changes, and for at most thirty seconds.
A live Claude pane missing from the inventory is rechecked after one second, with backoff.
Collection failure produces unknown, not absence.

| State | Required current evidence | What ends it |
| --- | --- | --- |
| busy | A live pane-owned Claude plus a fresh unmatched prompt or tool hook, unique semantic transcript growth, or a pinned live Bash execution. | An owner-matched Stop or Notification, a current terminal marker, process or pane loss, or activity expiry without a verified execution. |
| background | A live Claude-owned shell-snapshot execution with matching conversation identity when known. Candidate files only nominate PID and start ticks. | Task exit, owner exit, pane loss, or any identity mismatch. |
| idle | A live pane-owned Claude without current busy or background evidence. | New activity, a verified task, or owner loss. |
| sleeping | Intentional hidden metadata and a fresh inventory showing no live session pane. | A live pane or a wake operation. |
| no Claude process | A successful current inventory finds no pane-owned Claude. The wire value is absent. | A new verified Claude owner. |
| unknown | The observation failed, expired, or cannot establish the requested wake. | A successful new observation. |

## Activity and identity

Prompt and tool observations expire after ninety seconds.
This permits slow API and tool startup while bounding missing completion hooks.
Modern hooks use boot ticks for elapsed age.
Legacy hooks without boot ticks receive a wall-time lease and cannot extend it through a process.
Transcript growth leases use monotonic process time.
Wall timestamps supply ranking only and cannot rank in the future.

A Bash extension requires an outstanding tool ID and an exact command digest.
The collector pins one unambiguous matching wrapper while the hook is fresh.
Later scans verify that exact PID, start ticks, owner, and digest.
A replacement PID cannot renew the execution.
Matching wrappers may precede hook recording by at most one second for dispatch delay.
An older matching process cannot extend the claim.
Commands are not persisted.
Generic brokers and helper descendants provide no foreground authority.

Hook allocation, append, and checkpoint updates share one lock.
Sequence establishes causal order independently of wall-clock changes.
The checkpoint preserves each owner's active tools and completion identities for its prompt turn.
A new prompt resets only that owner's turn.
Completed tools cannot reopen through duplicate hooks.
The diagnostic ledger rotates above 256 KiB and retains a 128 KiB suffix.
The checkpoint preserves outstanding work across rotation and agent restart.

Current socket filenames and the kernel's listening socket table establish controller identity, without a connect to any socket.
Native pane membership excludes a detached Claude whose pane closed.
Closing a pane hangs up its terminal and clears a surviving Claude's controlling terminal, which forces a fresh inventory.
Inherited session names locate hook records only.
Owner PID and start ticks separate records even when renamed sessions reuse a hook namespace.
Cleanup preserves a namespace still used by another live owner.

Shared transcript files provide neither owner's activity nor ranking.
Multiple Claude owners in one pane also make transcript attribution ambiguous.
Hooks and execution identities remain owner-specific.
Every pane is evaluated before combining busy, background, idle, and absence in that priority order.

## Failure and delivery

Canonical interrupt records and recognized API-error terminal records close a unique transcript turn without Stop.
Record order establishes transcript turn boundaries.
Delayed tool results and metadata cannot reopen a terminal turn.
If no terminal evidence appears, the ninety-second lease expires.
A crash, killed process, or closed pane removes authority on the next successful inventory.
An unreadable inventory produces unknown while preserving historical event times.

Wake retains hidden metadata until the live Claude resume command and web connection are verified.
Failure retains the conversation metadata and sleeping row.
A partially live hidden session reports unknown, not sleeping.

Status collection never waits for resumability metadata.
Metadata queries run separately with at most four concurrent requests.
Each source observation has a twenty-second lease measured from its actual scan.
This covers the twelve-second native-observer timeout with heartbeat margin.
The agent publishes changes and a two-second heartbeat.
The hub subtracts scan age and transport age without counting the scan twice.
It uses a monotonic receipt deadline.
Legacy transport observations have a twenty-second maximum lease.

HTTP and event snapshots carry one persistent connection epoch, increasing revision, and remaining lease.
The browser rejects older snapshots and expires lights locally.
Visibility changes trigger a refresh.
Historical sleeping rows cannot restore an expired claim.

Recent uses each session's own latest real event time.
The Search box filters Recent by session name without changing its order.
Polling time never becomes activity time.
Transcript records use compact signatures and linear chunk assembly.
The cache has a 512-entry and 16 MiB budget and protects unexpired growth observations.

V19's clustered September 29 timestamps came from proc-directory ctime on unrelated inherited processes.
Those processes supplied neither task ownership nor a real activity event.
The model uses kernel start ticks and current ancestry instead.
