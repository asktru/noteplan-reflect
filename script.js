// asktru.Reflect — script.js
// Sunsama-like Daily Planning for NotePlan

// ============================================
// CONFIGURATION
// ============================================

const PLUGIN_ID = 'asktru.Reflect';
const WINDOW_ID = 'asktru.Reflect.dashboard';
const REFLECT_HEADING = 'Reflect';

function getSettings() {
  var s = DataStore.settings || {};
  var timer = {};
  try { timer = JSON.parse(s.timerState || '{}'); } catch (e) { timer = {}; }
  return {
    clickupApiToken: s.clickupApiToken || '',
    clickupTeamId: s.clickupTeamId || '',
    timerState: timer,
    lastTab: s.lastTab || 'today',
  };
}

function saveLastTab(tab) {
  var s = DataStore.settings || {};
  s.lastTab = tab;
  DataStore.settings = s;
}

function saveTimerState(state) {
  var s = DataStore.settings || {};
  s.timerState = JSON.stringify(state || {});
  DataStore.settings = s;
}

// ============================================
// DATE UTILITIES
// ============================================

function getTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getDateStr(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function getTimeStr() {
  var d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function getWeekRange() {
  var now = new Date();
  var day = now.getDay();
  // Week starts on Monday
  var diff = day === 0 ? -6 : 1 - day;
  var monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  var sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: getDateStr(monday), end: getDateStr(sunday) };
}

function getISOWeek(dateStr) {
  var d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  var week1 = new Date(d.getFullYear(), 0, 4);
  var weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return d.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
}

function formatDuration(ms) {
  var totalMin = Math.floor(ms / 60000);
  var hrs = Math.floor(totalMin / 60);
  var mins = totalMin % 60;
  if (hrs > 0) return hrs + 'h ' + mins + 'm';
  return mins + 'm';
}

// ============================================
// THEME DETECTION (same as Task Zoom)
// ============================================

function npColor(c) {
  if (!c) return null;
  if (c.match && c.match(/^#[0-9A-Fa-f]{8}$/)) {
    return '#' + c.slice(3, 9) + c.slice(1, 3);
  }
  return c;
}

function isLightTheme() {
  try {
    var theme = Editor.currentTheme;
    if (!theme) return false;
    if (theme.mode === 'light') return true;
    if (theme.mode === 'dark') return false;
    var vals = theme.values || {};
    var bg = npColor((vals.editor || {}).backgroundColor);
    if (bg) {
      var m = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
      if (m) {
        var lum = (parseInt(m[1], 16) * 299 + parseInt(m[2], 16) * 587 + parseInt(m[3], 16) * 114) / 1000;
        return lum > 140;
      }
    }
  } catch (e) {}
  return false;
}

function getThemeCSS() {
  try {
    var theme = Editor.currentTheme;
    if (!theme) return '';
    var vals = theme.values || {};
    var editor = vals.editor || {};
    var styles = [];
    var bg = npColor(editor.backgroundColor);
    var altBg = npColor(editor.altBackgroundColor);
    var text = npColor(editor.textColor);
    var tint = npColor(editor.tintColor);
    if (bg) styles.push('--bg-main-color: ' + bg);
    if (altBg) styles.push('--bg-alt-color: ' + altBg);
    if (text) styles.push('--fg-main-color: ' + text);
    if (tint) styles.push('--tint-color: ' + tint);
    if (styles.length > 0) return ':root { ' + styles.join('; ') + '; }';
  } catch (e) {}
  return '';
}

// ============================================
// DAILY NOTE MANAGEMENT
// ============================================

function getTodayNote() {
  var todayStr = getTodayStr();
  return DataStore.calendarNoteByDateString(todayStr);
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Find the line range [startLine, endLine) for a section under a heading.
 * startLine = the line AFTER the heading. endLine = next same-or-higher level heading, or note end.
 */
function findSectionRange(note, headingText, headingLevel) {
  var paras = note.paragraphs;
  var startLine = -1;
  var endLine = paras.length;

  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    if (startLine === -1) {
      if (p.type === 'title' && p.headingLevel === headingLevel && p.content.trim() === headingText) {
        startLine = i + 1;
      }
    } else {
      // Found the start, now look for next same-or-higher level heading
      if (p.type === 'title' && p.headingLevel <= headingLevel) {
        endLine = i;
        break;
      }
    }
  }
  return startLine >= 0 ? { start: startLine, end: endLine } : null;
}

/**
 * Find the line index of a heading. Returns -1 if not found.
 */
function findHeadingLine(note, headingText, headingLevel) {
  var paras = note.paragraphs;
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    if (p.type === 'title' && p.headingLevel === headingLevel && p.content.trim() === headingText) {
      return i;
    }
  }
  return -1;
}

/**
 * Ensure a section exists in the daily note. Creates # Reflect and subsection lazily.
 * Returns the line index of the subsection heading, creating if needed.
 */
function ensureSection(note, subHeading) {
  // Check if # Reflect exists
  var reflectLine = findHeadingLine(note, REFLECT_HEADING, 1);
  if (reflectLine === -1) {
    // Append # Reflect at end
    note.appendParagraph('', 'empty');
    note.appendParagraph(REFLECT_HEADING, 'title');
    reflectLine = note.paragraphs.length - 1;
  }

  // Check if ## subHeading exists under # Reflect
  var subLine = findHeadingLine(note, subHeading, 2);
  if (subLine !== -1 && subLine > reflectLine) {
    return subLine;
  }

  // Need to create ## subHeading — find where to insert it
  // Insert after the last content of # Reflect (before any other H1)
  var reflectRange = findSectionRange(note, REFLECT_HEADING, 1);
  if (!reflectRange) {
    // This shouldn't happen since we just created it
    note.appendParagraph(subHeading, 'title');
    return note.paragraphs.length - 1;
  }

  // Insert at end of Reflect section
  var insertAt = reflectRange.end;
  note.insertHeading(subHeading, insertAt, 2);
  return insertAt;
}

/**
 * Get checklist items under ## Plan (within # Reflect).
 */
function getPlanTasks(note) {
  var range = findSectionRange(note, 'Plan', 2);
  if (!range) return [];

  var tasks = [];
  var paras = note.paragraphs;
  for (var i = range.start; i < range.end; i++) {
    var p = paras[i];
    var t = p.type;
    if (t === 'checklist' || t === 'checklistDone' || t === 'checklistCancelled' ||
        t === 'open' || t === 'done' || t === 'cancelled') {
      tasks.push({
        content: p.content,
        type: t,
        lineIndex: p.lineIndex,
        indentLevel: p.indentLevel || 0,
        isComplete: (t === 'checklistDone' || t === 'done' || t === 'checklistCancelled' || t === 'cancelled'),
      });
    }
  }
  return tasks;
}

// ============================================
// TASK SOURCE SCANNING
// ============================================

/**
 * Get open tasks from today's daily note that are NOT under # Reflect.
 */
function getDailyNoteTasks(note) {
  if (!note) return [];
  var paras = note.paragraphs;
  var tasks = [];
  var reflectLine = findHeadingLine(note, REFLECT_HEADING, 1);
  var reflectRange = reflectLine >= 0 ? findSectionRange(note, REFLECT_HEADING, 1) : null;

  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    // Skip paragraphs inside Reflect section
    if (reflectRange && i >= reflectLine && i < reflectRange.end) continue;

    var t = p.type;
    if (t === 'open' || t === 'checklist') {
      tasks.push({
        content: p.content,
        type: t,
        filename: note.filename,
        lineIndex: p.lineIndex,
        source: 'daily',
        heading: p.heading || '',
      });
    }
  }
  return tasks;
}

/**
 * Scan all notes for tasks scheduled for a specific date or date range.
 */
function getScheduledTasks(startDate, endDate) {
  var tasks = [];
  var todayStr = getTodayStr();
  var foldersToExclude = ['@Archive', '@Trash', '@Templates'];

  // Helper to check schedule date
  function hasScheduleInRange(content, start, end) {
    // Match >YYYY-MM-DD patterns
    var matches = content.match(/>(\d{4}-\d{2}-\d{2})/g);
    if (matches) {
      for (var j = 0; j < matches.length; j++) {
        var d = matches[j].substring(1);
        if (d >= start && d <= end) return d;
      }
    }
    // Match >today
    if (content.indexOf('>today') >= 0 && todayStr >= start && todayStr <= end) return todayStr;
    return null;
  }

  function hasScheduleWeek(content, weekStr) {
    var match = content.match(/>(\d{4}-W\d{2})/);
    if (match && match[1] === weekStr) return weekStr;
    return null;
  }

  var weekRange = getWeekRange();
  var currentWeek = getISOWeek(todayStr);

  // Scan project notes
  var pNotes = DataStore.projectNotes;
  for (var n = 0; n < pNotes.length; n++) {
    var note = pNotes[n];
    var folder = (note.filename || '').split('/')[0];
    if (foldersToExclude.indexOf(folder) >= 0) continue;

    var paras = note.paragraphs;
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      if (p.type !== 'open' && p.type !== 'checklist') continue;
      var schedDate = hasScheduleInRange(p.content, startDate, endDate);
      var schedWeek = hasScheduleWeek(p.content, currentWeek);
      if (schedDate || schedWeek) {
        tasks.push({
          content: p.content.replace(/>(\d{4}-\d{2}-\d{2}|today|\d{4}-W\d{2})/g, '').trim(),
          rawContent: p.content,
          type: p.type,
          filename: note.filename,
          lineIndex: p.lineIndex,
          noteTitle: note.title || note.filename,
          scheduledDate: schedDate || schedWeek,
          source: 'scheduled',
        });
      }
    }
  }

  // Scan calendar notes (daily notes for the date range)
  var cNotes = DataStore.calendarNotes;
  for (var cn = 0; cn < cNotes.length; cn++) {
    var calNote = cNotes[cn];
    var fn = (calNote.filename || '').replace(/\.(md|txt)$/, '');

    // Daily notes: YYYYMMDD — tasks inherit note's date
    var dailyMatch = fn.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dailyMatch) {
      var noteDate = dailyMatch[1] + '-' + dailyMatch[2] + '-' + dailyMatch[3];
      if (noteDate < startDate || noteDate > endDate) continue;
      if (noteDate === todayStr) continue; // Today's daily note is handled separately

      var calParas = calNote.paragraphs;
      for (var ci = 0; ci < calParas.length; ci++) {
        var cp = calParas[ci];
        if (cp.type !== 'open' && cp.type !== 'checklist') continue;
        tasks.push({
          content: cp.content,
          rawContent: cp.content,
          type: cp.type,
          filename: calNote.filename,
          lineIndex: cp.lineIndex,
          noteTitle: noteDate,
          scheduledDate: noteDate,
          source: 'scheduled',
        });
      }
      continue;
    }

    // Weekly notes: YYYY-Www — tasks inherit week
    var weekMatch = fn.match(/^(\d{4}-W\d{2})$/);
    if (weekMatch && weekMatch[1] === currentWeek) {
      var wParas = calNote.paragraphs;
      for (var wi = 0; wi < wParas.length; wi++) {
        var wp = wParas[wi];
        if (wp.type !== 'open' && wp.type !== 'checklist') continue;
        tasks.push({
          content: wp.content,
          rawContent: wp.content,
          type: wp.type,
          filename: calNote.filename,
          lineIndex: wp.lineIndex,
          noteTitle: weekMatch[1],
          scheduledDate: weekMatch[1],
          source: 'scheduled',
        });
      }
    }
  }

  return tasks;
}

function getScheduledForToday() {
  var today = getTodayStr();
  return getScheduledTasks(today, today);
}

function getScheduledThisWeek() {
  var range = getWeekRange();
  return getScheduledTasks(range.start, range.end);
}

// ============================================
// CLICKUP INTEGRATION
// ============================================

async function fetchClickUpTasks(apiToken, teamId) {
  if (!apiToken || !teamId) return [];
  try {
    var url = 'https://api.clickup.com/api/v2/team/' + teamId + '/task?assignees[]=me&statuses[]=open&statuses[]=in%20progress&order_by=due_date&reverse=true&subtasks=true&include_closed=false';
    var resp = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': apiToken, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      console.log('Reflect: ClickUp API error: ' + resp.status);
      return [];
    }
    var data = JSON.parse(await resp.text());
    var tasks = (data.tasks || []).map(function(t) {
      return {
        content: t.name,
        type: 'clickup',
        clickupId: t.id,
        url: t.url,
        status: (t.status || {}).status || 'open',
        dueDate: t.due_date ? new Date(parseInt(t.due_date)).toISOString().slice(0, 10) : null,
        source: 'clickup',
      };
    });
    return tasks;
  } catch (e) {
    console.log('Reflect: ClickUp fetch error: ' + String(e));
    return [];
  }
}

// ============================================
// MUTATIONS
// ============================================

function addToPlan(note, content) {
  // Ensure ## Plan exists
  ensureSection(note, 'Plan');
  var range = findSectionRange(note, 'Plan', 2);
  if (!range) return false;

  // Insert checklist at end of Plan section
  var insertAt = range.end;
  note.insertParagraph(content, insertAt, 'checklist');
  return true;
}

function togglePlanTask(note, lineIndex) {
  var paras = note.paragraphs;
  if (lineIndex < 0 || lineIndex >= paras.length) return;
  var p = paras[lineIndex];
  if (p.type === 'checklist') {
    p.type = 'checklistDone';
  } else if (p.type === 'checklistDone') {
    p.type = 'checklist';
  } else if (p.type === 'open') {
    p.type = 'done';
  } else if (p.type === 'done') {
    p.type = 'open';
  }
  note.updateParagraph(p);
}

function reorderPlanTasks(note, orderedLineIndices) {
  var range = findSectionRange(note, 'Plan', 2);
  if (!range) return;

  var paras = note.paragraphs;
  // Collect all plan items in their current order
  var items = [];
  for (var i = range.start; i < range.end; i++) {
    var p = paras[i];
    var t = p.type;
    if (t === 'checklist' || t === 'checklistDone' || t === 'checklistCancelled' ||
        t === 'open' || t === 'done' || t === 'cancelled') {
      items.push({ content: p.content, type: p.type, lineIndex: p.lineIndex });
    }
  }

  // Build new order based on orderedLineIndices
  var itemMap = {};
  for (var j = 0; j < items.length; j++) {
    itemMap[items[j].lineIndex] = items[j];
  }

  var newOrder = [];
  for (var k = 0; k < orderedLineIndices.length; k++) {
    var item = itemMap[orderedLineIndices[k]];
    if (item) newOrder.push(item);
  }

  // Remove old items (in reverse to keep line indices stable)
  for (var r = items.length - 1; r >= 0; r--) {
    note.removeParagraphAtIndex(items[r].lineIndex);
  }

  // Re-insert in new order at the start of the Plan section
  var rangeAfterRemoval = findSectionRange(note, 'Plan', 2);
  if (!rangeAfterRemoval) return;
  var insertAt = rangeAfterRemoval.start;
  for (var w = 0; w < newOrder.length; w++) {
    note.insertParagraph(newOrder[w].content, insertAt + w, newOrder[w].type);
  }
}

function startFocusSession(note, taskContent) {
  ensureSection(note, 'Focus');
  var range = findSectionRange(note, 'Focus', 2);
  if (!range) return;

  var timeStr = getTimeStr();
  var logEntry = timeStr + ' started focus session for: ' + taskContent;
  note.insertParagraph(logEntry, range.end, 'list');

  // Save timer state
  saveTimerState({ startTime: Date.now(), taskContent: taskContent });
}

function stopFocusSession(note, focusNotes) {
  var config = getSettings();
  var timer = config.timerState;
  if (!timer.startTime) return;

  ensureSection(note, 'Focus');
  var range = findSectionRange(note, 'Focus', 2);
  if (!range) return;

  var elapsed = Date.now() - timer.startTime;
  var duration = formatDuration(elapsed);
  var timeStr = getTimeStr();
  var logEntry = timeStr + ' stopped focus session for: ' + timer.taskContent + ' (' + duration + ')';
  note.insertParagraph(logEntry, range.end, 'list');

  // Add notes as indented bullet if provided
  if (focusNotes && focusNotes.trim()) {
    // Re-read range since we just inserted
    var updatedRange = findSectionRange(note, 'Focus', 2);
    var notesText = focusNotes.trim();
    // If notes already starts with a bullet marker, just indent it
    if (notesText.startsWith('- ') || notesText.startsWith('* ')) {
      notesText = notesText.substring(2);
    }
    note.insertParagraph('\t' + notesText, updatedRange.end, 'list');
  }

  // Clear timer state
  saveTimerState({});
}

// ============================================
// RENDER MARKDOWN (basic)
// ============================================

function renderMarkdown(str) {
  if (!str) return '';
  var s = esc(str);
  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline code
  s = s.replace(/`(.+?)`/g, '<code class="rf-md-code">$1</code>');
  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Highlight
  s = s.replace(/==(.+?)==/g, '<mark class="rf-md-highlight">$1</mark>');
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="rf-md-link" title="$2">$1</a>');
  // Hashtags (orange)
  s = s.replace(/(^|[\s(])#([\w\/-]+)/g, '$1<span class="rf-tag">#$2</span>');
  // Mentions (orange)
  s = s.replace(/(^|[\s(])@([\w\/-]+(?:\([^)]*\))?)/g, '$1<span class="rf-mention">@$2</span>');
  // Strip scheduling markers
  s = s.replace(/&gt;(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|today)/g, '');
  return s.trim();
}

// ============================================
// HTML BUILDERS
// ============================================

function buildNav(activeTab) {
  var tabs = [
    { id: 'today', icon: 'fa-solid fa-calendar-day', label: 'Today' },
    { id: 'focus', icon: 'fa-solid fa-crosshairs', label: 'Focus' },
    { id: 'plan', icon: 'fa-solid fa-list-check', label: 'Plan' },
    { id: 'shutdown', icon: 'fa-solid fa-moon', label: 'Shutdown' },
    { id: 'highlights', icon: 'fa-solid fa-pen-fancy', label: 'Highlights' },
  ];

  var html = '<nav class="rf-nav">';
  html += '<div class="rf-nav-date">' + esc(getTodayStr()) + '</div>';
  for (var i = 0; i < tabs.length; i++) {
    var t = tabs[i];
    var active = t.id === activeTab ? ' active' : '';
    html += '<button class="rf-nav-item' + active + '" data-tab="' + t.id + '" data-action="switchTab">';
    html += '<i class="' + t.icon + '"></i>';
    html += '<span>' + t.label + '</span>';
    html += '</button>';
  }
  html += '</nav>';
  return html;
}

function buildPlanItem(task, index) {
  var isDone = task.isComplete;
  var cbClass = isDone ? 'checklistDone' : 'checklist';
  var cbIcon = isDone ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
  var itemClass = 'rf-plan-item' + (isDone ? ' is-done' : '');
  var contentHTML = renderMarkdown(task.content);

  var html = '<div class="' + itemClass + '" draggable="true" data-line-index="' + task.lineIndex + '" data-index="' + index + '">';
  html += '<span class="rf-drag-handle"><i class="fa-solid fa-grip-vertical"></i></span>';
  html += '<span class="rf-plan-cb ' + cbClass + '" data-action="togglePlan" data-line-index="' + task.lineIndex + '">';
  html += '<i class="' + cbIcon + '"></i>';
  html += '</span>';
  html += '<span class="rf-plan-content">' + contentHTML + '</span>';
  html += '</div>';
  return html;
}

function buildSourceTask(task) {
  var contentHTML = renderMarkdown(task.content);
  var meta = '';
  if (task.noteTitle) {
    meta = '<span class="rf-source-meta">' + esc(task.noteTitle) + '</span>';
  }
  if (task.scheduledDate) {
    meta += '<span class="rf-source-date">' + esc(task.scheduledDate) + '</span>';
  }

  var html = '<div class="rf-source-task" data-content="' + esc(task.content) + '">';
  html += '<div class="rf-source-task-main">';
  html += '<span class="rf-source-task-content">' + contentHTML + '</span>';
  html += '</div>';
  if (meta) html += '<div class="rf-source-task-meta">' + meta + '</div>';
  html += '<button class="rf-source-add" data-action="addToPlan" data-content="' + esc(task.content) + '" title="Add to plan (S)">';
  html += '<i class="fa-solid fa-plus"></i>';
  html += '</button>';
  html += '</div>';
  return html;
}

function buildTodayTab(planTasks, dailyTasks, scheduledToday, scheduledWeek, hasClickUp) {
  var html = '<div class="rf-today">';

  // Left: Plan
  html += '<div class="rf-plan-panel">';
  html += '<div class="rf-panel-header">';
  html += '<h2 class="rf-panel-title">Today\'s Plan</h2>';
  html += '<span class="rf-plan-count">' + planTasks.filter(function(t) { return !t.isComplete; }).length + ' remaining</span>';
  html += '</div>';
  html += '<div class="rf-plan-list" id="planList">';
  if (planTasks.length === 0) {
    html += '<div class="rf-empty">Add tasks from the right panel to plan your day</div>';
  } else {
    for (var i = 0; i < planTasks.length; i++) {
      html += buildPlanItem(planTasks[i], i);
    }
  }
  html += '</div>';
  html += '</div>';

  // Right: Sources
  html += '<div class="rf-sources-panel">';
  html += '<div class="rf-source-tabs">';
  html += '<button class="rf-source-tab active" data-source="daily">Daily Note</button>';
  html += '<button class="rf-source-tab" data-source="today">Today</button>';
  html += '<button class="rf-source-tab" data-source="week">This Week</button>';
  if (hasClickUp) {
    html += '<button class="rf-source-tab" data-source="clickup">ClickUp</button>';
  }
  html += '</div>';

  // Daily Note source
  html += '<div class="rf-source-list active" data-source="daily">';
  if (dailyTasks.length === 0) {
    html += '<div class="rf-empty">No tasks in today\'s daily note</div>';
  } else {
    for (var d = 0; d < dailyTasks.length; d++) {
      html += buildSourceTask(dailyTasks[d]);
    }
  }
  html += '</div>';

  // Scheduled Today source
  html += '<div class="rf-source-list" data-source="today">';
  if (scheduledToday.length === 0) {
    html += '<div class="rf-empty">No tasks scheduled for today</div>';
  } else {
    for (var st = 0; st < scheduledToday.length; st++) {
      html += buildSourceTask(scheduledToday[st]);
    }
  }
  html += '</div>';

  // This Week source
  html += '<div class="rf-source-list" data-source="week">';
  if (scheduledWeek.length === 0) {
    html += '<div class="rf-empty">No tasks scheduled this week</div>';
  } else {
    for (var sw = 0; sw < scheduledWeek.length; sw++) {
      html += buildSourceTask(scheduledWeek[sw]);
    }
  }
  html += '</div>';

  // ClickUp source (lazy loaded)
  if (hasClickUp) {
    html += '<div class="rf-source-list" data-source="clickup">';
    html += '<div class="rf-empty rf-clickup-loading">Loading ClickUp tasks...</div>';
    html += '</div>';
  }

  html += '</div>'; // sources-panel
  html += '</div>'; // rf-today
  return html;
}

function buildFocusTab(planTasks, timerState) {
  var html = '<div class="rf-focus">';

  // Find topmost incomplete task
  var currentTask = null;
  for (var i = 0; i < planTasks.length; i++) {
    if (!planTasks[i].isComplete) {
      currentTask = planTasks[i];
      break;
    }
  }

  if (!currentTask) {
    html += '<div class="rf-focus-empty">';
    html += '<i class="fa-solid fa-check-double rf-focus-empty-icon"></i>';
    html += '<p>No tasks in your plan yet.</p>';
    html += '<p class="rf-text-muted">Add tasks in the Today tab first.</p>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  var isTimerActive = timerState.startTime && timerState.taskContent;
  var startTimeAttr = isTimerActive ? ' data-timer-start="' + timerState.startTime + '"' : '';

  html += '<div class="rf-focus-card"' + startTimeAttr + '>';
  html += '<div class="rf-focus-label">Currently focusing on</div>';
  html += '<div class="rf-focus-task">' + renderMarkdown(currentTask.content) + '</div>';

  html += '<div class="rf-focus-timer" id="focusTimer">' + (isTimerActive ? '--:--' : '00:00') + '</div>';

  html += '<div class="rf-focus-controls">';
  if (isTimerActive) {
    html += '<button class="rf-focus-btn stop" data-action="stopFocus"><i class="fa-solid fa-stop"></i> Stop</button>';
  } else {
    html += '<button class="rf-focus-btn start" data-action="startFocus" data-content="' + esc(currentTask.content) + '"><i class="fa-solid fa-play"></i> Start Focus</button>';
  }
  html += '</div>';

  html += '<textarea class="rf-focus-notes" id="focusNotes" placeholder="Session notes..."></textarea>';

  html += '<button class="rf-focus-complete" data-action="completeFocusTask" data-line-index="' + currentTask.lineIndex + '"><i class="fa-solid fa-check"></i> Complete & Next</button>';

  html += '</div>'; // focus-card
  html += '</div>'; // rf-focus
  return html;
}

function buildPlaceholderTab(tabName) {
  var html = '<div class="rf-placeholder">';
  html += '<i class="fa-solid fa-wrench rf-placeholder-icon"></i>';
  html += '<h2>' + esc(tabName) + '</h2>';
  html += '<p class="rf-text-muted">Coming soon</p>';
  html += '</div>';
  return html;
}

function buildDashboardHTML(tab, data) {
  var html = '<div class="rf-layout">';
  html += buildNav(tab);

  html += '<main class="rf-main">';
  html += '<div class="rf-nav-toggle" data-action="toggleNav"><i class="fa-solid fa-bars"></i></div>';

  switch (tab) {
    case 'today':
      html += buildTodayTab(data.planTasks, data.dailyTasks, data.scheduledToday, data.scheduledWeek, data.hasClickUp);
      break;
    case 'focus':
      html += buildFocusTab(data.planTasks, data.timerState);
      break;
    case 'plan':
      html += buildPlaceholderTab('Plan');
      break;
    case 'shutdown':
      html += buildPlaceholderTab('Shutdown');
      break;
    case 'highlights':
      html += buildPlaceholderTab('Highlights');
      break;
    default:
      html += buildPlaceholderTab(tab);
  }

  html += '</main>';
  html += '<div class="rf-nav-backdrop" data-action="toggleNav"></div>';
  html += '</div>';
  return html;
}

function buildFullHTML(bodyContent, activeTab, timerStart) {
  var themeCSS = getThemeCSS();
  var pluginCSS = getInlineCSS();

  var faLinks = '\n' +
    '    <link href="../np.Shared/fontawesome.css" rel="stylesheet">\n' +
    '    <link href="../np.Shared/regular.min.flat4NP.css" rel="stylesheet">\n' +
    '    <link href="../np.Shared/solid.min.flat4NP.css" rel="stylesheet">\n';

  var themeAttr = isLightTheme() ? 'light' : 'dark';
  var bodyAttrs = ' data-active-tab="' + (activeTab || 'today') + '"';
  if (timerStart) bodyAttrs += ' data-timer-start="' + timerStart + '"';

  return '<!DOCTYPE html>\n<html data-theme="' + themeAttr + '">\n<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, maximum-scale=1, viewport-fit=cover">\n' +
    '  <title>Reflect</title>\n' +
    faLinks +
    '  <style>' + themeCSS + '\n' + pluginCSS + '</style>\n' +
    '</head>\n<body' + bodyAttrs + '>\n' +
    bodyContent + '\n' +
    '  <div class="rf-toast" id="rfToast"></div>\n' +
    '  <script>\n    var receivingPluginID = \'' + PLUGIN_ID + '\';\n  <\/script>\n' +
    '  <script type="text/javascript" src="../np.Shared/pluginToHTMLCommsBridge.js"><\/script>\n' +
    '  <script type="text/javascript" src="reflectEvents.js"><\/script>\n' +
    '</body>\n</html>';
}

// ============================================
// INLINE CSS
// ============================================

function getInlineCSS() {
  return '\n' +
/* ---- Theme Variables ---- */
':root, [data-theme="dark"] {\n' +
'  --rf-bg: var(--bg-main-color, #1a1a2e);\n' +
'  --rf-bg-card: var(--bg-alt-color, #16213e);\n' +
'  --rf-bg-elevated: color-mix(in srgb, var(--rf-bg-card) 85%, white 15%);\n' +
'  --rf-text: var(--fg-main-color, #e0e0e0);\n' +
'  --rf-text-muted: color-mix(in srgb, var(--rf-text) 55%, transparent);\n' +
'  --rf-text-faint: color-mix(in srgb, var(--rf-text) 35%, transparent);\n' +
'  --rf-accent: var(--tint-color, #F97316);\n' +
'  --rf-accent-soft: color-mix(in srgb, var(--rf-accent) 15%, transparent);\n' +
'  --rf-border: color-mix(in srgb, var(--rf-text) 10%, transparent);\n' +
'  --rf-border-strong: color-mix(in srgb, var(--rf-text) 18%, transparent);\n' +
'  --rf-green: #10B981;\n' +
'  --rf-green-soft: color-mix(in srgb, #10B981 12%, transparent);\n' +
'  --rf-red: #EF4444;\n' +
'  --rf-red-soft: color-mix(in srgb, #EF4444 12%, transparent);\n' +
'  --rf-orange: #F97316;\n' +
'  --rf-orange-soft: color-mix(in srgb, #F97316 12%, transparent);\n' +
'  --rf-blue: #3B82F6;\n' +
'  --rf-blue-soft: color-mix(in srgb, #3B82F6 12%, transparent);\n' +
'  --rf-yellow: #F59E0B;\n' +
'  --rf-radius: 10px;\n' +
'  --rf-radius-sm: 6px;\n' +
'  --rf-nav-width: 180px;\n' +
'}\n' +
'[data-theme="light"] {\n' +
'  --rf-bg-elevated: color-mix(in srgb, var(--rf-bg-card) 92%, black 8%);\n' +
'  --rf-text-muted: color-mix(in srgb, var(--rf-text) 60%, transparent);\n' +
'  --rf-text-faint: color-mix(in srgb, var(--rf-text) 40%, transparent);\n' +
'}\n' +

/* ---- Reset ---- */
'*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n' +
'body {\n' +
'  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
'  font-size: 14px; line-height: 1.5;\n' +
'  background: var(--rf-bg); color: var(--rf-text);\n' +
'  -webkit-font-smoothing: antialiased;\n' +
'  overflow: hidden;\n' +
'}\n' +

/* ---- Layout ---- */
'.rf-layout {\n' +
'  display: flex; height: 100vh; width: 100%;\n' +
'}\n' +

/* ---- Navigation ---- */
'.rf-nav {\n' +
'  width: var(--rf-nav-width); flex-shrink: 0;\n' +
'  background: var(--rf-bg-card); border-right: 1px solid var(--rf-border);\n' +
'  display: flex; flex-direction: column; padding: 12px 8px; gap: 2px;\n' +
'  overflow-y: auto;\n' +
'}\n' +
'.rf-nav-date {\n' +
'  font-size: 11px; font-weight: 600; color: var(--rf-text-muted);\n' +
'  padding: 4px 10px 10px; text-transform: uppercase; letter-spacing: 0.5px;\n' +
'}\n' +
'.rf-nav-item {\n' +
'  display: flex; align-items: center; gap: 10px;\n' +
'  padding: 9px 12px; border-radius: var(--rf-radius-sm);\n' +
'  background: transparent; border: none; color: var(--rf-text-muted);\n' +
'  font-size: 13px; font-weight: 500; cursor: pointer;\n' +
'  transition: all 0.15s ease; text-align: left; width: 100%;\n' +
'}\n' +
'.rf-nav-item:hover { background: var(--rf-border); color: var(--rf-text); }\n' +
'.rf-nav-item.active {\n' +
'  background: var(--rf-accent-soft); color: var(--rf-accent); font-weight: 600;\n' +
'}\n' +
'.rf-nav-item i { width: 16px; text-align: center; font-size: 14px; }\n' +
'.rf-nav-toggle {\n' +
'  display: none; position: absolute; top: 10px; left: 10px; z-index: 50;\n' +
'  width: 36px; height: 36px; border-radius: var(--rf-radius-sm);\n' +
'  border: 1px solid var(--rf-border); background: var(--rf-bg-card);\n' +
'  color: var(--rf-text-muted); cursor: pointer;\n' +
'  font-size: 16px; display: none;\n' +
'  align-items: center; justify-content: center;\n' +
'}\n' +
'.rf-nav-backdrop {\n' +
'  display: none; position: fixed; inset: 0; z-index: 90;\n' +
'  background: color-mix(in srgb, black 40%, transparent);\n' +
'}\n' +

/* ---- Main ---- */
'.rf-main {\n' +
'  flex: 1; overflow-y: auto; position: relative;\n' +
'}\n' +

/* ---- Today Tab ---- */
'.rf-today {\n' +
'  display: flex; height: 100%; min-height: 0;\n' +
'}\n' +
'.rf-plan-panel {\n' +
'  flex: 1; display: flex; flex-direction: column;\n' +
'  border-right: 1px solid var(--rf-border);\n' +
'  min-width: 0;\n' +
'}\n' +
'.rf-panel-header {\n' +
'  display: flex; align-items: center; justify-content: space-between;\n' +
'  padding: 16px 16px 12px; border-bottom: 1px solid var(--rf-border);\n' +
'}\n' +
'.rf-panel-title {\n' +
'  font-size: 15px; font-weight: 700;\n' +
'}\n' +
'.rf-plan-count {\n' +
'  font-size: 12px; color: var(--rf-text-muted); font-weight: 500;\n' +
'}\n' +
'.rf-plan-list {\n' +
'  flex: 1; overflow-y: auto; padding: 8px;\n' +
'}\n' +

/* ---- Plan Items ---- */
'.rf-plan-item {\n' +
'  display: flex; align-items: flex-start; gap: 6px;\n' +
'  padding: 8px 6px; border-radius: var(--rf-radius-sm);\n' +
'  transition: background 0.1s ease; cursor: default;\n' +
'}\n' +
'.rf-plan-item:hover { background: var(--rf-border); }\n' +
'.rf-plan-item.is-done .rf-plan-content { text-decoration: line-through; color: var(--rf-text-faint); }\n' +
'.rf-drag-handle {\n' +
'  color: var(--rf-text-faint); cursor: grab; padding: 2px;\n' +
'  font-size: 11px; opacity: 0.4; transition: opacity 0.15s;\n' +
'}\n' +
'.rf-plan-item:hover .rf-drag-handle { opacity: 1; }\n' +
'.rf-plan-cb {\n' +
'  font-size: 16px; cursor: pointer; margin-top: 1px; flex-shrink: 0;\n' +
'  transition: color 0.15s;\n' +
'}\n' +
'.rf-plan-cb.checklist { color: var(--rf-text-faint); }\n' +
'.rf-plan-cb.checklist:hover { color: var(--rf-green); }\n' +
'.rf-plan-cb.checklistDone { color: var(--rf-green); }\n' +
'.rf-plan-content {\n' +
'  flex: 1; min-width: 0; font-size: 14px; line-height: 1.5; word-break: break-word;\n' +
'}\n' +

/* ---- Drag indicators ---- */
'.rf-plan-item.is-dragging { opacity: 0.3; }\n' +
'.rf-plan-item.drag-over-top { border-top: 2px solid var(--rf-accent); margin-top: -2px; }\n' +
'.rf-plan-item.drag-over-bottom { border-bottom: 2px solid var(--rf-accent); margin-bottom: -2px; }\n' +

/* ---- Sources Panel ---- */
'.rf-sources-panel {\n' +
'  flex: 1; display: flex; flex-direction: column; min-width: 0;\n' +
'}\n' +
'.rf-source-tabs {\n' +
'  display: flex; border-bottom: 1px solid var(--rf-border);\n' +
'  padding: 0 12px; gap: 0; flex-shrink: 0;\n' +
'}\n' +
'.rf-source-tab {\n' +
'  padding: 12px 14px; border: none; background: transparent;\n' +
'  color: var(--rf-text-muted); font-size: 12px; font-weight: 600;\n' +
'  cursor: pointer; border-bottom: 2px solid transparent;\n' +
'  transition: all 0.15s; white-space: nowrap;\n' +
'}\n' +
'.rf-source-tab:hover { color: var(--rf-text); }\n' +
'.rf-source-tab.active {\n' +
'  color: var(--rf-accent); border-bottom-color: var(--rf-accent);\n' +
'}\n' +
'.rf-source-list {\n' +
'  display: none; flex: 1; overflow-y: auto; padding: 8px;\n' +
'}\n' +
'.rf-source-list.active { display: block; }\n' +

/* ---- Source Tasks ---- */
'.rf-source-task {\n' +
'  display: flex; align-items: flex-start; gap: 8px;\n' +
'  padding: 8px; border-radius: var(--rf-radius-sm);\n' +
'  transition: background 0.1s;\n' +
'}\n' +
'.rf-source-task:hover { background: var(--rf-border); }\n' +
'.rf-source-task-main { flex: 1; min-width: 0; }\n' +
'.rf-source-task-content {\n' +
'  font-size: 13px; line-height: 1.5; word-break: break-word;\n' +
'}\n' +
'.rf-source-task-meta {\n' +
'  display: flex; gap: 6px; flex-wrap: wrap; margin-top: 3px;\n' +
'}\n' +
'.rf-source-meta, .rf-source-date {\n' +
'  font-size: 10px; padding: 1px 6px; border-radius: 3px;\n' +
'  background: var(--rf-border); color: var(--rf-text-muted);\n' +
'  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\n' +
'  max-width: 180px;\n' +
'}\n' +
'.rf-source-add {\n' +
'  flex-shrink: 0; width: 28px; height: 28px;\n' +
'  border-radius: var(--rf-radius-sm); border: 1px solid var(--rf-border);\n' +
'  background: transparent; color: var(--rf-text-muted);\n' +
'  cursor: pointer; display: flex; align-items: center; justify-content: center;\n' +
'  font-size: 12px; transition: all 0.15s; opacity: 0;\n' +
'}\n' +
'.rf-source-task:hover .rf-source-add { opacity: 1; }\n' +
'.rf-source-add:hover { background: var(--rf-accent-soft); color: var(--rf-accent); border-color: var(--rf-accent); }\n' +

/* ---- Focus Tab ---- */
'.rf-focus {\n' +
'  display: flex; align-items: center; justify-content: center;\n' +
'  min-height: 100vh; padding: 40px 20px;\n' +
'}\n' +
'.rf-focus-card {\n' +
'  display: flex; flex-direction: column; align-items: center;\n' +
'  gap: 24px; padding: 40px; max-width: 500px; width: 100%;\n' +
'  background: var(--rf-bg-card); border-radius: var(--rf-radius);\n' +
'  border: 1px solid var(--rf-border);\n' +
'}\n' +
'.rf-focus-label {\n' +
'  font-size: 12px; color: var(--rf-text-muted); text-transform: uppercase;\n' +
'  letter-spacing: 0.5px; font-weight: 600;\n' +
'}\n' +
'.rf-focus-task {\n' +
'  font-size: 20px; font-weight: 700; text-align: center;\n' +
'  line-height: 1.4; word-break: break-word;\n' +
'}\n' +
'.rf-focus-timer {\n' +
'  font-size: 64px; font-weight: 200; font-variant-numeric: tabular-nums;\n' +
'  font-family: -apple-system, "SF Mono", monospace;\n' +
'  color: var(--rf-accent); line-height: 1;\n' +
'}\n' +
'.rf-focus-controls { display: flex; gap: 12px; }\n' +
'.rf-focus-btn {\n' +
'  padding: 12px 32px; border-radius: var(--rf-radius-sm);\n' +
'  border: none; font-size: 14px; font-weight: 600;\n' +
'  cursor: pointer; display: flex; align-items: center; gap: 8px;\n' +
'  transition: all 0.15s;\n' +
'}\n' +
'.rf-focus-btn.start { background: var(--rf-accent); color: white; }\n' +
'.rf-focus-btn.start:hover { filter: brightness(1.1); }\n' +
'.rf-focus-btn.stop { background: var(--rf-red); color: white; }\n' +
'.rf-focus-btn.stop:hover { filter: brightness(1.1); }\n' +
'.rf-focus-notes {\n' +
'  width: 100%; min-height: 80px; padding: 12px;\n' +
'  border-radius: var(--rf-radius-sm); border: 1px solid var(--rf-border);\n' +
'  background: var(--rf-bg); color: var(--rf-text);\n' +
'  font-family: inherit; font-size: 13px; resize: vertical;\n' +
'}\n' +
'.rf-focus-notes::placeholder { color: var(--rf-text-faint); }\n' +
'.rf-focus-complete {\n' +
'  padding: 10px 24px; border-radius: var(--rf-radius-sm);\n' +
'  border: 1px solid var(--rf-border); background: transparent;\n' +
'  color: var(--rf-text-muted); font-size: 13px; font-weight: 600;\n' +
'  cursor: pointer; display: flex; align-items: center; gap: 8px;\n' +
'  transition: all 0.15s;\n' +
'}\n' +
'.rf-focus-complete:hover { background: var(--rf-green-soft); color: var(--rf-green); border-color: var(--rf-green); }\n' +

/* ---- Focus Empty ---- */
'.rf-focus-empty {\n' +
'  display: flex; flex-direction: column; align-items: center;\n' +
'  justify-content: center; gap: 12px; min-height: 60vh;\n' +
'  color: var(--rf-text-muted); text-align: center;\n' +
'}\n' +
'.rf-focus-empty-icon { font-size: 48px; opacity: 0.3; }\n' +

/* ---- Placeholder ---- */
'.rf-placeholder {\n' +
'  display: flex; flex-direction: column; align-items: center;\n' +
'  justify-content: center; gap: 12px; min-height: 60vh;\n' +
'  color: var(--rf-text-muted); text-align: center;\n' +
'}\n' +
'.rf-placeholder-icon { font-size: 48px; opacity: 0.3; }\n' +

/* ---- Empty state ---- */
'.rf-empty {\n' +
'  padding: 24px 16px; text-align: center; color: var(--rf-text-faint);\n' +
'  font-size: 13px;\n' +
'}\n' +
'.rf-text-muted { color: var(--rf-text-muted); }\n' +

/* ---- Inline Markdown ---- */
'.rf-md-code {\n' +
'  background: var(--rf-border); padding: 1px 4px; border-radius: 3px;\n' +
'  font-family: "SF Mono", Menlo, monospace; font-size: 0.9em;\n' +
'}\n' +
'.rf-md-link { color: var(--rf-blue); text-decoration: none; }\n' +
'.rf-md-link:hover { text-decoration: underline; }\n' +
'.rf-md-highlight { background: var(--rf-yellow); color: #000; padding: 0 2px; border-radius: 2px; }\n' +
'.rf-tag { color: var(--rf-orange); font-weight: 600; }\n' +
'.rf-mention { color: var(--rf-orange); font-weight: 600; }\n' +

/* ---- Toast ---- */
'.rf-toast {\n' +
'  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(60px);\n' +
'  padding: 10px 20px; border-radius: var(--rf-radius-sm);\n' +
'  background: var(--rf-bg-elevated); color: var(--rf-text);\n' +
'  border: 1px solid var(--rf-border); font-size: 13px;\n' +
'  opacity: 0; transition: all 0.3s ease; z-index: 200; pointer-events: none;\n' +
'  box-shadow: 0 4px 12px color-mix(in srgb, black 20%, transparent);\n' +
'}\n' +
'.rf-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }\n' +

/* ---- Mobile ---- */
'@media (max-width: 700px) {\n' +
'  .rf-nav-toggle { display: flex; }\n' +
'  .rf-nav {\n' +
'    position: fixed; left: 0; top: 0; bottom: 0; z-index: 100;\n' +
'    width: 220px; transform: translateX(-100%);\n' +
'    transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);\n' +
'    box-shadow: none;\n' +
'  }\n' +
'  .rf-nav.open {\n' +
'    transform: translateX(0);\n' +
'    box-shadow: 4px 0 24px color-mix(in srgb, black 25%, transparent);\n' +
'  }\n' +
'  .rf-nav-backdrop.open { display: block; }\n' +
'  .rf-today { flex-direction: column; }\n' +
'  .rf-plan-panel { border-right: none; border-bottom: 1px solid var(--rf-border); max-height: 45vh; }\n' +
'  .rf-sources-panel { flex: 1; }\n' +
'  .rf-main { padding-top: 50px; }\n' +
'  .rf-focus-card { padding: 24px 16px; }\n' +
'  .rf-focus-timer { font-size: 48px; }\n' +
'}\n';
}

// ============================================
// MAIN ENTRY & MESSAGE HANDLING
// ============================================

async function showReflect(tab) {
  try {
    CommandBar.showLoading(true, 'Loading Reflect...');
    await CommandBar.onAsyncThread();

    var config = getSettings();
    var activeTab = tab || config.lastTab || 'today';
    saveLastTab(activeTab);

    var note = getTodayNote();
    var data = {
      planTasks: [],
      dailyTasks: [],
      scheduledToday: [],
      scheduledWeek: [],
      hasClickUp: Boolean(config.clickupApiToken && config.clickupTeamId),
      timerState: config.timerState,
    };

    if (note) {
      data.planTasks = getPlanTasks(note);
      if (activeTab === 'today') {
        data.dailyTasks = getDailyNoteTasks(note);
        data.scheduledToday = getScheduledForToday();
        data.scheduledWeek = getScheduledThisWeek();
      } else if (activeTab === 'focus') {
        // Only need plan tasks + timer state (already loaded)
      }
    }

    var bodyContent = buildDashboardHTML(activeTab, data);
    var timerStart = (config.timerState && config.timerState.startTime) ? config.timerState.startTime : null;
    var fullHTML = buildFullHTML(bodyContent, activeTab, timerStart);

    await CommandBar.onMainThread();
    CommandBar.showLoading(false);

    var winOptions = {
      customId: WINDOW_ID,
      savedFilename: '../../asktru.Reflect/reflect.html',
      shouldFocus: true,
      reuseUsersWindowRect: true,
      headerBGColor: 'transparent',
      autoTopPadding: true,
      showReloadButton: true,
      reloadPluginID: PLUGIN_ID,
      reloadCommandName: 'Reflect',
      icon: 'fa-sun',
      iconColor: '#F97316',
    };

    var result = await HTMLView.showInMainWindow(fullHTML, 'Reflect', winOptions);
    if (!result || !result.success) {
      console.log('Reflect: showInMainWindow failed, falling back');
      await HTMLView.showWindowWithOptions(fullHTML, 'Reflect', winOptions);
    }
  } catch (err) {
    CommandBar.showLoading(false);
    console.log('Reflect error: ' + String(err));
  }
}

async function refreshReflect() {
  await showReflect();
}

async function onMessageFromHTMLView(actionType, data) {
  try {
    var msg = typeof data === 'string' ? JSON.parse(data) : data;
    var note = getTodayNote();

    switch (actionType) {
      case 'switchTab':
        await showReflect(msg.tab);
        break;

      case 'addToPlan':
        if (note && msg.content) {
          addToPlan(note, msg.content);
          await showReflect('today');
        }
        break;

      case 'reorderPlan':
        if (note && msg.orderedLineIndices) {
          reorderPlanTasks(note, msg.orderedLineIndices);
          await showReflect('today');
        }
        break;

      case 'togglePlanTask':
        if (note && msg.lineIndex !== undefined) {
          togglePlanTask(note, parseInt(msg.lineIndex, 10));
          var config = getSettings();
          await showReflect(config.lastTab || 'today');
        }
        break;

      case 'startFocus':
        if (note && msg.taskContent) {
          startFocusSession(note, msg.taskContent);
          await showReflect('focus');
        }
        break;

      case 'stopFocus':
        if (note) {
          stopFocusSession(note, msg.notes || '');
          await showReflect('focus');
        }
        break;

      case 'completeFocusTask':
        if (note && msg.lineIndex !== undefined) {
          // Stop timer if running
          var timerConf = getSettings();
          if (timerConf.timerState && timerConf.timerState.startTime) {
            stopFocusSession(note, msg.notes || '');
          }
          togglePlanTask(note, parseInt(msg.lineIndex, 10));
          await showReflect('focus');
        }
        break;

      case 'fetchClickUp':
        var clickConf = getSettings();
        var tasks = await fetchClickUpTasks(clickConf.clickupApiToken, clickConf.clickupTeamId);
        await sendToHTMLWindow(WINDOW_ID, 'CLICKUP_TASKS', { tasks: tasks });
        break;

      case 'openNote':
        if (msg.filename) {
          await CommandBar.onMainThread();
          Editor.openNoteByFilename(msg.filename);
        }
        break;

      default:
        console.log('Reflect: unknown action: ' + actionType);
    }
  } catch (err) {
    console.log('Reflect onMessage error: ' + String(err));
  }
}

async function sendToHTMLWindow(windowId, type, data) {
  try {
    if (typeof HTMLView === 'undefined' || typeof HTMLView.runJavaScript !== 'function') return;
    var payload = {};
    var keys = Object.keys(data);
    for (var k = 0; k < keys.length; k++) payload[keys[k]] = data[keys[k]];
    payload.NPWindowID = windowId;

    var stringifiedPayload = JSON.stringify(payload);
    var doubleStringified = JSON.stringify(stringifiedPayload);
    var jsCode = '(function() { try { var pd = ' + doubleStringified + '; var p = JSON.parse(pd); window.postMessage({ type: "' + type + '", payload: p }, "*"); } catch(e) { console.error("sendToHTMLWindow error:", e); } })();';
    await HTMLView.runJavaScript(jsCode, windowId);
  } catch (err) {
    console.log('sendToHTMLWindow error: ' + String(err));
  }
}

// ============================================
// EXPORTS
// ============================================

globalThis.showReflect = showReflect;
globalThis.onMessageFromHTMLView = onMessageFromHTMLView;
globalThis.refreshReflect = refreshReflect;
