// asktru.Reflect — script.js
// Sunsama-like Daily Planning for NotePlan

// ============================================
// CONFIGURATION
// ============================================

var PLUGIN_ID = 'asktru.Reflect';
var WINDOW_ID = 'asktru.Reflect.dashboard';
var REFLECT_HEADING = 'Reflect';

// Task cache — avoid re-scanning on every tab switch
var _taskCache = null;
var _taskCacheTime = 0;
var _taskCacheTTL = 30000; // 30 seconds

function invalidateTaskCache() { _taskCache = null; _taskCacheTime = 0; }

async function getCachedTasks(note, config) {
  var now = Date.now();
  if (_taskCache && (now - _taskCacheTime) < _taskCacheTTL) return _taskCache;

  var calEvents = await getTodayCalendarEvents();
  _taskCache = {
    calendarEvents: calEvents,
    dailyTasks: getDailyNoteTasks(note),
    scheduledToday: getScheduledForToday(),
    scheduledWeek: getScheduledThisWeek(),
  };
  _taskCacheTime = now;
  return _taskCache;
}

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

/**
 * Strip trailing collapse indicator (` …` or `…`) from heading content.
 * NotePlan appends this when a heading is collapsed in the UI.
 */
function stripCollapse(str) {
  return (str || '').replace(/\s*…$/, '').trim();
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
      if (p.type === 'title' && p.headingLevel === headingLevel && stripCollapse(p.content) === headingText) {
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
    if (p.type === 'title' && p.headingLevel === headingLevel && stripCollapse(p.content) === headingText) {
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
    // Add empty line before # Reflect for visual separation
    note.appendParagraph('', 'empty');
    note.appendParagraph(REFLECT_HEADING, 'title');
    reflectLine = note.paragraphs.length - 1;
  }

  // Check if ## subHeading exists under # Reflect
  var subLine = findHeadingLine(note, subHeading, 2);
  if (subLine !== -1 && subLine > reflectLine) {
    return subLine;
  }

  // Need to create ## subHeading
  var reflectRange = findSectionRange(note, REFLECT_HEADING, 1);
  if (!reflectRange) {
    note.appendParagraph(subHeading, 'title');
    return note.paragraphs.length - 1;
  }

  // Insert at end of Reflect section (no trailing empty line — content follows directly)
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
        rawContent: p.rawContent || p.content,
        type: t,
        lineIndex: p.lineIndex,
        indentLevel: p.indentLevel || 0,
        isComplete: (t === 'checklistDone' || t === 'done' || t === 'checklistCancelled' || t === 'cancelled'),
      });
    }
  }
  return tasks;
}

/**
 * Parse the Focus section log to calculate actual focused time per task.
 * Returns a map of task content → total minutes focused.
 */
function getFocusedTimeMap(note) {
  var map = {};
  var range = findSectionRange(note, 'Focus', 2);
  if (!range) return map;

  var paras = note.paragraphs;
  for (var i = range.start; i < range.end; i++) {
    var p = paras[i];
    if (p.type !== 'list') continue;
    var doneMatch = p.content.match(/\*done focusing on:\*\s+(.+?)\s+\((\d+(?:\.\d+)?h(?:\s*\d+m)?|\d+m)\)\s*$/);
    if (doneMatch) {
      var taskContent = doneMatch[1];
      var durStr = doneMatch[2];
      var mins = 0;
      var hm = durStr.match(/(\d+(?:\.\d+)?)h/);
      var mm = durStr.match(/(\d+)m/);
      if (hm) mins += parseFloat(hm[1]) * 60;
      if (mm) mins += parseInt(mm[1], 10);
      map[taskContent] = (map[taskContent] || 0) + mins;
    }
  }
  return map;
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
/**
 * Scan all notes for tasks scheduled in a date range.
 * includeWeekly: if true, also include tasks from weekly/week-scheduled notes.
 */
/**
 * Check if a task should be excluded from Today/This Week source tabs.
 * Excludes tasks with @repeat (routines) or #waiting (not actionable).
 */
function shouldExcludeFromSources(content) {
  if (/@repeat\s*\(/.test(content)) return true;
  if (/#waiting\b/.test(content)) return true;
  return false;
}

function getScheduledTasks(startDate, endDate, includeWeekly) {
  var tasks = [];
  var todayStr = getTodayStr();
  var foldersToExclude = ['@Archive', '@Trash', '@Templates'];

  function hasScheduleDateInRange(content, start, end) {
    var matches = content.match(/>(\d{4}-\d{2}-\d{2})/g);
    if (matches) {
      for (var j = 0; j < matches.length; j++) {
        var d = matches[j].substring(1);
        if (d >= start && d <= end) return d;
      }
    }
    if (content.indexOf('>today') >= 0 && todayStr >= start && todayStr <= end) return todayStr;
    return null;
  }

  var currentWeek = includeWeekly ? getISOWeek(todayStr) : null;

  function hasScheduleWeek(content) {
    if (!currentWeek) return null;
    var match = content.match(/>(\d{4}-W\d{2})/);
    if (match && match[1] === currentWeek) return match[1];
    return null;
  }

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
      if (shouldExcludeFromSources(p.content)) continue;
      var schedDate = hasScheduleDateInRange(p.content, startDate, endDate);
      var schedWeek = hasScheduleWeek(p.content);
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

  // Scan calendar notes
  var cNotes = DataStore.calendarNotes;
  for (var cn = 0; cn < cNotes.length; cn++) {
    var calNote = cNotes[cn];
    var fn = (calNote.filename || '').replace(/\.(md|txt)$/, '');

    // Daily notes: YYYYMMDD
    var dailyMatch = fn.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dailyMatch) {
      var noteDate = dailyMatch[1] + '-' + dailyMatch[2] + '-' + dailyMatch[3];
      if (noteDate < startDate || noteDate > endDate) continue;
      if (noteDate === todayStr) continue;
      var calParas = calNote.paragraphs;
      for (var ci = 0; ci < calParas.length; ci++) {
        var cp = calParas[ci];
        if (cp.type !== 'open' && cp.type !== 'checklist') continue;
        if (shouldExcludeFromSources(cp.content)) continue;
        tasks.push({
          content: cp.content, rawContent: cp.content, type: cp.type,
          filename: calNote.filename, lineIndex: cp.lineIndex,
          noteTitle: noteDate, scheduledDate: noteDate, source: 'scheduled',
        });
      }
      continue;
    }

    // Weekly notes: only if includeWeekly
    if (includeWeekly) {
      var weekMatch = fn.match(/^(\d{4}-W\d{2})$/);
      if (weekMatch && weekMatch[1] === currentWeek) {
        var wParas = calNote.paragraphs;
        for (var wi = 0; wi < wParas.length; wi++) {
          var wp = wParas[wi];
          if (wp.type !== 'open' && wp.type !== 'checklist') continue;
          if (shouldExcludeFromSources(wp.content)) continue;
          tasks.push({
            content: wp.content, rawContent: wp.content, type: wp.type,
            filename: calNote.filename, lineIndex: wp.lineIndex,
            noteTitle: weekMatch[1], scheduledDate: weekMatch[1], source: 'scheduled',
          });
        }
      }
    }
  }

  return tasks;
}

function getScheduledForToday() {
  // Today + overdue — daily dates only, no weekly/monthly
  var today = getTodayStr();
  return getScheduledTasks('2000-01-01', today, false);
}

function getScheduledThisWeek() {
  // Future days this week + weekly note tasks
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var tomorrowStr = getDateStr(tomorrow);
  var range = getWeekRange();
  return getScheduledTasks(tomorrowStr, range.end, true);
}

// ============================================
// CALENDAR EVENTS
// ============================================

async function getTodayCalendarEvents() {
  try {
    if (typeof Calendar === 'undefined' || typeof Calendar.eventsBetween !== 'function') {
      console.log('Reflect: Calendar API not available');
      return [];
    }
    var today = new Date();
    var startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    var endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
    var events = await Calendar.eventsBetween(startOfDay, endOfDay, '');
    if (!events || !Array.isArray(events)) return [];

    var result = [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.date || ev.isAllDay) continue; // Skip all-day events
      // Skip NotePlan's internal timeblock calendar
      var calName = (ev.calendar || '').toLowerCase();
      if (calName.indexOf('noteplan') >= 0 && calName.indexOf('timeblock') >= 0) continue;
      var startDate = new Date(ev.date);
      var endDate = ev.endDate ? new Date(ev.endDate) : startDate;
      var durationMin = Math.round((endDate - startDate) / 60000);
      if (durationMin <= 0) durationMin = 30;

      // Format duration
      var durStr = '';
      if (durationMin >= 60) {
        var h = Math.floor(durationMin / 60);
        var m = durationMin % 60;
        durStr = h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
      } else {
        durStr = durationMin + 'm';
      }

      // Format time
      var hh = String(startDate.getHours()).padStart(2, '0');
      var mm = String(startDate.getMinutes()).padStart(2, '0');

      // Build the NotePlan calendar event deeplink
      var dateTimeStr = getDateStr(startDate) + ' ' + hh + ':' + mm;
      var eventId = ev.id || '';
      var evColor = ev.color || '#5A9FD4';
      var evTitle = ev.title || 'Event';
      var calendarLink = '![📅](' + dateTimeStr + ':::' + eventId + ':::NA:::' + evTitle + ':::' + evColor + ')';

      result.push({
        content: evTitle,
        type: 'calendar',
        calendarTitle: ev.calendar || '',
        color: evColor,
        startTime: hh + ':' + mm,
        durationMin: durationMin,
        durationStr: durStr,
        eventId: eventId,
        calendarLink: calendarLink,
        source: 'calendar',
      });
    }
    // Sort by start time
    result.sort(function(a, b) { return a.startTime < b.startTime ? -1 : 1; });
    return result;
  } catch (e) {
    console.log('Reflect: Calendar error: ' + String(e));
    return [];
  }
}

// ============================================
// CLICKUP INTEGRATION
// ============================================

async function fetchClickUpTasks(apiToken, teamId) {
  if (!apiToken || !teamId) return [];
  try {
    // Use fetch() — NotePlan shows a loading overlay with the URL,
    // but XMLHttpRequest is not available in this environment.
    async function doFetch(url) {
      var resp = await fetch(url, { method: 'GET', headers: { 'Authorization': apiToken } });
      if (resp && typeof resp.text === 'function') return await resp.text();
      if (typeof resp === 'string') return resp;
      if (resp && resp.body) return typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
      if (resp && resp.data) return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      return JSON.stringify(resp);
    }

    // Step 1: Get authorized user to find their member ID
    var assigneeParam = '';
    try {
      var meBody = await doFetch('https://api.clickup.com/api/v2/user');
      var meData = JSON.parse(meBody);
      var userId = meData && meData.user ? String(meData.user.id) : '';
      if (userId) {
        assigneeParam = '&assignees%5B%5D=' + userId;
        console.log('Reflect: ClickUp user ID=' + userId);
      }
    } catch (meErr) {
      console.log('Reflect: Could not get ClickUp user: ' + String(meErr));
    }

    // Step 2: Get tasks
    var url = 'https://api.clickup.com/api/v2/team/' + teamId +
      '/task?statuses%5B%5D=open&statuses%5B%5D=in%20progress' +
      '&order_by=due_date&reverse=true&subtasks=true&include_closed=false' +
      assigneeParam;

    console.log('Reflect: Fetching ClickUp tasks...');
    var body = await doFetch(url);
    var data = JSON.parse(body);
    console.log('Reflect: Got ' + (data.tasks || []).length + ' ClickUp tasks');
    var tasks = (data.tasks || []).map(function(t) {
      return {
        content: t.name,
        type: 'clickup',
        clickupId: t.id,
        url: t.url,
        status: (t.status || {}).status || 'open',
        dueDate: t.due_date ? new Date(parseInt(t.due_date)).toISOString().slice(0, 10) : null,
        listName: t.list ? t.list.name : '',
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

  // Find last non-empty line in the Plan section to insert right after it
  var paras = note.paragraphs;
  var insertAt = range.start; // default: right after heading
  for (var i = range.end - 1; i >= range.start; i--) {
    var p = paras[i];
    if (p.type !== 'empty' && p.content && p.content.trim() !== '') {
      insertAt = i + 1;
      break;
    }
  }

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

function setTimeEstimate(note, lineIndex, estimate) {
  var paras = note.paragraphs;
  if (lineIndex < 0 || lineIndex >= paras.length) return;
  var p = paras[lineIndex];
  // Remove existing time estimate
  var cleaned = p.content.replace(/\s*\*-\s*\d+(?:\.\d+)?h(?:\s*\d+m)?\*\s*$/, '').replace(/\s*\*-\s*\d+m\*\s*$/, '');
  // Append new estimate if provided
  if (estimate) {
    p.content = cleaned + ' *- ' + estimate + '*';
  } else {
    p.content = cleaned;
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

/**
 * Find the insertion point at the end of a section's content,
 * skipping any trailing empty lines (insert before them).
 */
function getSectionInsertPoint(note, heading, level) {
  var range = findSectionRange(note, heading, level);
  if (!range) return -1;
  var paras = note.paragraphs;
  // Walk backwards from end to skip trailing empty lines
  var insertAt = range.end;
  for (var i = range.end - 1; i >= range.start; i--) {
    if (paras[i].type !== 'empty' && paras[i].content && paras[i].content.trim() !== '') {
      insertAt = i + 1;
      break;
    }
  }
  return insertAt;
}

function startFocusSession(note, taskContent) {
  ensureSection(note, 'Focus');
  var insertAt = getSectionInsertPoint(note, 'Focus', 2);
  if (insertAt < 0) return;

  var timeStr = getTimeStr();
  var logEntry = timeStr + ' *focusing on:* ' + taskContent;
  note.insertParagraph(logEntry, insertAt, 'list');

  // Save timer state
  saveTimerState({ startTime: Date.now(), taskContent: taskContent });
}

function stopFocusSession(note, focusNotes) {
  var config = getSettings();
  var timer = config.timerState;
  if (!timer.startTime) return;

  ensureSection(note, 'Focus');
  var insertAt = getSectionInsertPoint(note, 'Focus', 2);
  if (insertAt < 0) return;

  var elapsed = Date.now() - timer.startTime;
  var duration = formatDuration(elapsed);
  var timeStr = getTimeStr();

  // Insert notes as indented blockquote BEFORE the stop line
  if (focusNotes && focusNotes.trim()) {
    var notesText = focusNotes.trim();
    // Strip leading bullet marker if present
    if (notesText.startsWith('- ') || notesText.startsWith('* ')) {
      notesText = notesText.substring(2);
    }
    note.insertParagraph('\t> ' + notesText, insertAt, 'text');
    insertAt++; // adjust for the line we just inserted
  }

  var logEntry = timeStr + ' *done focusing on:* ' + timer.taskContent + ' (' + duration + ')';
  note.insertParagraph(logEntry, insertAt, 'list');

  // Clear timer state
  saveTimerState({});
}

// ============================================
// RENDER MARKDOWN (basic)
// ============================================

function extractPriority(content) {
  // !!! = level 3 (highest), !! = level 2, ! = level 1 (lowest)
  if (content.startsWith('!!! ')) return { level: 3, content: content.substring(4) };
  if (content.startsWith('!! ')) return { level: 2, content: content.substring(3) };
  if (content.startsWith('! ')) return { level: 1, content: content.substring(2) };
  return { level: 0, content: content };
}

function renderPriorityBadge(level) {
  if (level === 0) return '';
  var labels = { 1: '!', 2: '!!', 3: '!!!' };
  var classes = { 1: 'rf-pri-1', 2: 'rf-pri-2', 3: 'rf-pri-3' };
  return '<span class="rf-pri ' + classes[level] + '">' + labels[level] + '</span>';
}

/**
 * Parse calendar event deeplink from raw content.
 * Format: ![📅](DATE TIME:::EVENT_ID:::NA:::TITLE:::COLOR)
 * Returns { found: true, before, after, title, time, color } or { found: false }
 */
function parseCalendarLink(str) {
  // Find the ![...](... ) pattern
  var imgStart = str.indexOf('![');
  if (imgStart === -1) return { found: false };
  var bracketEnd = str.indexOf('](', imgStart);
  if (bracketEnd === -1) return { found: false };
  var parenStart = bracketEnd + 2;
  var parenEnd = str.indexOf(')', parenStart);
  if (parenEnd === -1) return { found: false };

  var inner = str.substring(parenStart, parenEnd);
  var parts = inner.split(':::');
  if (parts.length < 5) return { found: false };

  // parts[0] = "2026-03-22 10:15", parts[1] = eventId, parts[2] = "NA", parts[3] = title, parts[4] = color
  var dateTime = parts[0].trim();
  var timeMatch = dateTime.match(/(\d{2}:\d{2})/);
  var time = timeMatch ? timeMatch[1] : '';
  var title = parts[3] || '';
  var color = parts[4] || '#5A9FD4';

  return {
    found: true,
    before: str.substring(0, imgStart),
    after: str.substring(parenEnd + 1),
    title: title,
    time: time,
    color: color,
  };
}

function renderMarkdown(str) {
  if (!str) return '';

  // Calendar event deeplink: process BEFORE esc()
  var calParsed = parseCalendarLink(str);
  var calBadgeHTML = '';
  if (calParsed.found) {
    calBadgeHTML = '<span class="rf-cal-badge" data-color="' + esc(calParsed.color) + '">' +
      '<i class="fa-regular fa-calendar" style="color:' + esc(calParsed.color) + '"></i> ' + esc(calParsed.title) +
      ' <span class="rf-cal-time">' + esc(calParsed.time) + '</span></span>';
    // Replace the link with a placeholder, process the rest normally
    str = calParsed.before + '__CALBADGE__' + calParsed.after;
  }

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
  // Wiki links: [[Note Name]]
  s = s.replace(/\[\[([^\]]+)\]\]/g, function(match, noteName) {
    var encoded = encodeURIComponent(noteName);
    var url = 'noteplan://x-callback-url/openNote?noteTitle=' + encoded + '&amp;splitView=yes';
    return '<a class="rf-md-link" href="' + url + '" title="' + noteName.replace(/"/g, '&amp;quot;') + '">' + noteName + '</a>';
  });
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="rf-md-link" title="$2">$1</a>');
  // Hashtags (orange)
  s = s.replace(/(^|[\s(])#([\w\/-]+)/g, '$1<span class="rf-tag">#$2</span>');
  // Mentions (orange)
  s = s.replace(/(^|[\s(])@([\w\/-]+(?:\([^)]*\))?)/g, '$1<span class="rf-mention">@$2</span>');
  // Strip scheduling markers
  s = s.replace(/&gt;(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|today)/g, '');

  // Restore calendar badge LAST — after all regex processing to prevent
  // the hashtag regex from matching #B99AFF inside the style attribute
  if (calBadgeHTML) {
    s = s.replace('__CALBADGE__', calBadgeHTML);
  }
  return s.trim();
}

function renderTaskContent(content) {
  var pri = extractPriority(content);
  var badge = renderPriorityBadge(pri.level);
  var html = renderMarkdown(pri.content);
  return badge + html;
}

// ============================================
// HTML BUILDERS
// ============================================

function buildNav(activeTab) {
  var tabs = [
    { id: 'today', icon: 'fa-solid fa-calendar-day', label: 'Today' },
    { id: 'focus', icon: 'fa-solid fa-mug-hot', label: 'Focus' },
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

/**
 * Extract time estimate from task content.
 * Pattern: *- Xh*, *- Xm*, *- Xh Ym* at the end of the content.
 */
function extractTimeEstimate(content) {
  var match = content.match(/\s*\*-\s*(\d+(?:\.\d+)?h(?:\s*\d+m)?|\d+m)\*\s*$/);
  if (match) {
    return {
      estimate: match[1],
      content: content.substring(0, content.length - match[0].length),
    };
  }
  return { estimate: '', content: content };
}

function formatEstimateLabel(est) {
  if (!est) return '';
  return est;
}

function buildPlanItem(task, index, editable) {
  var isDone = task.isComplete;
  var cbClass = isDone ? 'checklistDone' : 'checklist';
  var cbIcon = isDone ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
  var itemClass = 'rf-plan-item' + (isDone ? ' is-done' : '');

  var parsed = extractTimeEstimate(task.content);
  var pri = extractPriority(parsed.content);
  var contentHTML = renderTaskContent(pri.content);
  var estimateLabel = parsed.estimate;

  var html = '<div class="' + itemClass + '" draggable="' + (editable ? 'true' : 'false') + '" data-line-index="' + task.lineIndex + '" data-index="' + index + '">';
  if (editable) {
    html += '<span class="rf-drag-handle"><i class="fa-solid fa-grip-vertical"></i></span>';
  }
  html += '<span class="rf-plan-cb ' + cbClass + '" data-action="togglePlan" data-line-index="' + task.lineIndex + '">';
  html += '<i class="' + cbIcon + '"></i>';
  html += '</span>';

  // Priority badge (clickable to cycle)
  html += '<span class="rf-plan-pri" data-action="cyclePlanPriority" data-line-index="' + task.lineIndex + '" data-level="' + pri.level + '" title="Cycle priority">';
  if (pri.level > 0) {
    html += renderPriorityBadge(pri.level);
  } else {
    html += '<i class="fa-solid fa-flag rf-pri-none"></i>';
  }
  html += '</span>';

  html += '<span class="rf-plan-content">' + contentHTML + '</span>';

  // Action buttons: open note + time estimate
  html += '<span class="rf-plan-actions">';
  html += '<button class="rf-plan-act-btn" data-action="openDailyNote" title="Open in editor"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>';
  if (editable) {
    html += '<button class="rf-time-btn" data-action="showTimePicker" data-line-index="' + task.lineIndex + '" title="Set time estimate">';
    html += estimateLabel ? '<span class="rf-time-label">' + esc(estimateLabel) + '</span>' : '<i class="fa-regular fa-clock"></i>';
    html += '</button>';
  } else if (estimateLabel) {
    html += '<span class="rf-time-badge">' + esc(estimateLabel) + '</span>';
  }
  html += '</span>';
  html += '</div>';
  return html;
}

function buildSourceTask(task, planContentSet) {
  var isInPlan = planContentSet && planContentSet[task.content];
  var contentHTML = renderTaskContent(task.content);
  var meta = '';
  if (task.noteTitle) {
    meta += '<span class="rf-source-meta"><i class="fa-solid fa-file-lines"></i> ' + esc(task.noteTitle) + '</span>';
  }
  if (task.scheduledDate) {
    var dateClass = 'rf-source-date';
    var todayStr = getTodayStr();
    if (task.scheduledDate < todayStr) dateClass += ' overdue';
    else if (task.scheduledDate === todayStr) dateClass += ' today';
    meta += '<span class="' + dateClass + '"><i class="fa-regular fa-calendar"></i> ' + esc(task.scheduledDate) + '</span>';
  }

  var clickupAttr = task.clickupId ? ' data-clickup-id="' + esc(task.clickupId) + '"' : '';
  var taskClass = 'rf-source-task' + (isInPlan ? ' in-plan' : '');
  var html = '<div class="' + taskClass + '" data-content="' + esc(task.content) + '"' + clickupAttr + '>';

  // "+" button on the left (where status circle would be)
  if (isInPlan) {
    html += '<span class="rf-source-added"><i class="fa-solid fa-check"></i></span>';
  } else {
    html += '<button class="rf-source-add" data-action="addToPlan" data-content="' + esc(task.content) + '"' + clickupAttr + ' title="Add to plan (S)">';
    html += '<i class="fa-solid fa-plus"></i>';
    html += '</button>';
  }

  html += '<div class="rf-source-task-body">';
  html += '<span class="rf-source-task-content">' + contentHTML + '</span>';
  if (meta) html += '<div class="rf-source-task-meta">' + meta + '</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

function buildCalendarSourceTask(event, planContentSet) {
  // Check if this event's title or calendarLink is already in plan
  var isInPlan = planContentSet && (planContentSet[event.content] || planContentSet[event.calendarLink]);
  var taskClass = 'rf-source-task' + (isInPlan ? ' in-plan' : '');

  var html = '<div class="' + taskClass + '" data-content="' + esc(event.content) + '" data-duration="' + esc(event.durationStr) + '" data-calendar-link="' + esc(event.calendarLink) + '">';

  if (isInPlan) {
    html += '<span class="rf-source-added"><i class="fa-solid fa-check"></i></span>';
  } else {
    html += '<button class="rf-source-add" data-action="addCalendarToPlan" data-content="' + esc(event.content) + '" data-duration="' + esc(event.durationStr) + '" data-calendar-link="' + esc(event.calendarLink) + '" title="Add to plan (S)">';
    html += '<i class="fa-solid fa-plus"></i>';
    html += '</button>';
  }

  html += '<div class="rf-source-task-body">';
  html += '<span class="rf-source-task-content">' + esc(event.content) + '</span>';
  html += '<div class="rf-source-task-meta">';
  html += '<span class="rf-source-date"><i class="fa-regular fa-clock"></i> ' + esc(event.startTime) + '</span>';
  html += '<span class="rf-source-meta"><i class="fa-solid fa-hourglass"></i> ' + esc(event.durationStr) + '</span>';
  if (event.calendarTitle) {
    html += '<span class="rf-source-meta" style="border-left: 3px solid ' + esc(event.color) + '; padding-left: 6px;">' + esc(event.calendarTitle) + '</span>';
  }
  html += '</div></div></div>';
  return html;
}

function formatMinutes(mins) {
  if (mins <= 0) return '';
  var h = Math.floor(mins / 60);
  var m = Math.round(mins % 60);
  if (h > 0) return h + 'h' + (m > 0 ? ' ' + m + 'm' : '');
  return m + 'm';
}

function parseEstimateMinutes(est) {
  if (!est) return 0;
  var mins = 0;
  var hm = est.match(/(\d+(?:\.\d+)?)h/);
  var mm = est.match(/(\d+)m/);
  if (hm) mins += parseFloat(hm[1]) * 60;
  if (mm) mins += parseInt(mm[1], 10);
  return mins;
}

function buildTodayPlanItem(task, index, totalCount, focusMap, timerState) {
  var isDone = task.isComplete;
  var parsed = extractTimeEstimate(task.content);
  var contentHTML = renderTaskContent(parsed.content);
  var estimateMin = parseEstimateMinutes(parsed.estimate);

  // Look up actual focused time — match against the raw content without time estimate
  var actualMin = focusMap[parsed.content] || 0;

  // Check if this task is currently being focused on
  var isFocusing = timerState && timerState.startTime && timerState.taskContent === parsed.content;

  var cbClass = isDone ? 'checklistDone' : 'checklist';
  var cbIcon = isDone ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
  var itemClass = 'rf-today-item' + (isDone ? ' is-done' : '') + (isFocusing ? ' is-focusing' : '');

  var html = '<div class="' + itemClass + '" data-line-index="' + task.lineIndex + '" data-index="' + index + '" data-content="' + esc(parsed.content) + '">';

  // Checkbox
  html += '<span class="rf-plan-cb ' + cbClass + '" data-action="togglePlan" data-line-index="' + task.lineIndex + '">';
  html += '<i class="' + cbIcon + '"></i>';
  html += '</span>';

  // Content
  html += '<div class="rf-today-item-body">';
  html += '<span class="rf-plan-content">' + contentHTML + '</span>';

  // Time info: focusing → tracked → estimated
  if (isFocusing || actualMin > 0 || estimateMin > 0) {
    html += '<div class="rf-today-time-info">';
    if (isFocusing) {
      html += '<span class="rf-time-live" data-timer-start="' + timerState.startTime + '"><i class="fa-solid fa-circle rf-pulse"></i> focusing</span>';
    }
    if (actualMin > 0) {
      var overUnder = estimateMin > 0 ? (actualMin <= estimateMin ? ' on-track' : ' over') : '';
      html += '<span class="rf-time-actual' + overUnder + '"><i class="fa-solid fa-stopwatch"></i> ' + esc(formatMinutes(actualMin)) + ' tracked</span>';
    }
    if (estimateMin > 0) {
      html += '<span class="rf-time-est"><i class="fa-regular fa-clock"></i> ' + esc(formatMinutes(estimateMin)) + ' est</span>';
    }
    html += '</div>';
  }

  html += '</div>'; // body

  // Action buttons (only for incomplete tasks)
  if (!isDone) {
    html += '<div class="rf-today-item-actions">';
    if (!isFocusing) {
      html += '<button class="rf-today-act" data-action="startFocusFromToday" data-content="' + esc(parsed.content) + '" title="Focus"><i class="fa-solid fa-mug-hot"></i></button>';
    } else {
      html += '<button class="rf-today-act focusing" data-action="stopFocusFromToday" title="Stop Focus"><i class="fa-solid fa-stop"></i></button>';
    }
    if (index > 0) {
      html += '<button class="rf-today-act" data-action="movePlanUp" data-line-index="' + task.lineIndex + '" title="Move up"><i class="fa-solid fa-chevron-up"></i></button>';
    }
    if (index < totalCount - 1) {
      html += '<button class="rf-today-act" data-action="movePlanDown" data-line-index="' + task.lineIndex + '" title="Move down"><i class="fa-solid fa-chevron-down"></i></button>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function buildTodayTab(planTasks, focusMap, timerState) {
  var remaining = planTasks.filter(function(t) { return !t.isComplete; });

  // Calculate total estimated and actual time
  var totalEstMin = 0;
  var totalActMin = 0;
  for (var t = 0; t < remaining.length; t++) {
    var parsed = extractTimeEstimate(remaining[t].content);
    totalEstMin += parseEstimateMinutes(parsed.estimate);
    totalActMin += (focusMap[parsed.content] || 0);
  }
  var totalEstStr = formatMinutes(totalEstMin);
  var totalActStr = formatMinutes(totalActMin);

  var html = '<div class="rf-today-overview">';
  html += '<div class="rf-panel-header">';
  html += '<h2 class="rf-panel-title">Today\'s Plan</h2>';
  html += '<span class="rf-plan-count">' + remaining.length + ' remaining';
  if (totalEstStr) html += ' &middot; ' + esc(totalEstStr);
  if (totalActStr) html += ' focused';
  html += '</span>';
  html += '</div>';
  html += '<div class="rf-plan-list" id="planList">';
  if (planTasks.length === 0) {
    html += '<div class="rf-empty">No tasks planned yet. Go to the <strong>Plan</strong> tab to add tasks.</div>';
  } else {
    var incompleteCount = remaining.length;
    for (var i = 0; i < planTasks.length; i++) {
      html += buildTodayPlanItem(planTasks[i], i, planTasks.length, focusMap, timerState);
    }
  }
  html += '</div>';
  html += '</div>';
  return html;
}

function buildPlanTab(data) {
  var planTasks = data.planTasks;
  var calendarEvents = data.calendarEvents || [];
  var dailyTasks = data.dailyTasks;
  var scheduledToday = data.scheduledToday;
  var scheduledWeek = data.scheduledWeek;
  var hasClickUp = data.hasClickUp;

  // Build set of plan task contents for marking already-added tasks
  var planContentSet = {};
  for (var p = 0; p < planTasks.length; p++) {
    var parsed = extractTimeEstimate(planTasks[p].content);
    planContentSet[parsed.content] = true;
    planContentSet[planTasks[p].content] = true;
    // Also extract calendar deeplink if present
    var calMatch = parsed.content.match(/!\[.*?\]\([^)]+\)/);
    if (calMatch) planContentSet[calMatch[0]] = true;
  }

  // Calculate total estimated time for remaining tasks
  var remaining = planTasks.filter(function(t) { return !t.isComplete; });
  var totalMinutes = 0;
  for (var t = 0; t < remaining.length; t++) {
    var est = extractTimeEstimate(remaining[t].content).estimate;
    if (est) {
      var hMatch = est.match(/(\d+(?:\.\d+)?)h/);
      var mMatch = est.match(/(\d+)m/);
      if (hMatch) totalMinutes += parseFloat(hMatch[1]) * 60;
      if (mMatch) totalMinutes += parseInt(mMatch[1], 10);
    }
  }
  var totalStr = '';
  if (totalMinutes > 0) {
    var hrs = Math.floor(totalMinutes / 60);
    var mins = totalMinutes % 60;
    totalStr = hrs > 0 ? (hrs + 'h' + (mins > 0 ? ' ' + mins + 'm' : '')) : (mins + 'm');
  }

  var html = '<div class="rf-today">';

  // Left: Plan (editable)
  html += '<div class="rf-plan-panel">';
  html += '<div class="rf-panel-header">';
  html += '<h2 class="rf-panel-title">Today\'s Plan</h2>';
  html += '<span class="rf-plan-count">' + remaining.length + ' remaining';
  if (totalStr) html += ' &middot; ' + esc(totalStr);
  html += '</span>';
  html += '</div>';
  html += '<div class="rf-plan-list" id="planList">';
  if (planTasks.length === 0) {
    html += '<div class="rf-empty">Add tasks from the right panel to plan your day</div>';
  } else {
    for (var i = 0; i < planTasks.length; i++) {
      html += buildPlanItem(planTasks[i], i, true);
    }
  }
  html += '</div>';
  html += '</div>';

  // Right: Sources — order: Calendar, Today, This Week, ClickUp, Daily Note
  html += '<div class="rf-sources-panel">';
  html += '<div class="rf-source-tabs">';
  html += '<button class="rf-source-tab active" data-source="calendar"><i class="fa-regular fa-calendar"></i> Calendar</button>';
  html += '<button class="rf-source-tab" data-source="today">Today</button>';
  html += '<button class="rf-source-tab" data-source="week">This Week</button>';
  if (hasClickUp) {
    html += '<button class="rf-source-tab" data-source="clickup">ClickUp</button>';
  }
  html += '<button class="rf-source-tab" data-source="daily">Daily Note</button>';
  html += '</div>';

  // Calendar events
  html += '<div class="rf-source-list active" data-source="calendar">';
  if (calendarEvents.length === 0) {
    html += '<div class="rf-empty">No calendar events for today</div>';
  } else {
    for (var ce = 0; ce < calendarEvents.length; ce++) {
      html += buildCalendarSourceTask(calendarEvents[ce], planContentSet);
    }
  }
  html += '</div>';

  // Today (overdue + today, daily dates only)
  html += '<div class="rf-source-list" data-source="today">';
  if (scheduledToday.length === 0) {
    html += '<div class="rf-empty">No tasks scheduled for today</div>';
  } else {
    for (var st = 0; st < scheduledToday.length; st++) {
      html += buildSourceTask(scheduledToday[st], planContentSet);
    }
  }
  html += '</div>';

  // This Week — grouped by scheduled date
  html += '<div class="rf-source-list" data-source="week">';
  if (scheduledWeek.length === 0) {
    html += '<div class="rf-empty">No tasks scheduled this week</div>';
  } else {
    // Group tasks by scheduledDate
    var weekGroups = {};
    var weekGroupOrder = [];
    for (var sw = 0; sw < scheduledWeek.length; sw++) {
      var wKey = scheduledWeek[sw].scheduledDate || 'Unknown';
      if (!weekGroups[wKey]) {
        weekGroups[wKey] = [];
        weekGroupOrder.push(wKey);
      }
      weekGroups[wKey].push(scheduledWeek[sw]);
    }
    // Sort: week-level dates first (e.g. 2026-W13), then daily dates ascending
    weekGroupOrder.sort(function(a, b) {
      var aIsWeek = a.indexOf('-W') >= 0;
      var bIsWeek = b.indexOf('-W') >= 0;
      if (aIsWeek && !bIsWeek) return -1;
      if (!aIsWeek && bIsWeek) return 1;
      return a.localeCompare(b);
    });
    for (var wg = 0; wg < weekGroupOrder.length; wg++) {
      var gKey = weekGroupOrder[wg];
      var gLabel = gKey;
      // Format label
      if (gKey.indexOf('-W') >= 0) {
        gLabel = 'This Week (' + gKey + ')';
      } else {
        // Format daily date as "Wed, Mar 26"
        var parts = gKey.split('-');
        var gDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        gLabel = dayNames[gDate.getDay()] + ', ' + monthNames[gDate.getMonth()] + ' ' + gDate.getDate();
      }
      html += '<div class="rf-source-group-header">' + esc(gLabel) + ' <span class="rf-source-group-count">' + weekGroups[gKey].length + '</span></div>';
      for (var wt = 0; wt < weekGroups[gKey].length; wt++) {
        html += buildSourceTask(weekGroups[gKey][wt], planContentSet);
      }
    }
  }
  html += '</div>';

  // ClickUp (lazy loaded)
  if (hasClickUp) {
    html += '<div class="rf-source-list" data-source="clickup">';
    html += '<div class="rf-empty rf-clickup-loading">Loading ClickUp tasks...</div>';
    html += '</div>';
  }

  // Daily Note
  html += '<div class="rf-source-list" data-source="daily">';
  if (dailyTasks.length === 0) {
    html += '<div class="rf-empty">No tasks in today\'s daily note</div>';
  } else {
    for (var d = 0; d < dailyTasks.length; d++) {
      html += buildSourceTask(dailyTasks[d], planContentSet);
    }
  }
  html += '</div>';

  html += '</div>';
  html += '</div>';
  return html;
}

function buildFocusTab(planTasks, timerState, focusMap) {
  var html = '<div class="rf-focus">';
  var isTimerActive = timerState.startTime && timerState.taskContent;

  // If timer is active, show the task being focused on
  // Otherwise, show the topmost incomplete plan task
  var currentTask = null;
  var currentTaskContent = '';
  if (isTimerActive) {
    currentTaskContent = timerState.taskContent;
    // Find the matching plan task for its lineIndex
    for (var ti = 0; ti < planTasks.length; ti++) {
      var tiParsed = extractTimeEstimate(planTasks[ti].content);
      if (tiParsed.content === currentTaskContent) {
        currentTask = planTasks[ti];
        break;
      }
    }
    // Even if not found in plan, still show the focus session
    if (!currentTask) {
      currentTask = { content: currentTaskContent, lineIndex: -1, isComplete: false };
    }
  } else {
    for (var i = 0; i < planTasks.length; i++) {
      if (!planTasks[i].isComplete) {
        currentTask = planTasks[i];
        currentTaskContent = extractTimeEstimate(planTasks[i].content).content;
        break;
      }
    }
  }

  if (!currentTask) {
    html += '<div class="rf-focus-empty">';
    html += '<i class="fa-solid fa-check-double rf-focus-empty-icon"></i>';
    html += '<p>No tasks in your plan yet.</p>';
    html += '<p class="rf-text-muted">Add tasks in the Plan tab first.</p>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  var displayContent = isTimerActive ? currentTaskContent : extractTimeEstimate(currentTask.content).content;
  var startTimeAttr = isTimerActive ? ' data-timer-start="' + timerState.startTime + '"' : '';

  // Time data for this task
  var parsedTask = extractTimeEstimate(currentTask.content);
  var estimateMin = parseEstimateMinutes(parsedTask.estimate);
  var trackedMin = focusMap[displayContent] || 0;

  // Store tracked/estimate as data attrs for live JS updates
  var dataAttrs = startTimeAttr;
  dataAttrs += ' data-tracked-min="' + trackedMin + '"';
  dataAttrs += ' data-estimate-min="' + estimateMin + '"';

  html += '<div class="rf-focus-card"' + dataAttrs + '>';
  html += '<div class="rf-focus-label">' + (isTimerActive ? 'Currently focusing on' : 'Next up') + '</div>';
  html += '<div class="rf-focus-task">' + renderTaskContent(displayContent) + '</div>';

  html += '<div class="rf-focus-timer" id="focusTimer">' + (isTimerActive ? '--:--' : '00:00') + '</div>';

  // Time breakdown stats
  html += '<div class="rf-focus-stats" id="focusStats">';
  if (isTimerActive) {
    html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">This session</span><span class="rf-focus-stat-value" id="statSession">--:--</span></div>';
    html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">Total tracked</span><span class="rf-focus-stat-value" id="statTotal">' + esc(formatMinutes(trackedMin)) + '</span></div>';
    if (estimateMin > 0) {
      var remainMin = Math.max(0, estimateMin - trackedMin);
      html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">Remaining</span><span class="rf-focus-stat-value" id="statRemaining">' + esc(formatMinutes(remainMin)) + '</span></div>';
      html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">Estimate</span><span class="rf-focus-stat-value">' + esc(formatMinutes(estimateMin)) + '</span></div>';
    }
  } else {
    if (trackedMin > 0) {
      html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">Already tracked</span><span class="rf-focus-stat-value">' + esc(formatMinutes(trackedMin)) + '</span></div>';
    }
    if (estimateMin > 0) {
      var remainIdle = Math.max(0, estimateMin - trackedMin);
      html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">Remaining</span><span class="rf-focus-stat-value">' + esc(formatMinutes(remainIdle)) + '</span></div>';
      html += '<div class="rf-focus-stat"><span class="rf-focus-stat-label">Estimate</span><span class="rf-focus-stat-value">' + esc(formatMinutes(estimateMin)) + '</span></div>';
    }
  }
  html += '</div>';

  html += '<div class="rf-focus-controls">';
  if (isTimerActive) {
    html += '<button class="rf-focus-btn stop" data-action="stopFocus"><i class="fa-solid fa-stop"></i> Stop</button>';
  } else {
    html += '<button class="rf-focus-btn start" data-action="startFocus" data-content="' + esc(displayContent) + '"><i class="fa-solid fa-play"></i> Start Focus</button>';
  }
  html += '</div>';

  html += '<div class="rf-notes-editor">';
  html += '<div class="rf-notes-toolbar">';
  html += '<button class="rf-notes-tb-btn" data-md-action="bold" title="Bold"><i class="fa-solid fa-bold"></i></button>';
  html += '<button class="rf-notes-tb-btn" data-md-action="italic" title="Italic"><i class="fa-solid fa-italic"></i></button>';
  html += '<button class="rf-notes-tb-btn" data-md-action="code" title="Inline code"><i class="fa-solid fa-code"></i></button>';
  html += '<button class="rf-notes-tb-btn" data-md-action="link" title="Link"><i class="fa-solid fa-link"></i></button>';
  html += '<button class="rf-notes-tb-btn" data-md-action="bullet" title="Bullet point"><i class="fa-solid fa-list"></i></button>';
  html += '<button class="rf-notes-tb-btn" data-md-action="task" title="Task"><i class="fa-solid fa-square-check"></i></button>';
  html += '</div>';
  html += '<div class="rf-focus-notes" id="focusNotes" contenteditable="true" data-placeholder="Session notes..."></div>';
  html += '</div>';

  html += '<button class="rf-focus-complete" data-action="completeFocusTask" data-line-index="' + currentTask.lineIndex + '"><i class="fa-solid fa-check"></i> Complete & Next</button>';

  html += '</div>'; // focus-card
  html += '</div>'; // rf-focus
  return html;
}

/**
 * Get unique focused-on tasks from the Focus section (with total time).
 */
function getWorkedOnTasks(focusMap, planTasks) {
  // Start with all tasks from focusMap (these were focused on)
  var worked = [];
  var seen = {};
  var keys = Object.keys(focusMap);
  for (var i = 0; i < keys.length; i++) {
    var content = keys[i];
    seen[content] = true;
    worked.push({ content: content, minutes: focusMap[content] });
  }
  // Also include completed plan tasks not already in focusMap
  for (var j = 0; j < planTasks.length; j++) {
    if (planTasks[j].isComplete) {
      var parsed = extractTimeEstimate(planTasks[j].content);
      if (!seen[parsed.content]) {
        seen[parsed.content] = true;
        worked.push({ content: parsed.content, minutes: 0 });
      }
    }
  }
  return worked;
}

/**
 * Get tasks from Plan that were NOT focused on and NOT completed/cancelled.
 */
function getDidntGetToTasks(focusMap, planTasks) {
  var result = [];
  for (var i = 0; i < planTasks.length; i++) {
    if (planTasks[i].isComplete) continue;
    var parsed = extractTimeEstimate(planTasks[i].content);
    if (!focusMap[parsed.content]) {
      result.push({ content: parsed.content });
    }
  }
  return result;
}

/**
 * Read existing highlights text from ## Highlights section in daily note.
 * Returns the raw text lines under ### Highlights subheading.
 */
function getExistingHighlightsText(note) {
  var highlightsLine = findHeadingLine(note, 'Highlights', 2);
  if (highlightsLine < 0) return '';

  var range = findSectionRange(note, 'Highlights', 2);
  if (!range) return '';

  // Find ### Highlights subheading within ## Highlights
  var paras = note.paragraphs;
  var textStart = -1;
  for (var i = range.start; i < range.end; i++) {
    if (paras[i].type === 'title' && paras[i].headingLevel === 3 && stripCollapse(paras[i].content) === 'Highlights') {
      textStart = i + 1;
      break;
    }
  }
  if (textStart < 0) return '';

  // Find end of ### Highlights (next heading or section end)
  var textEnd = range.end;
  for (var j = textStart; j < range.end; j++) {
    if (paras[j].type === 'title') {
      textEnd = j;
      break;
    }
  }

  var lines = [];
  for (var k = textStart; k < textEnd; k++) {
    var p = paras[k];
    if (p.type === 'empty') continue;
    // Strip leading "- " from list items for the textarea
    var line = p.content || '';
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Scan calendar notes for ## Highlights sections, returning entries sorted by date descending.
 * Each entry: { date: 'YYYY-MM-DD', workedOn: [...], didntGetTo: [...], highlights: [...] }
 * Only returns entries that actually have Highlights content.
 */
function getHighlightsHistory(limit, offset) {
  var calNotes = DataStore.calendarNotes;
  if (!calNotes) return [];

  // Collect daily notes only (filename matches YYYYMMDD.md or YYYYMMDD.txt)
  var dailyNotes = [];
  for (var i = 0; i < calNotes.length; i++) {
    var fn = calNotes[i].filename || '';
    if (/^\d{8}\.(md|txt)$/.test(fn)) {
      dailyNotes.push(calNotes[i]);
    }
  }

  // Sort by filename descending (most recent first)
  dailyNotes.sort(function(a, b) {
    return (b.filename || '').localeCompare(a.filename || '');
  });

  var results = [];
  var skipped = 0;

  for (var n = 0; n < dailyNotes.length && results.length < limit; n++) {
    var note = dailyNotes[n];
    var paras = note.paragraphs;
    if (!paras || paras.length === 0) continue;

    // Find ## Highlights heading
    var highlightsStart = -1;
    for (var p = 0; p < paras.length; p++) {
      if (paras[p].type === 'title' && paras[p].headingLevel === 2 &&
          paras[p].content && stripCollapse(paras[p].content) === 'Highlights') {
        highlightsStart = p + 1;
        break;
      }
    }
    if (highlightsStart < 0) continue;

    // Find end of ## Highlights (next h1 or h2)
    var highlightsEnd = paras.length;
    for (var q = highlightsStart; q < paras.length; q++) {
      if (paras[q].type === 'title' && paras[q].headingLevel <= 2) {
        highlightsEnd = q;
        break;
      }
    }

    // Parse subsections: ### Worked on, ### Didn't get to, ### Highlights
    var entry = { date: '', workedOn: [], didntGetTo: [], highlights: [] };

    // Extract date from filename (YYYYMMDD -> YYYY-MM-DD)
    var fnBase = (note.filename || '').replace(/\.\w+$/, '');
    if (fnBase.length === 8) {
      entry.date = fnBase.substring(0, 4) + '-' + fnBase.substring(4, 6) + '-' + fnBase.substring(6, 8);
    }

    var currentSection = null;
    for (var r = highlightsStart; r < highlightsEnd; r++) {
      var para = paras[r];
      if (para.type === 'title' && para.headingLevel === 3) {
        var heading = stripCollapse(para.content);
        if (heading === 'Worked on') currentSection = 'workedOn';
        else if (heading === "Didn't get to") currentSection = 'didntGetTo';
        else if (heading === 'Highlights') currentSection = 'highlights';
        else currentSection = null;
        continue;
      }
      if (para.type === 'empty') continue;
      if (currentSection && (para.type === 'list' || para.type === 'text' || para.type === 'quote')) {
        var content = para.content || '';
        if (content) entry[currentSection].push(content);
      }
    }

    // Only include entries that have any content
    if (entry.workedOn.length === 0 && entry.didntGetTo.length === 0 && entry.highlights.length === 0) continue;

    // Apply offset
    if (skipped < offset) { skipped++; continue; }

    results.push(entry);
  }

  return results;
}

/**
 * Format a highlights entry date for display.
 */
function formatHighlightDate(dateStr) {
  if (!dateStr) return '';
  var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var parts = dateStr.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

/**
 * Save shutdown data to the daily note under ## Highlights.
 * Creates/overwrites the section with Worked on, Didn't get to, and Highlights.
 */
function saveShutdownData(note, workedOn, didntGetTo, highlightsText) {
  ensureSection(note, 'Highlights');

  var range = findSectionRange(note, 'Highlights', 2);
  if (!range) return;

  // Remove existing content in ## Highlights (keep the heading)
  var paras = note.paragraphs;
  for (var r = range.end - 1; r >= range.start; r--) {
    note.removeParagraphAtIndex(r);
  }

  // Re-read the heading line after removal
  var insertAt = findHeadingLine(note, 'Highlights', 2) + 1;

  // Build content lines
  var lines = [];

  // ### Worked on
  lines.push({ content: 'Worked on', type: 'title', level: 3 });
  for (var w = 0; w < workedOn.length; w++) {
    var timeStr = workedOn[w].minutes > 0 ? ' *(' + formatMinutes(workedOn[w].minutes) + ')*' : '';
    lines.push({ content: workedOn[w].content + timeStr, type: 'list' });
  }
  if (workedOn.length === 0) {
    lines.push({ content: 'Nothing tracked today', type: 'list' });
  }

  // Empty line before next section
  lines.push({ content: '', type: 'empty' });

  // ### Didn't get to
  lines.push({ content: "Didn't get to", type: 'title', level: 3 });
  for (var d = 0; d < didntGetTo.length; d++) {
    lines.push({ content: didntGetTo[d].content, type: 'list' });
  }
  if (didntGetTo.length === 0) {
    lines.push({ content: 'Everything done!', type: 'list' });
  }

  // Empty line before next section
  lines.push({ content: '', type: 'empty' });

  // ### Highlights
  lines.push({ content: 'Highlights', type: 'title', level: 3 });
  if (highlightsText && highlightsText.trim()) {
    var hLines = highlightsText.trim().split('\n');
    for (var h = 0; h < hLines.length; h++) {
      var hl = hLines[h].trim();
      if (hl) {
        // Strip leading "- " if user typed it
        if (hl.startsWith('- ')) hl = hl.substring(2);
        lines.push({ content: hl, type: 'list' });
      }
    }
  }

  // Trailing empty line after the whole section
  lines.push({ content: '', type: 'empty' });

  // Insert all lines
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    if (line.type === 'title') {
      note.insertHeading(line.content, insertAt, line.level);
    } else {
      note.insertParagraph(line.content, insertAt, line.type);
    }
    insertAt++;
  }
}

function buildShutdownTab(workedOn, didntGetTo, existingHighlights) {
  var html = '<div class="rf-shutdown">';

  html += '<div class="rf-shutdown-header">';
  html += '<h2 class="rf-panel-title"><i class="fa-solid fa-moon"></i> Daily Shutdown</h2>';
  html += '<p class="rf-text-muted">Review your day and capture your thoughts</p>';
  html += '</div>';

  // Worked on
  html += '<div class="rf-shutdown-section">';
  html += '<h3 class="rf-shutdown-section-title"><i class="fa-solid fa-check-circle"></i> Worked on</h3>';
  if (workedOn.length === 0) {
    html += '<p class="rf-empty">No focus sessions recorded today</p>';
  } else {
    html += '<div class="rf-shutdown-list">';
    for (var w = 0; w < workedOn.length; w++) {
      var wContent = renderTaskContent(workedOn[w].content);
      var wTime = workedOn[w].minutes > 0 ? '<span class="rf-shutdown-time">' + esc(formatMinutes(workedOn[w].minutes)) + '</span>' : '';
      html += '<div class="rf-shutdown-item done">';
      html += '<i class="fa-solid fa-check"></i>';
      html += '<span class="rf-shutdown-item-content">' + wContent + '</span>';
      html += wTime;
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Didn't get to
  html += '<div class="rf-shutdown-section">';
  html += '<h3 class="rf-shutdown-section-title"><i class="fa-solid fa-arrow-right"></i> Didn\'t get to</h3>';
  if (didntGetTo.length === 0) {
    html += '<p class="rf-shutdown-congrats"><i class="fa-solid fa-party-horn"></i> Everything done!</p>';
  } else {
    html += '<div class="rf-shutdown-list">';
    for (var d = 0; d < didntGetTo.length; d++) {
      var dContent = renderTaskContent(didntGetTo[d].content);
      html += '<div class="rf-shutdown-item missed">';
      html += '<i class="fa-regular fa-circle"></i>';
      html += '<span class="rf-shutdown-item-content">' + dContent + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Highlights textarea
  html += '<div class="rf-shutdown-section">';
  html += '<h3 class="rf-shutdown-section-title"><i class="fa-solid fa-pen-fancy"></i> Highlights</h3>';
  html += '<p class="rf-text-muted">What went well? What could be better? Any unplanned tasks?</p>';
  html += '<textarea class="rf-shutdown-textarea" id="shutdownHighlights" placeholder="- Great progress on the project\n- Got distracted by emails\n- Unplanned meeting took 1 hour">' + esc(existingHighlights) + '</textarea>';
  html += '</div>';

  // Save button
  html += '<div class="rf-shutdown-actions">';
  html += '<button class="rf-shutdown-save" data-action="saveShutdown"><i class="fa-solid fa-check"></i> Save Shutdown</button>';
  html += '</div>';

  html += '</div>';
  return html;
}

function buildHighlightEntryHTML(entry) {
  var html = '<div class="rf-hl-entry" data-date="' + esc(entry.date) + '">';
  html += '<div class="rf-hl-date">' + esc(formatHighlightDate(entry.date)) + '</div>';

  if (entry.workedOn.length > 0) {
    html += '<div class="rf-hl-section">';
    html += '<div class="rf-hl-section-label"><i class="fa-solid fa-mug-hot"></i> Worked on</div>';
    html += '<ul class="rf-hl-list">';
    for (var w = 0; w < entry.workedOn.length; w++) {
      html += '<li>' + renderTaskContent(entry.workedOn[w]) + '</li>';
    }
    html += '</ul></div>';
  }

  if (entry.didntGetTo.length > 0) {
    html += '<div class="rf-hl-section">';
    html += '<div class="rf-hl-section-label"><i class="fa-solid fa-circle-pause"></i> Didn\'t get to</div>';
    html += '<ul class="rf-hl-list">';
    for (var d = 0; d < entry.didntGetTo.length; d++) {
      html += '<li class="rf-text-muted">' + renderTaskContent(entry.didntGetTo[d]) + '</li>';
    }
    html += '</ul></div>';
  }

  if (entry.highlights.length > 0) {
    html += '<div class="rf-hl-section">';
    html += '<div class="rf-hl-section-label"><i class="fa-solid fa-pen-fancy"></i> Highlights</div>';
    html += '<ul class="rf-hl-list rf-hl-highlights">';
    for (var h = 0; h < entry.highlights.length; h++) {
      html += '<li>' + renderMarkdown(entry.highlights[h]) + '</li>';
    }
    html += '</ul></div>';
  }

  html += '</div>';
  return html;
}

function buildHighlightsTab(entries) {
  var html = '<div class="rf-highlights-feed" id="highlightsFeed">';
  html += '<h2 class="rf-section-title"><i class="fa-solid fa-pen-fancy"></i> Daily Highlights</h2>';

  if (entries.length === 0) {
    html += '<div class="rf-empty">No highlights yet. Complete a Shutdown session to record your first highlights.</div>';
  } else {
    for (var i = 0; i < entries.length; i++) {
      html += buildHighlightEntryHTML(entries[i]);
    }
    // Sentinel for infinite scroll
    html += '<div id="highlightsLoadMore" class="rf-hl-load-more" data-offset="' + entries.length + '">';
    html += '<span class="rf-text-muted">Scroll for more...</span>';
    html += '</div>';
  }

  html += '</div>';
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
      html += buildTodayTab(data.planTasks, data.focusMap || {}, data.timerState || {});
      break;
    case 'focus':
      html += buildFocusTab(data.planTasks, data.timerState, data.focusMap || {});
      break;
    case 'plan':
      html += buildPlanTab(data);
      break;
    case 'shutdown':
      html += buildShutdownTab(data.workedOn || [], data.didntGetTo || [], data.existingHighlights || '');
      break;
    case 'highlights':
      html += buildHighlightsTab(data.highlightsHistory || []);
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
    '  <script type="text/javascript" src="reflectEvents.js"><\/script>\n' +
    '  <script type="text/javascript" src="../np.Shared/pluginToHTMLCommsBridge.js"><\/script>\n' +
    '</body>\n</html>';
}

// ============================================
// INLINE CSS
// ============================================

function npColorToCSS(hex) {
  if (!hex || typeof hex !== 'string') return null;
  hex = hex.replace(/^#/, '');
  if (hex.length === 8) {
    var a = parseInt(hex.substring(0, 2), 16) / 255;
    var r = parseInt(hex.substring(2, 4), 16);
    var g = parseInt(hex.substring(4, 6), 16);
    var b = parseInt(hex.substring(6, 8), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a.toFixed(2) + ')';
  }
  if (hex.length === 6) return '#' + hex;
  return null;
}

function getThemePriorityColors() {
  var defaults = {
    pri3: { bg: 'rgba(255,85,85,0.67)', color: '#FFB5B5' },
    pri2: { bg: 'rgba(255,85,85,0.47)', color: '#FFCCCC' },
    pri1: { bg: 'rgba(255,85,85,0.27)', color: '#FFDBBE' },
  };
  try {
    if (typeof Editor === 'undefined' || !Editor.currentTheme || !Editor.currentTheme.values) return defaults;
    var styles = Editor.currentTheme.values.styles || {};
    var f1 = styles['flagged-1'], f2 = styles['flagged-2'], f3 = styles['flagged-3'];
    return {
      pri1: { bg: (f1 && f1.backgroundColor) ? npColorToCSS(f1.backgroundColor) || defaults.pri1.bg : defaults.pri1.bg, color: (f1 && f1.color) ? npColorToCSS(f1.color) || defaults.pri1.color : defaults.pri1.color },
      pri2: { bg: (f2 && f2.backgroundColor) ? npColorToCSS(f2.backgroundColor) || defaults.pri2.bg : defaults.pri2.bg, color: (f2 && f2.color) ? npColorToCSS(f2.color) || defaults.pri2.color : defaults.pri2.color },
      pri3: { bg: (f3 && f3.backgroundColor) ? npColorToCSS(f3.backgroundColor) || defaults.pri3.bg : defaults.pri3.bg, color: (f3 && f3.color) ? npColorToCSS(f3.color) || defaults.pri3.color : defaults.pri3.color },
    };
  } catch (e) { return defaults; }
}

function priCSSReflect() {
  var c = getThemePriorityColors();
  return '.rf-pri-3 { background: ' + c.pri3.bg + '; color: ' + c.pri3.color + '; }\n' +
         '.rf-pri-2 { background: ' + c.pri2.bg + '; color: ' + c.pri2.color + '; }\n' +
         '.rf-pri-1 { background: ' + c.pri1.bg + '; color: ' + c.pri1.color + '; }\n';
}

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

/* ---- Plan item priority & actions ---- */
'.rf-plan-pri {\n' +
'  cursor: pointer; display: inline-flex; align-items: center;\n' +
'  flex-shrink: 0; margin-right: 2px;\n' +
'}\n' +
'.rf-pri-none { color: var(--rf-text-faint); font-size: 11px; opacity: 0; transition: opacity 0.15s; }\n' +
'.rf-plan-item:hover .rf-pri-none { opacity: 0.5; }\n' +
'.rf-plan-actions {\n' +
'  display: flex; align-items: center; gap: 4px; flex-shrink: 0;\n' +
'}\n' +
'.rf-plan-act-btn {\n' +
'  background: none; border: none; color: var(--rf-text-faint);\n' +
'  cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px;\n' +
'  opacity: 0; transition: opacity 0.15s;\n' +
'}\n' +
'.rf-plan-item:hover .rf-plan-act-btn { opacity: 0.6; }\n' +
'.rf-plan-act-btn:hover { opacity: 1 !important; color: var(--rf-accent); }\n' +

/* ---- Drag indicators ---- */
'.rf-plan-item.is-dragging { opacity: 0.3; }\n' +
'.rf-plan-item.drag-over-top { border-top: 2px solid var(--rf-accent); margin-top: -2px; }\n' +
'.rf-plan-item.drag-over-bottom { border-bottom: 2px solid var(--rf-accent); margin-bottom: -2px; }\n' +

/* ---- Time Estimate ---- */
'.rf-time-btn {\n' +
'  flex-shrink: 0; border: none; background: transparent;\n' +
'  color: var(--rf-text-faint); cursor: pointer; padding: 2px 6px;\n' +
'  font-size: 11px; border-radius: 3px; transition: all 0.15s;\n' +
'  margin-left: auto; opacity: 0.5;\n' +
'}\n' +
'.rf-plan-item:hover .rf-time-btn { opacity: 1; }\n' +
'.rf-time-btn:hover { background: var(--rf-border); color: var(--rf-text); }\n' +
'.rf-time-label { font-weight: 600; color: var(--rf-accent); }\n' +
'.rf-time-badge {\n' +
'  flex-shrink: 0; font-size: 10px; font-weight: 600;\n' +
'  color: var(--rf-text-muted); margin-left: auto; padding: 2px 6px;\n' +
'}\n' +
'.rf-time-picker {\n' +
'  position: fixed; z-index: 200;\n' +
'  background: var(--rf-bg-card); border: 1px solid var(--rf-border-strong);\n' +
'  border-radius: var(--rf-radius-sm); box-shadow: 0 8px 24px color-mix(in srgb, black 30%, transparent);\n' +
'  padding: 6px 0; min-width: 120px; max-height: 300px; overflow-y: auto;\n' +
'}\n' +
'.rf-time-option {\n' +
'  display: block; width: 100%; padding: 6px 16px;\n' +
'  border: none; background: transparent; color: var(--rf-text);\n' +
'  font-size: 13px; cursor: pointer; text-align: left;\n' +
'}\n' +
'.rf-time-option:hover { background: var(--rf-accent-soft); color: var(--rf-accent); }\n' +
'.rf-time-option.active { color: var(--rf-accent); font-weight: 600; }\n' +
'.rf-time-option.clear { color: var(--rf-red); }\n' +

/* ---- Today Overview ---- */
'.rf-today-overview { padding: 0 16px; }\n' +
'.rf-today-overview .rf-panel-header { padding: 16px 0 12px; border-bottom: 1px solid var(--rf-border); }\n' +
'.rf-today-overview .rf-plan-list { padding: 8px 0; }\n' +

/* ---- Today Plan Items ---- */
'.rf-today-item {\n' +
'  display: flex; align-items: flex-start; gap: 8px;\n' +
'  padding: 10px 8px; border-radius: var(--rf-radius-sm);\n' +
'  transition: background 0.1s;\n' +
'}\n' +
'.rf-today-item:hover { background: var(--rf-border); }\n' +
'.rf-today-item.is-done { opacity: 0.5; }\n' +
'.rf-today-item.is-done .rf-plan-content { text-decoration: line-through; }\n' +
'.rf-today-item.is-focusing {\n' +
'  background: color-mix(in srgb, var(--rf-accent) 8%, transparent);\n' +
'  border-left: 3px solid var(--rf-accent); padding-left: 5px;\n' +
'}\n' +
'.rf-today-item-body { flex: 1; min-width: 0; }\n' +
'.rf-today-time-info {\n' +
'  display: flex; gap: 10px; margin-top: 4px; align-items: center;\n' +
'}\n' +
'.rf-time-est {\n' +
'  font-size: 11px; color: var(--rf-text-muted);\n' +
'}\n' +
'.rf-time-actual {\n' +
'  font-size: 11px; color: var(--rf-text-muted);\n' +
'}\n' +
'.rf-time-actual.on-track { color: var(--rf-green); }\n' +
'.rf-time-actual.over { color: var(--rf-red); }\n' +
'.rf-time-live {\n' +
'  font-size: 11px; color: var(--rf-accent); font-weight: 600;\n' +
'}\n' +
'.rf-pulse {\n' +
'  font-size: 6px; vertical-align: middle; margin-right: 3px;\n' +
'  animation: rf-pulse-anim 1.5s ease-in-out infinite;\n' +
'}\n' +
'@keyframes rf-pulse-anim {\n' +
'  0%, 100% { opacity: 1; }\n' +
'  50% { opacity: 0.3; }\n' +
'}\n' +
'.rf-today-item-actions {\n' +
'  display: flex; gap: 2px; flex-shrink: 0; opacity: 0;\n' +
'  transition: opacity 0.15s;\n' +
'}\n' +
'.rf-today-item:hover .rf-today-item-actions { opacity: 1; }\n' +
'.rf-today-item.is-focusing .rf-today-item-actions { opacity: 1; }\n' +
'.rf-today-act {\n' +
'  width: 26px; height: 26px; border-radius: var(--rf-radius-sm);\n' +
'  border: none; background: transparent; color: var(--rf-text-faint);\n' +
'  cursor: pointer; display: flex; align-items: center; justify-content: center;\n' +
'  font-size: 11px; transition: all 0.15s;\n' +
'}\n' +
'.rf-today-act:hover { background: var(--rf-border); color: var(--rf-text); }\n' +
'.rf-today-act.focusing { color: var(--rf-accent); }\n' +
'.rf-today-act.focusing:hover { background: var(--rf-red-soft); color: var(--rf-red); }\n' +

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

/* ---- Priority Badges ---- */
'.rf-pri {\n' +
'  display: inline-flex; align-items: center; justify-content: center;\n' +
'  padding: 0 5px; height: 16px; border-radius: 3px;\n' +
'  font-size: 9px; font-weight: 800; margin-right: 4px;\n' +
'  vertical-align: middle;\n' +
'}\n' +
priCSSReflect() +

/* ---- Source Tasks ---- */
'.rf-source-task {\n' +
'  display: flex; align-items: flex-start; gap: 8px;\n' +
'  padding: 8px; border-radius: var(--rf-radius-sm);\n' +
'  transition: background 0.1s;\n' +
'}\n' +
'.rf-source-task:hover { background: var(--rf-border); }\n' +
'.rf-source-task.in-plan { opacity: 0.5; }\n' +
'.rf-source-task-body { flex: 1; min-width: 0; }\n' +
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
'  max-width: 200px;\n' +
'}\n' +
'.rf-source-date i, .rf-source-meta i { margin-right: 3px; font-size: 9px; }\n' +
'.rf-source-group-header {\n' +
'  font-size: 11px; font-weight: 700; color: var(--rf-text-muted);\n' +
'  padding: 8px 8px 4px; text-transform: uppercase; letter-spacing: 0.04em;\n' +
'  border-bottom: 1px solid var(--rf-border); margin-bottom: 2px;\n' +
'}\n' +
'.rf-source-group-header:not(:first-child) { margin-top: 8px; }\n' +
'.rf-source-group-count {\n' +
'  font-weight: 400; color: var(--rf-text-faint); font-size: 10px;\n' +
'}\n' +
'.rf-source-date.overdue { color: var(--rf-red); }\n' +
'.rf-source-date.today { color: var(--rf-orange); }\n' +
'.rf-source-add {\n' +
'  flex-shrink: 0; width: 22px; height: 22px;\n' +
'  border-radius: 50%; border: 1px solid var(--rf-border-strong);\n' +
'  background: transparent; color: var(--rf-text-faint);\n' +
'  cursor: pointer; display: flex; align-items: center; justify-content: center;\n' +
'  font-size: 10px; transition: all 0.15s; margin-top: 2px;\n' +
'}\n' +
'.rf-source-task:hover .rf-source-add { color: var(--rf-accent); border-color: var(--rf-accent); }\n' +
'.rf-source-add:hover { background: var(--rf-accent-soft); color: var(--rf-accent); border-color: var(--rf-accent); }\n' +
'.rf-source-added {\n' +
'  flex-shrink: 0; width: 22px; height: 22px;\n' +
'  border-radius: 50%; display: flex; align-items: center; justify-content: center;\n' +
'  font-size: 10px; color: var(--rf-green); margin-top: 2px;\n' +
'}\n' +

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
'.rf-notes-editor {\n' +
'  width: 100%; border-radius: var(--rf-radius-sm); border: 1px solid var(--rf-border);\n' +
'  background: var(--rf-bg); overflow: hidden;\n' +
'}\n' +
'.rf-notes-toolbar {\n' +
'  display: flex; gap: 2px; padding: 4px 8px;\n' +
'  border-bottom: 1px solid var(--rf-border); background: var(--rf-bg-elevated);\n' +
'}\n' +
'.rf-notes-tb-btn {\n' +
'  background: none; border: none; color: var(--rf-text-muted);\n' +
'  width: 28px; height: 28px; border-radius: 4px;\n' +
'  cursor: pointer; font-size: 12px;\n' +
'  display: flex; align-items: center; justify-content: center;\n' +
'}\n' +
'.rf-notes-tb-btn:hover { background: var(--rf-border); color: var(--rf-text); }\n' +
'.rf-focus-notes {\n' +
'  width: 100%; min-height: 80px; padding: 12px;\n' +
'  background: var(--rf-bg); color: var(--rf-text);\n' +
'  font-family: inherit; font-size: 13px; line-height: 1.6;\n' +
'  outline: none; overflow-y: auto; max-height: 200px;\n' +
'}\n' +
'.rf-focus-notes:empty::before {\n' +
'  content: attr(data-placeholder); color: var(--rf-text-faint);\n' +
'  pointer-events: none;\n' +
'}\n' +
'.rf-focus-notes code {\n' +
'  background: var(--rf-border); padding: 1px 4px; border-radius: 3px;\n' +
'  font-family: "SF Mono", monospace; font-size: 12px;\n' +
'}\n' +
'.rf-focus-notes a { color: var(--rf-accent); text-decoration: underline; }\n' +
'.rf-focus-stats {\n' +
'  display: flex; gap: 20px; justify-content: center; flex-wrap: wrap;\n' +
'}\n' +
'.rf-focus-stat {\n' +
'  display: flex; flex-direction: column; align-items: center; gap: 2px;\n' +
'}\n' +
'.rf-focus-stat-label {\n' +
'  font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;\n' +
'  color: var(--rf-text-faint); font-weight: 600;\n' +
'}\n' +
'.rf-focus-stat-value {\n' +
'  font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums;\n' +
'  color: var(--rf-text);\n' +
'}\n' +
'.rf-focus-stat-value.over { color: var(--rf-red); }\n' +
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

/* ---- Shutdown Tab ---- */
'.rf-shutdown {\n' +
'  padding: 24px 20px 60px; max-width: 700px; margin: 0 auto;\n' +
'}\n' +
'.rf-shutdown-header {\n' +
'  margin-bottom: 24px;\n' +
'}\n' +
'.rf-shutdown-header h2 { display: flex; align-items: center; gap: 10px; }\n' +
'.rf-shutdown-header h2 i { color: var(--rf-accent); }\n' +
'.rf-shutdown-header p { margin-top: 4px; }\n' +
'.rf-shutdown-section {\n' +
'  margin-bottom: 24px;\n' +
'}\n' +
'.rf-shutdown-section-title {\n' +
'  font-size: 13px; font-weight: 700; color: var(--rf-text-muted);\n' +
'  text-transform: uppercase; letter-spacing: 0.5px;\n' +
'  display: flex; align-items: center; gap: 8px;\n' +
'  margin-bottom: 10px;\n' +
'}\n' +
'.rf-shutdown-section-title i { font-size: 14px; }\n' +
'.rf-shutdown-list {\n' +
'  display: flex; flex-direction: column; gap: 2px;\n' +
'}\n' +
'.rf-shutdown-item {\n' +
'  display: flex; align-items: flex-start; gap: 8px;\n' +
'  padding: 8px 10px; border-radius: var(--rf-radius-sm);\n' +
'}\n' +
'.rf-shutdown-item.done i { color: var(--rf-green); font-size: 13px; margin-top: 3px; }\n' +
'.rf-shutdown-item.missed i { color: var(--rf-text-faint); font-size: 13px; margin-top: 3px; }\n' +
'.rf-shutdown-item-content { flex: 1; min-width: 0; font-size: 14px; line-height: 1.5; }\n' +
'.rf-shutdown-time {\n' +
'  flex-shrink: 0; font-size: 12px; color: var(--rf-text-muted);\n' +
'  font-weight: 600; margin-top: 2px;\n' +
'}\n' +
'.rf-shutdown-congrats {\n' +
'  color: var(--rf-green); font-size: 14px; font-weight: 600;\n' +
'  display: flex; align-items: center; gap: 8px; padding: 8px 0;\n' +
'}\n' +
'.rf-shutdown-textarea {\n' +
'  width: 100%; min-height: 120px; padding: 12px;\n' +
'  border-radius: var(--rf-radius-sm); border: 1px solid var(--rf-border);\n' +
'  background: var(--rf-bg); color: var(--rf-text);\n' +
'  font-family: inherit; font-size: 14px; line-height: 1.6; resize: vertical;\n' +
'}\n' +
'.rf-shutdown-textarea::placeholder { color: var(--rf-text-faint); }\n' +
'.rf-shutdown-actions {\n' +
'  display: flex; justify-content: center; padding-top: 8px;\n' +
'}\n' +
'.rf-shutdown-save {\n' +
'  padding: 12px 32px; border-radius: var(--rf-radius-sm);\n' +
'  border: none; background: var(--rf-accent); color: white;\n' +
'  font-size: 14px; font-weight: 600; cursor: pointer;\n' +
'  display: flex; align-items: center; gap: 8px;\n' +
'  transition: all 0.15s;\n' +
'}\n' +
'.rf-shutdown-save:hover { filter: brightness(1.1); }\n' +

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
'.rf-cal-badge {\n' +
'  display: inline-flex; align-items: center; gap: 5px;\n' +
'  padding: 2px 8px; border-radius: 4px;\n' +
'  background: color-mix(in srgb, var(--cal-color, #5A9FD4) 15%, transparent);\n' +
'  border-left: 3px solid var(--cal-color, #5A9FD4);\n' +
'  color: var(--rf-text); font-weight: 500;\n' +
'}\n' +
'.rf-cal-badge i { color: var(--cal-color, #5A9FD4); font-size: 12px; }\n' +
'.rf-cal-time {\n' +
'  font-size: 11px; color: var(--rf-text-muted); font-weight: 400;\n' +
'}\n' +

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

/* ---- Highlights Feed ---- */
'.rf-highlights-feed {\n' +
'  max-width: 700px; margin: 0 auto; padding: 20px;\n' +
'}\n' +
'.rf-hl-entry {\n' +
'  margin-bottom: 24px; padding: 16px 20px;\n' +
'  background: var(--rf-bg-elevated); border-radius: var(--rf-radius-sm);\n' +
'  border: 1px solid var(--rf-border);\n' +
'}\n' +
'.rf-hl-date {\n' +
'  font-size: 15px; font-weight: 700; color: var(--rf-accent);\n' +
'  margin-bottom: 12px; padding-bottom: 8px;\n' +
'  border-bottom: 1px solid var(--rf-border);\n' +
'}\n' +
'.rf-hl-section { margin-bottom: 12px; }\n' +
'.rf-hl-section:last-child { margin-bottom: 0; }\n' +
'.rf-hl-section-label {\n' +
'  font-size: 11px; font-weight: 700; color: var(--rf-text-muted);\n' +
'  text-transform: uppercase; letter-spacing: 0.05em;\n' +
'  margin-bottom: 6px; display: flex; align-items: center; gap: 6px;\n' +
'}\n' +
'.rf-hl-list {\n' +
'  list-style: none; margin: 0; padding: 0;\n' +
'}\n' +
'.rf-hl-list li {\n' +
'  font-size: 14px; line-height: 1.6; padding: 2px 0 2px 16px;\n' +
'  position: relative; color: var(--rf-text);\n' +
'}\n' +
'.rf-hl-list li::before {\n' +
'  content: ""; position: absolute; left: 0; top: 10px;\n' +
'  width: 5px; height: 5px; border-radius: 50%;\n' +
'  background: var(--rf-text-faint);\n' +
'}\n' +
'.rf-hl-list.rf-hl-highlights li::before { background: var(--rf-accent); }\n' +
'.rf-hl-load-more {\n' +
'  text-align: center; padding: 16px; font-size: 13px;\n' +
'}\n' +
'.rf-hl-load-more.exhausted { display: none; }\n' +

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
      calendarEvents: [],
      hasClickUp: Boolean(config.clickupApiToken && config.clickupTeamId),
      timerState: config.timerState,
      focusMap: {},
    };

    if (note) {
      data.planTasks = getPlanTasks(note);
      if (activeTab === 'today' || activeTab === 'focus' || activeTab === 'shutdown') {
        data.focusMap = getFocusedTimeMap(note);
      }
      if (activeTab === 'shutdown') {
        data.workedOn = getWorkedOnTasks(data.focusMap, data.planTasks);
        data.didntGetTo = getDidntGetToTasks(data.focusMap, data.planTasks);
        data.existingHighlights = getExistingHighlightsText(note);
      }
      if (activeTab === 'plan') {
        var cached = await getCachedTasks(note, config);
        data.calendarEvents = cached.calendarEvents;
        data.dailyTasks = cached.dailyTasks;
        data.scheduledToday = cached.scheduledToday;
        data.scheduledWeek = cached.scheduledWeek;
      }
      // today and focus tabs only need planTasks (already loaded)
    }
    if (activeTab === 'highlights') {
      data.highlightsHistory = getHighlightsHistory(5, 0);
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
  invalidateTaskCache();
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

      case 'addCalendarToPlan':
      case 'addToPlan':
      case 'addToPlanWithDuration':
        if (note) {
          // Build the plan content from the message
          var planContent = '';
          if (actionType === 'addCalendarToPlan' && msg.calendarLink) {
            planContent = msg.calendarLink;
          } else if (msg.content) {
            planContent = msg.content;
            if (msg.clickupId) {
              planContent += ' [ClickUp](https://app.clickup.com/t/' + msg.clickupId + ')';
            }
          }
          if (!planContent) break;
          if (msg.durationStr) {
            planContent += ' *- ' + msg.durationStr + '*';
          }

          addToPlan(note, planContent);
          invalidateTaskCache();

          // Read back the new task
          var updatedPlan = getPlanTasks(note);
          var newTask = updatedPlan[updatedPlan.length - 1];
          var remaining = updatedPlan.filter(function(t) { return !t.isComplete; }).length;

          // Render without time estimate (it's shown separately in the time button)
          var parsedContent = extractTimeEstimate(planContent);
          var contentHTML = renderTaskContent(parsedContent.content);

          await sendToHTMLWindow(WINDOW_ID, 'TASK_ADDED_TO_PLAN', {
            content: planContent,
            contentHTML: contentHTML,
            lineIndex: newTask ? newTask.lineIndex : -1,
            originalContent: msg.content || '',
            remaining: remaining,
            durationStr: msg.durationStr || parsedContent.estimate || '',
          });
        }
        break;

      case 'reorderPlan':
        if (note && msg.orderedLineIndices) {
          reorderPlanTasks(note, msg.orderedLineIndices);
          invalidateTaskCache();
          // Send back updated line indices — DOM is already in correct order
          var reorderedPlan = getPlanTasks(note);
          var newIndices = reorderedPlan.map(function(t) { return t.lineIndex; });
          await sendToHTMLWindow(WINDOW_ID, 'PLAN_REORDERED', { lineIndices: newIndices });
        }
        break;

      case 'togglePlanTask':
        if (note && msg.lineIndex !== undefined) {
          togglePlanTask(note, parseInt(msg.lineIndex, 10));
          invalidateTaskCache();
          var config = getSettings();
          await showReflect(config.lastTab || 'today');
        }
        break;

      case 'setTimeEstimate':
        if (note && msg.lineIndex !== undefined) {
          setTimeEstimate(note, parseInt(msg.lineIndex, 10), msg.estimate || '');
          // Send back updated estimate without full re-render
          await sendToHTMLWindow(WINDOW_ID, 'TIME_ESTIMATE_SET', {
            lineIndex: parseInt(msg.lineIndex, 10),
            estimate: msg.estimate || '',
          });
        }
        break;

      case 'startFocus':
        if (note && msg.taskContent) {
          startFocusSession(note, msg.taskContent);
          await showReflect('focus');
        }
        break;

      case 'startFocusFromToday':
        if (note && msg.taskContent) {
          startFocusSession(note, msg.taskContent);
          await showReflect('today');
        }
        break;

      case 'stopFocusFromToday':
        if (note) {
          stopFocusSession(note, '');
          invalidateTaskCache();
          await showReflect('today');
        }
        break;

      case 'stopFocus':
        if (note) {
          stopFocusSession(note, msg.notes || '');
          await showReflect('focus');
        }
        break;

      case 'movePlanUp':
      case 'movePlanDown':
        if (note && msg.lineIndex !== undefined) {
          var planItems = getPlanTasks(note);
          var targetIdx = parseInt(msg.lineIndex, 10);
          var currentPos = -1;
          for (var mi = 0; mi < planItems.length; mi++) {
            if (planItems[mi].lineIndex === targetIdx) { currentPos = mi; break; }
          }
          if (currentPos >= 0) {
            var swapPos = actionType === 'movePlanUp' ? currentPos - 1 : currentPos + 1;
            if (swapPos >= 0 && swapPos < planItems.length) {
              // Build new order with the two items swapped
              var newOrder = planItems.map(function(p) { return p.lineIndex; });
              var tmp = newOrder[currentPos];
              newOrder[currentPos] = newOrder[swapPos];
              newOrder[swapPos] = tmp;
              reorderPlanTasks(note, newOrder);
              invalidateTaskCache();
              await showReflect('today');
            }
          }
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

      case 'cyclePlanPriority':
        if (note) {
          var priLineIdx = parseInt(msg.lineIndex);
          var priParas = note.paragraphs;
          if (priLineIdx >= 0 && priLineIdx < priParas.length) {
            var priPara = priParas[priLineIdx];
            var priContent = priPara.content || '';
            var priParsed = extractPriority(priContent);
            // Cycle: 0 → 1 → 2 → 3 → 0
            var newLevel = (priParsed.level + 1) % 4;
            var prefix = newLevel === 3 ? '!!! ' : newLevel === 2 ? '!! ' : newLevel === 1 ? '! ' : '';
            priPara.content = prefix + priParsed.content;
            note.updateParagraph(priPara);
            // Send update to HTML
            var newBadgeHTML = newLevel > 0 ? renderPriorityBadge(newLevel) : '<i class="fa-solid fa-flag rf-pri-none"></i>';
            await sendToHTMLWindow(WINDOW_ID, 'PLAN_PRIORITY_CHANGED', {
              lineIndex: priLineIdx,
              level: newLevel,
              badgeHTML: newBadgeHTML,
            });
          }
        }
        break;

      case 'openDailyNote':
        if (note) {
          await CommandBar.onMainThread();
          var todayDateStr = getTodayStr();
          Editor.openNoteByDateString(todayDateStr);
        }
        break;

      case 'saveShutdown':
        if (note) {
          var focusMapForShutdown = getFocusedTimeMap(note);
          var planTasksForShutdown = getPlanTasks(note);
          var workedOn = getWorkedOnTasks(focusMapForShutdown, planTasksForShutdown);
          var didntGetTo = getDidntGetToTasks(focusMapForShutdown, planTasksForShutdown);
          saveShutdownData(note, workedOn, didntGetTo, msg.highlights || '');
          await sendToHTMLWindow(WINDOW_ID, 'SHOW_TOAST', { message: 'Shutdown saved' });
        }
        break;

      case 'loadMoreHighlights':
        var moreOffset = parseInt(msg.offset) || 0;
        var moreEntries = getHighlightsHistory(5, moreOffset);
        // Send raw text content — DOM construction handles display
        var renderedEntries = [];
        for (var me = 0; me < moreEntries.length; me++) {
          var entry = moreEntries[me];
          renderedEntries.push({
            date: entry.date,
            dateFormatted: formatHighlightDate(entry.date),
            workedOn: entry.workedOn,
            didntGetTo: entry.didntGetTo,
            highlights: entry.highlights,
          });
        }
        await sendToHTMLWindow(WINDOW_ID, 'HIGHLIGHTS_LOADED', {
          entries: renderedEntries,
          count: moreEntries.length,
          newOffset: moreOffset + moreEntries.length,
        });
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
