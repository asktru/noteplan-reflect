// asktru.Reflect — reflectEvents.js
// HTML-side event handlers for the Reflect dashboard

/* global sendMessageToPlugin */

// ============================================
// STATE
// ============================================

var currentTab = 'today';
var timerInterval = null;
var timerStartTime = null;
var dragSrcEl = null;

// ============================================
// PLUGIN MESSAGE HANDLER
// ============================================

function onMessageFromPlugin(type, data) {
  switch (type) {
    case 'CLICKUP_TASKS':
      renderClickUpTasks(data.tasks || []);
      break;
    case 'TASK_ADDED_TO_PLAN':
      handleTaskAddedToPlan(data);
      break;
    case 'PLAN_REORDERED':
      handlePlanReordered(data);
      break;
    case 'TIME_ESTIMATE_SET':
      handleTimeEstimateSet(data);
      break;
    case 'PLAN_PRIORITY_CHANGED':
      handlePlanPriorityChanged(data);
      break;
    case 'SHOW_TOAST':
      showToast(data.message);
      break;
    case 'HIGHLIGHTS_LOADED':
      handleHighlightsLoaded(data);
      break;
    case 'FULL_REFRESH':
      window.location.reload();
      break;
  }
}

function handleTaskAddedToPlan(data) {
  try {
  // 1. Add new item to plan list
  var planList = document.getElementById('planList');
  if (planList) {
    // Remove empty state if present
    var empty = planList.querySelector('.rf-empty');
    if (empty) empty.remove();

    var item = document.createElement('div');
    item.className = 'rf-plan-item';
    item.draggable = true;
    item.dataset.lineIndex = data.lineIndex;
    item.dataset.index = planList.querySelectorAll('.rf-plan-item').length;

    var handle = document.createElement('span');
    handle.className = 'rf-drag-handle';
    var handleIcon = document.createElement('i');
    handleIcon.className = 'fa-solid fa-grip-vertical';
    handle.appendChild(handleIcon);

    var cb = document.createElement('span');
    cb.className = 'rf-plan-cb checklist';
    cb.dataset.action = 'togglePlan';
    cb.dataset.lineIndex = data.lineIndex;
    var cbIcon = document.createElement('i');
    cbIcon.className = 'fa-regular fa-square';
    cb.appendChild(cbIcon);

    var content = document.createElement('span');
    content.className = 'rf-plan-content';
    // Use textContent as fallback, innerHTML for rich content
    if (data.contentHTML && data.contentHTML.indexOf('<') >= 0) {
      content.innerHTML = data.contentHTML;
    } else {
      content.textContent = data.originalContent || '';
    }

    var timeBtn = document.createElement('button');
    timeBtn.className = 'rf-time-btn';
    timeBtn.dataset.action = 'showTimePicker';
    timeBtn.dataset.lineIndex = data.lineIndex;
    timeBtn.title = 'Set time estimate';
    if (data.durationStr) {
      var timeLabel = document.createElement('span');
      timeLabel.className = 'rf-time-label';
      timeLabel.textContent = data.durationStr;
      timeBtn.appendChild(timeLabel);
    } else {
      var clockIcon = document.createElement('i');
      clockIcon.className = 'fa-regular fa-clock';
      timeBtn.appendChild(clockIcon);
    }

    item.appendChild(handle);
    item.appendChild(cb);
    item.appendChild(content);
    item.appendChild(timeBtn);
    planList.appendChild(item);

    // Attach drag events to new item
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragenter', handleDragEnter);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragend', handleDragEnd);
  }

  // 2. Update remaining count + total time
  updatePlanTotal();

  // 3. Mark source task as in-plan
  var sourceTasks = document.querySelectorAll('.rf-source-task');
  var matched = 0;
  sourceTasks.forEach(function(el) {
    if (el.dataset.content === data.originalContent) {
      matched++;
      el.classList.add('in-plan');
      // Replace + button with checkmark
      var addBtn = el.querySelector('.rf-source-add');
      if (addBtn) {
        var check = document.createElement('span');
        check.className = 'rf-source-added';
        check.innerHTML = '<i class="fa-solid fa-check"></i>';
        addBtn.replaceWith(check);
      }
    }
  });

  showToast('Added to plan');
  } catch (err) {
    console.log('handleTaskAddedToPlan ERROR: ' + err + ' stack=' + (err.stack || ''));
  }
}

function handlePlanReordered(data) {
  // Update data-line-index on each plan item to match new note state
  var items = document.querySelectorAll('#planList .rf-plan-item');
  var indices = data.lineIndices || [];
  for (var i = 0; i < items.length && i < indices.length; i++) {
    items[i].dataset.lineIndex = indices[i];
    // Also update the checkbox's data-line-index
    var cb = items[i].querySelector('.rf-plan-cb');
    if (cb) cb.dataset.lineIndex = indices[i];
  }
}

function handlePlanPriorityChanged(data) {
  // Find all plan items with this line index (could appear on Today and Plan tabs)
  var items = document.querySelectorAll('.rf-plan-item[data-line-index="' + data.lineIndex + '"], .rf-today-item[data-line-index="' + data.lineIndex + '"]');
  for (var i = 0; i < items.length; i++) {
    var priEl = items[i].querySelector('.rf-plan-pri');
    if (!priEl) continue;
    priEl.dataset.level = data.level;

    // Clear existing content and rebuild via DOM
    while (priEl.firstChild) priEl.removeChild(priEl.firstChild);

    if (data.level > 0) {
      var labels = { 1: '!', 2: '!!', 3: '!!!' };
      var classes = { 1: 'rf-pri-1', 2: 'rf-pri-2', 3: 'rf-pri-3' };
      var badge = document.createElement('span');
      badge.className = 'rf-pri ' + classes[data.level];
      badge.textContent = labels[data.level];
      priEl.appendChild(badge);
    } else {
      var flag = document.createElement('i');
      flag.className = 'fa-solid fa-flag rf-pri-none';
      priEl.appendChild(flag);
    }
  }
}

function handleTimeEstimateSet(data) {
  var item = document.querySelector('.rf-plan-item[data-line-index="' + data.lineIndex + '"]');
  if (!item) return;
  var btn = item.querySelector('.rf-time-btn');
  if (btn) {
    // Clear existing content using DOM methods (innerHTML fails in NotePlan WebView)
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    if (data.estimate) {
      var label = document.createElement('span');
      label.className = 'rf-time-label';
      label.textContent = data.estimate;
      btn.appendChild(label);
    } else {
      var icon = document.createElement('i');
      icon.className = 'fa-regular fa-clock';
      btn.appendChild(icon);
    }
  }
  // Update total in header
  updatePlanTotal();
}

function updatePlanTotal() {
  var items = document.querySelectorAll('#planList .rf-plan-item:not(.is-done)');
  var totalMin = 0;
  items.forEach(function(el) {
    var label = el.querySelector('.rf-time-label');
    if (label) {
      var text = label.textContent;
      var hm = text.match(/(\d+(?:\.\d+)?)h/);
      var mm = text.match(/(\d+)m/);
      if (hm) totalMin += parseFloat(hm[1]) * 60;
      if (mm) totalMin += parseInt(mm[1], 10);
    }
  });
  var countEl = document.querySelector('.rf-plan-count');
  if (countEl) {
    var remaining = document.querySelectorAll('#planList .rf-plan-item:not(.is-done)').length;
    var totalStr = '';
    if (totalMin > 0) {
      var hrs = Math.floor(totalMin / 60);
      var mins = totalMin % 60;
      totalStr = hrs > 0 ? (hrs + 'h' + (mins > 0 ? ' ' + mins + 'm' : '')) : (mins + 'm');
    }
    countEl.textContent = remaining + ' remaining' + (totalStr ? ' \u00B7 ' + totalStr : '');
  }
}

// ============================================
// TIME PICKER
// ============================================

var TIME_OPTIONS = [
  '5m', '10m', '15m', '25m', '30m', '45m',
  '1h', '1.5h', '2h', '2.5h', '3h', '4h', '5h', '6h', '7h', '8h'
];

function showTimePicker(btn) {
  closeTimePicker();
  var lineIndex = btn.dataset.lineIndex;
  var currentLabel = btn.querySelector('.rf-time-label');
  var currentValue = currentLabel ? currentLabel.textContent : '';

  var picker = document.createElement('div');
  picker.className = 'rf-time-picker';
  picker.id = 'rfTimePicker';

  for (var i = 0; i < TIME_OPTIONS.length; i++) {
    var opt = document.createElement('button');
    opt.className = 'rf-time-option' + (TIME_OPTIONS[i] === currentValue ? ' active' : '');
    opt.textContent = TIME_OPTIONS[i];
    opt.dataset.estimate = TIME_OPTIONS[i];
    opt.dataset.lineIndex = lineIndex;
    opt.dataset.action = 'pickTime';
    picker.appendChild(opt);
  }

  // Clear option
  var clearOpt = document.createElement('button');
  clearOpt.className = 'rf-time-option clear';
  clearOpt.textContent = 'Clear';
  clearOpt.dataset.estimate = '';
  clearOpt.dataset.lineIndex = lineIndex;
  clearOpt.dataset.action = 'pickTime';
  picker.appendChild(clearOpt);

  // Position near the button
  var rect = btn.getBoundingClientRect();
  picker.style.top = rect.bottom + 4 + 'px';
  picker.style.right = (window.innerWidth - rect.right) + 'px';

  document.body.appendChild(picker);

  // Close on outside click
  setTimeout(function() {
    document.addEventListener('click', closeTimePickerOnOutside);
  }, 0);
}

function closeTimePicker() {
  var existing = document.getElementById('rfTimePicker');
  if (existing) existing.remove();
  document.removeEventListener('click', closeTimePickerOnOutside);
}

function closeTimePickerOnOutside(e) {
  var picker = document.getElementById('rfTimePicker');
  if (picker && !picker.contains(e.target) && !e.target.closest('[data-action="showTimePicker"]')) {
    closeTimePicker();
  }
}

function handlePickTime(el) {
  var lineIndex = el.dataset.lineIndex;
  var estimate = el.dataset.estimate;
  closeTimePicker();
  sendMessageToPlugin('setTimeEstimate', JSON.stringify({ lineIndex: lineIndex, estimate: estimate }));
}

// ============================================
// TAB NAVIGATION
// ============================================

function handleTabClick(tabEl) {
  var tab = tabEl.dataset.tab;
  if (!tab || tab === currentTab) return;
  sendMessageToPlugin('switchTab', JSON.stringify({ tab: tab }));
}

// ============================================
// MOBILE NAV TOGGLE
// ============================================

function toggleNav() {
  var nav = document.querySelector('.rf-nav');
  var backdrop = document.querySelector('.rf-nav-backdrop');
  if (nav) nav.classList.toggle('open');
  if (backdrop) backdrop.classList.toggle('open');
}

// ============================================
// SOURCE TAB SWITCHING
// ============================================

function handleSourceTabClick(tabEl) {
  var source = tabEl.dataset.source;
  if (!source) return;

  // Update tab active state
  var tabs = document.querySelectorAll('.rf-source-tab');
  tabs.forEach(function(t) { t.classList.remove('active'); });
  tabEl.classList.add('active');

  // Show corresponding source list
  var lists = document.querySelectorAll('.rf-source-list');
  lists.forEach(function(l) { l.classList.remove('active'); });
  var targetList = document.querySelector('.rf-source-list[data-source="' + source + '"]');
  if (targetList) targetList.classList.add('active');

  // Lazy-load ClickUp
  if (source === 'clickup') {
    var loading = targetList && targetList.querySelector('.rf-clickup-loading');
    if (loading) {
      sendMessageToPlugin('fetchClickUp', JSON.stringify({}));
    }
  }
}

// Render ClickUp tasks using DOM manipulation (no innerHTML for safety).
// The task data comes from our own plugin (trusted source via ClickUp API),
// not from user-generated or web-sourced content.
function renderClickUpTasks(tasks) {
  var list = document.querySelector('.rf-source-list[data-source="clickup"]');
  if (!list) return;

  // Clear existing content
  while (list.firstChild) list.removeChild(list.firstChild);

  if (tasks.length === 0) {
    var emptyDiv = document.createElement('div');
    emptyDiv.className = 'rf-empty';
    emptyDiv.textContent = 'No ClickUp tasks found';
    list.appendChild(emptyDiv);
    return;
  }

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var taskEl = document.createElement('div');
    taskEl.className = 'rf-source-task';
    taskEl.dataset.content = t.content || '';
    if (t.clickupId) taskEl.dataset.clickupId = t.clickupId;

    var mainDiv = document.createElement('div');
    mainDiv.className = 'rf-source-task-main';
    var contentSpan = document.createElement('span');
    contentSpan.className = 'rf-source-task-content';
    contentSpan.textContent = t.content || '';
    mainDiv.appendChild(contentSpan);
    taskEl.appendChild(mainDiv);

    var metaDiv = document.createElement('div');
    metaDiv.className = 'rf-source-task-meta';
    if (t.dueDate) {
      var dateSpan = document.createElement('span');
      dateSpan.className = 'rf-source-date';
      dateSpan.textContent = t.dueDate;
      metaDiv.appendChild(dateSpan);
    }
    if (t.status) {
      var statusSpan = document.createElement('span');
      statusSpan.className = 'rf-source-meta';
      statusSpan.textContent = t.status;
      metaDiv.appendChild(statusSpan);
    }
    if (metaDiv.childNodes.length > 0) taskEl.appendChild(metaDiv);

    var addBtn = document.createElement('button');
    addBtn.className = 'rf-source-add';
    addBtn.dataset.action = 'addToPlan';
    addBtn.dataset.content = t.content || '';
    if (t.clickupId) addBtn.dataset.clickupId = t.clickupId;
    addBtn.title = 'Add to plan (S)';
    var addIcon = document.createElement('i');
    addIcon.className = 'fa-solid fa-plus';
    addBtn.appendChild(addIcon);
    taskEl.appendChild(addBtn);

    list.appendChild(taskEl);
  }
}

// ============================================
// ADD TO PLAN
// ============================================

function handleAddCalendarToPlan(el) {
  var content = el.dataset.content || '';
  var duration = el.dataset.duration || '';
  var calendarLink = el.dataset.calendarLink || '';
  // Always try the parent source-task for complete data
  var task = el.closest('.rf-source-task');
  if (task) {
    if (!content) content = task.dataset.content || '';
    if (!duration) duration = task.dataset.duration || '';
    if (!calendarLink) calendarLink = task.dataset.calendarLink || '';
  }
  if (calendarLink) {
    sendMessageToPlugin('addCalendarToPlan', JSON.stringify({ content: content, durationStr: duration, calendarLink: calendarLink }));
  }
}

function handleAddToPlanWithDuration(el) {
  var content = el.dataset.content || '';
  var duration = el.dataset.duration || '';
  if (!content) {
    var task = el.closest('.rf-source-task');
    if (task) {
      content = task.dataset.content || '';
      duration = task.dataset.duration || '';
    }
  }
  if (content) {
    sendMessageToPlugin('addToPlanWithDuration', JSON.stringify({ content: content, durationStr: duration }));
  }
}

function handleAddToPlan(el) {
  var content = el.dataset.content;
  var clickupId = el.dataset.clickupId || '';
  if (!content) {
    var task = el.closest('.rf-source-task');
    if (task) {
      content = task.dataset.content;
      clickupId = task.dataset.clickupId || '';
    }
  }
  if (content) {
    sendMessageToPlugin('addToPlan', JSON.stringify({ content: content, clickupId: clickupId }));
  }
}

// ============================================
// KEYBOARD SHORTCUT — "S" to add hovered task
// ============================================

function handleKeyboardShortcut(e) {
  if (e.key !== 's' && e.key !== 'S') return;
  // Don't trigger if typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  var hoveredTask = document.querySelector('.rf-source-task:hover');
  if (hoveredTask) {
    e.preventDefault();
    var content = hoveredTask.dataset.content;
    var clickupId = hoveredTask.dataset.clickupId || '';
    var duration = hoveredTask.dataset.duration || '';
    var calendarLink = hoveredTask.dataset.calendarLink || '';
    if (content) {
      if (calendarLink) {
        sendMessageToPlugin('addCalendarToPlan', JSON.stringify({ content: content, durationStr: duration, calendarLink: calendarLink }));
      } else if (clickupId) {
        sendMessageToPlugin('addToPlan', JSON.stringify({ content: content, clickupId: clickupId }));
      } else if (duration) {
        sendMessageToPlugin('addToPlanWithDuration', JSON.stringify({ content: content, durationStr: duration }));
      } else {
        sendMessageToPlugin('addToPlan', JSON.stringify({ content: content }));
      }
      showToast('Added to plan');
    }
  }
}

// ============================================
// PLAN ITEM TOGGLE
// ============================================

function handlePlanToggle(el) {
  var lineIndex = el.dataset.lineIndex;
  if (lineIndex !== undefined) {
    sendMessageToPlugin('togglePlanTask', JSON.stringify({ lineIndex: lineIndex }));
  }
}

// ============================================
// PLAN DRAG AND DROP
// ============================================

function initPlanDragAndDrop() {
  var items = document.querySelectorAll('.rf-plan-item');
  items.forEach(function(item) {
    item.addEventListener('dragstart', handleDragStart);
    item.addEventListener('dragover', handleDragOver);
    item.addEventListener('dragenter', handleDragEnter);
    item.addEventListener('dragleave', handleDragLeave);
    item.addEventListener('drop', handleDrop);
    item.addEventListener('dragend', handleDragEnd);
  });
}

function handleDragStart(e) {
  dragSrcEl = this;
  this.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.lineIndex);
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  var rect = this.getBoundingClientRect();
  var midY = rect.top + rect.height / 2;
  this.classList.remove('drag-over-top', 'drag-over-bottom');
  if (e.clientY < midY) {
    this.classList.add('drag-over-top');
  } else {
    this.classList.add('drag-over-bottom');
  }
}

function handleDragEnter(e) {
  e.preventDefault();
}

function handleDragLeave() {
  this.classList.remove('drag-over-top', 'drag-over-bottom');
}

function handleDrop(e) {
  e.stopPropagation();
  e.preventDefault();

  if (dragSrcEl === this) return;

  var parent = this.parentNode;
  var isTop = this.classList.contains('drag-over-top');

  this.classList.remove('drag-over-top', 'drag-over-bottom');

  if (isTop) {
    parent.insertBefore(dragSrcEl, this);
  } else {
    parent.insertBefore(dragSrcEl, this.nextSibling);
  }

  // Collect new order
  var items = parent.querySelectorAll('.rf-plan-item');
  var orderedLineIndices = [];
  items.forEach(function(item) {
    orderedLineIndices.push(parseInt(item.dataset.lineIndex, 10));
  });

  sendMessageToPlugin('reorderPlan', JSON.stringify({ orderedLineIndices: orderedLineIndices }));
}

function handleDragEnd() {
  this.classList.remove('is-dragging');
  var items = document.querySelectorAll('.rf-plan-item');
  items.forEach(function(item) {
    item.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  dragSrcEl = null;
}

// ============================================
// FOCUS TIMER
// ============================================

function startTimerUI(startTime) {
  timerStartTime = startTime;
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopTimerUI() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerStartTime = null;
  var el = document.getElementById('focusTimer');
  if (el) el.textContent = '00:00';
}

function fmtMins(m) {
  if (m <= 0) return '0m';
  var h = Math.floor(m / 60);
  var r = Math.round(m % 60);
  if (h > 0) return h + 'h' + (r > 0 ? ' ' + r + 'm' : '');
  return r + 'm';
}

function updateTimerDisplay() {
  if (!timerStartTime) return;
  var elapsed = Date.now() - timerStartTime;
  var totalSec = Math.floor(elapsed / 1000);
  var sessionMin = totalSec / 60;
  var mins = Math.floor(totalSec / 60);
  var secs = totalSec % 60;
  var display = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  var el = document.getElementById('focusTimer');
  if (el) el.textContent = display;

  // Update focus stats if present
  var card = document.querySelector('.rf-focus-card');
  if (!card) return;
  var trackedMin = parseFloat(card.dataset.trackedMin || '0');
  var estimateMin = parseFloat(card.dataset.estimateMin || '0');

  var statSession = document.getElementById('statSession');
  if (statSession) statSession.textContent = fmtMins(sessionMin);

  var statTotal = document.getElementById('statTotal');
  if (statTotal) statTotal.textContent = fmtMins(trackedMin + sessionMin);

  var statRemaining = document.getElementById('statRemaining');
  if (statRemaining) {
    var remain = estimateMin - trackedMin - sessionMin;
    statRemaining.textContent = remain > 0 ? fmtMins(remain) : '0m';
    if (remain <= 0) {
      statRemaining.className = 'rf-focus-stat-value over';
    }
  }
}

function handleStartFocus(el) {
  var content = el.dataset.content;
  if (content) {
    sendMessageToPlugin('startFocus', JSON.stringify({ taskContent: content }));
  }
}

/**
 * Extract markdown text from the contenteditable focus notes editor.
 * Converts HTML back to markdown: <strong> → **, <em> → *, <code> → `, <a> → [text](url)
 */
function extractNotesMarkdown() {
  var notesEl = document.getElementById('focusNotes');
  if (!notesEl) return '';

  // Walk child nodes to convert HTML to markdown
  function nodeToMd(node) {
    if (node.nodeType === 3) return node.textContent; // text node
    if (node.nodeType !== 1) return '';

    var tag = node.tagName.toLowerCase();
    var inner = '';
    for (var i = 0; i < node.childNodes.length; i++) {
      inner += nodeToMd(node.childNodes[i]);
    }

    switch (tag) {
      case 'strong': case 'b': return '**' + inner + '**';
      case 'em': case 'i': return '*' + inner + '*';
      case 'code': return '`' + inner + '`';
      case 'a': return '[' + inner + '](' + (node.getAttribute('href') || '') + ')';
      case 'br': return '\n';
      case 'div': case 'p': return (inner ? '\n' + inner : '');
      case 'ul': case 'ol': return inner;
      case 'li': return '\n- ' + inner;
      default: return inner;
    }
  }

  var md = '';
  for (var i = 0; i < notesEl.childNodes.length; i++) {
    md += nodeToMd(notesEl.childNodes[i]);
  }
  return md.replace(/^\n+/, '').replace(/\n+$/, '');
}

function handleStopFocus() {
  var notes = extractNotesMarkdown();
  sendMessageToPlugin('stopFocus', JSON.stringify({ notes: notes }));
}

function handleCompleteFocusTask(el) {
  var lineIndex = el.dataset.lineIndex;
  var notes = extractNotesMarkdown();
  sendMessageToPlugin('completeFocusTask', JSON.stringify({ lineIndex: lineIndex, notes: notes }));
}

// ============================================
// TOAST
// ============================================

function showToast(message) {
  var toast = document.getElementById('rfToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function() { toast.classList.remove('show'); }, 2000);
}

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', function() {
  currentTab = document.body.dataset.activeTab || 'today';

  // Resume timer if active
  var timerStart = document.body.dataset.timerStart;
  if (timerStart) {
    startTimerUI(parseInt(timerStart, 10));
  }

  // Also check focus card for timer data
  var focusCard = document.querySelector('.rf-focus-card[data-timer-start]');
  if (focusCard && !timerStart) {
    var cardTimer = focusCard.dataset.timerStart;
    if (cardTimer) startTimerUI(parseInt(cardTimer, 10));
  }

  // Init drag-and-drop on plan items (works on both today and plan tabs)
  if (currentTab === 'today' || currentTab === 'plan') {
    initPlanDragAndDrop();
  }

  // Keyboard shortcut
  document.addEventListener('keydown', handleKeyboardShortcut);

  // Delegated click handler
  document.body.addEventListener('click', function(e) {
    var target = e.target.closest('[data-action]');
    if (!target) return;

    var action = target.dataset.action;
    switch (action) {
      case 'switchTab':
        handleTabClick(target);
        break;
      case 'toggleNav':
        toggleNav();
        break;
      case 'addToPlan':
        handleAddToPlan(target);
        break;
      case 'togglePlan':
        handlePlanToggle(target);
        break;
      case 'startFocus':
        handleStartFocus(target);
        break;
      case 'stopFocus':
        handleStopFocus();
        break;
      case 'completeFocusTask':
        handleCompleteFocusTask(target);
        break;
      case 'startFocusFromToday':
        sendMessageToPlugin('startFocusFromToday', JSON.stringify({ taskContent: target.dataset.content }));
        break;
      case 'stopFocusFromToday':
        sendMessageToPlugin('stopFocusFromToday', JSON.stringify({}));
        break;
      case 'saveShutdown':
        var highlightsEl = document.getElementById('shutdownHighlights');
        sendMessageToPlugin('saveShutdown', JSON.stringify({ highlights: highlightsEl ? highlightsEl.value : '' }));
        break;
      case 'movePlanUp':
      case 'movePlanDown':
        sendMessageToPlugin(action, JSON.stringify({ lineIndex: target.dataset.lineIndex }));
        break;
      case 'addToPlanWithDuration':
        handleAddToPlanWithDuration(target);
        break;
      case 'addCalendarToPlan':
        handleAddCalendarToPlan(target);
        break;
      case 'showTimePicker':
        showTimePicker(target);
        break;
      case 'pickTime':
        handlePickTime(target);
        break;
      case 'cyclePlanPriority':
        sendMessageToPlugin('cyclePlanPriority', JSON.stringify({ lineIndex: target.dataset.lineIndex }));
        break;
      case 'openDailyNote':
        sendMessageToPlugin('openDailyNote', JSON.stringify({}));
        break;
    }
  });

  // Source tab clicks
  document.body.addEventListener('click', function(e) {
    var sourceTab = e.target.closest('.rf-source-tab');
    if (sourceTab) {
      handleSourceTabClick(sourceTab);
    }
  });

  // Markdown toolbar for focus notes
  document.body.addEventListener('click', function(e) {
    var tbBtn = e.target.closest('[data-md-action]');
    if (!tbBtn) return;
    e.preventDefault();
    var notesEl = document.getElementById('focusNotes');
    if (!notesEl) return;
    notesEl.focus();

    var action = tbBtn.dataset.mdAction;
    var sel = window.getSelection();
    var selectedText = sel.rangeCount > 0 ? sel.getRangeAt(0).toString() : '';

    switch (action) {
      case 'bold':
        document.execCommand('bold', false, null);
        break;
      case 'italic':
        document.execCommand('italic', false, null);
        break;
      case 'code':
        // Wrap selection in <code> tag
        if (selectedText) {
          var codeEl = document.createElement('code');
          codeEl.textContent = selectedText;
          var range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(codeEl);
          // Place cursor after the code element
          range.setStartAfter(codeEl);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          var codeEl2 = document.createElement('code');
          codeEl2.textContent = 'code';
          var range2 = sel.getRangeAt(0);
          range2.insertNode(codeEl2);
          // Select the placeholder text
          range2.selectNodeContents(codeEl2);
          sel.removeAllRanges();
          sel.addRange(range2);
        }
        break;
      case 'link':
        var url = prompt('URL:', 'https://');
        if (url) {
          var linkText = selectedText || 'link';
          var linkEl = document.createElement('a');
          linkEl.href = url;
          linkEl.textContent = linkText;
          if (sel.rangeCount > 0) {
            var range3 = sel.getRangeAt(0);
            range3.deleteContents();
            range3.insertNode(linkEl);
          }
        }
        break;
      case 'bullet':
        document.execCommand('insertUnorderedList', false, null);
        break;
      case 'task':
        // Insert a task line: "- [ ] "
        document.execCommand('insertHTML', false, '<br>- [ ] ');
        break;
    }
  });

  // Infinite scroll for Highlights tab
  var highlightsLoading = false;
  var mainEl = document.querySelector('.rf-main');
  if (mainEl) {
    mainEl.addEventListener('scroll', function() {
      if (highlightsLoading) return;
      var loadMore = document.getElementById('highlightsLoadMore');
      if (!loadMore || loadMore.classList.contains('exhausted')) return;

      var rect = loadMore.getBoundingClientRect();
      var mainRect = mainEl.getBoundingClientRect();
      // Trigger when sentinel is within 200px of the bottom of the visible area
      if (rect.top < mainRect.bottom + 200) {
        highlightsLoading = true;
        loadMore.innerHTML = '<span class="rf-text-muted">Loading...</span>';
        var offset = parseInt(loadMore.dataset.offset) || 0;
        sendMessageToPlugin('loadMoreHighlights', { offset: offset });
      }
    });
  }

  // Expose highlightsLoading reset for the handler
  window._hlLoading = function(v) { highlightsLoading = v; };
});

// ============================================
// HIGHLIGHTS INFINITE SCROLL
// ============================================

function buildHighlightEntryDOM(entry) {
  var card = document.createElement('div');
  card.className = 'rf-hl-entry';
  card.dataset.date = entry.date;

  var dateEl = document.createElement('div');
  dateEl.className = 'rf-hl-date';
  dateEl.textContent = entry.dateFormatted;
  card.appendChild(dateEl);

  var sections = [
    { items: entry.workedOn, icon: 'fa-mug-hot', label: 'Worked on', muted: false, highlight: false },
    { items: entry.didntGetTo, icon: 'fa-circle-pause', label: "Didn't get to", muted: true, highlight: false },
    { items: entry.highlights, icon: 'fa-pen-fancy', label: 'Highlights', muted: false, highlight: true },
  ];

  for (var s = 0; s < sections.length; s++) {
    var sec = sections[s];
    if (sec.items.length === 0) continue;

    var secDiv = document.createElement('div');
    secDiv.className = 'rf-hl-section';

    var labelDiv = document.createElement('div');
    labelDiv.className = 'rf-hl-section-label';
    var icon = document.createElement('i');
    icon.className = 'fa-solid ' + sec.icon;
    labelDiv.appendChild(icon);
    labelDiv.appendChild(document.createTextNode(' ' + sec.label));
    secDiv.appendChild(labelDiv);

    var ul = document.createElement('ul');
    ul.className = 'rf-hl-list' + (sec.highlight ? ' rf-hl-highlights' : '');
    for (var li = 0; li < sec.items.length; li++) {
      var item = document.createElement('li');
      if (sec.muted) item.className = 'rf-text-muted';
      // Use textContent by default, but items are pre-rendered HTML from the plugin
      // We need to set the text safely — use a span with textContent
      var span = document.createElement('span');
      span.textContent = sec.items[li];
      item.appendChild(span);
      ul.appendChild(item);
    }
    secDiv.appendChild(ul);
    card.appendChild(secDiv);
  }

  return card;
}

function handleHighlightsLoaded(data) {
  var feed = document.getElementById('highlightsFeed');
  var loadMore = document.getElementById('highlightsLoadMore');
  if (!feed || !loadMore) return;

  if (data.count === 0) {
    loadMore.classList.add('exhausted');
    var exhaustedSpan = document.createElement('span');
    exhaustedSpan.className = 'rf-text-muted';
    exhaustedSpan.textContent = 'No more highlights';
    loadMore.textContent = '';
    loadMore.appendChild(exhaustedSpan);
  } else {
    var entries = data.entries || [];
    for (var i = 0; i < entries.length; i++) {
      feed.insertBefore(buildHighlightEntryDOM(entries[i]), loadMore);
    }
    loadMore.dataset.offset = data.newOffset;
    var moreSpan = document.createElement('span');
    moreSpan.className = 'rf-text-muted';
    moreSpan.textContent = 'Scroll for more...';
    loadMore.textContent = '';
    loadMore.appendChild(moreSpan);
  }

  if (window._hlLoading) window._hlLoading(false);
}
