# What's changed in 🪞 Reflect plugin?

## [1.2.0] 2026-06-07
### New
- **Open in separate window** command (roomy 1200×800 default) with per-window reply routing.
- Edit a focus block's start time and a project's remaining time directly on the Today timeline.
- np.Shared is auto-installed on install/update.

### Changes
- **Faster Plan view**: a single bounded scan with a lookback dropdown; project notes without a schedule marker are skipped.
- ClickUp tasks are filtered by a status blocklist instead of an allowlist.

## [1.1.0] 2026-04-30
### New
- **Today timeline**: calendar events sit at their scheduled times; remaining incomplete tasks with a time estimate are projected sequentially in plan order, splitting around calendar events. Hour gridlines, "Now" line, and per-event colors included.
- On mobile (≤700 px) the timeline becomes a right-side off-canvas drawer with a toggle, mirroring the nav drawer.
- **Remove items** from today's plan with a one-click button (optimistic UI, no full rescan).
- **Edit focus start time** and project remaining time directly on the Today timeline.

### Changes
- Split the Plan tab's right-hand source list into separate **Overdue** and **Today** tabs; calendar events stay on their own tab and checklist items are filtered out.
- Group Overdue and Today tasks by note. Click a group header to open the corresponding note in a new floating window.
- Surface repeating (`@repeat`) tasks scheduled for today or overdue. Strip `@repeat(...)` from a task's content when adding it to today's plan so NotePlan doesn't treat the duplicate as another recurrence.
- Cleaner plan items: priority badge moved to the right next to the time estimate so titles align.
- **ClickUp source**: filter out tasks whose type is Meeting or Routine; filter by status blocklist instead of allowlist (fetches all non-closed tasks, then drops blocked/canceled/complete client-side so custom non-closed statuses still surface).
- ClickUp tasks grouped by list; task ID badge opens the task in the system browser; "+" button moved left for consistency; tasks already added to today's plan marked with a green check.
- Various rendering fixes for tasks added to the plan (priority prefix, `@repeat` marker, and time estimate stripped from the new item without needing a refresh).

## [1.0.0] 2026-03-22
- Initial release: **Reflect** daily planning dashboard with Plan, Today, Focus, Shutdown, and Highlights tabs.
- Plan tab: pull tasks from This Week and other sources (NotePlan notes, ClickUp, calendar), add them to today's plan with a time estimate, drag-reorder, and open notes inline.
- Today tab: live actual-vs-estimated time tracking and a live "now" indicator.
- Focus tab: active focus session with start/stop, a WYSIWYG notes editor, and a formatted session log written back to the daily note.
- Shutdown tab: end-of-day review listing what you worked on, what you didn't get to, and highlights.
- Highlights tab: infinite-scroll view of past highlights.
- ClickUp integration: fetch assigned tasks and add them to today's plan with a ClickUp deeplink.
- Calendar integration: events shown with NotePlan deeplinks and a visual badge.
- Priority display aligned with NotePlan theme colours; priority cycling on plan items.
- Wiki-link support and collapsed-heading handling in daily notes.
