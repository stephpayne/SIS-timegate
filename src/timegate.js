/* Timegate — module wrapper and bootstrap. */
(function () {
  'use strict';

  var INSTANCE_KEY = 'timegate-v2';
  var LOADED_FLAG = '__timegateV2Loaded';
  var WRAPPED_FLAG = '__timegateV2Wrapped';
  var SUSPEND_DATA_KEY = '__timegate_v2';

  if (window[LOADED_FLAG]) {
    return;
  }
  window[LOADED_FLAG] = true;

  var DEFAULT_CONFIG = {
    minRequiredMinutes: 0,
    enforceCompletion: true,
    idleTimeoutSeconds: 120,
    backgroundGraceSeconds: 30,
    countWhileMediaPlaying: true,
    hideWhenComplete: false,
    position: 'bottom-right',
    debug: false,
    storageMode: 'dual',
    inactivityForceExitEnabled: true,
    inactivityForceExitMinutes: 5,
    inactivityWarningSeconds: 30,
    gentleNudgeEnabled: true,
    gentleNudgeSeconds: 60,
    launchModalEnabled: true,
    disableVideoSkip: true
  };

  var STATE_VERSION = 1;
  var PERSIST_INTERVAL_MS = 5000;
  var LOCK_TTL_MS = 15000;
  var MAX_DELTA_MS = 5000;
  var MEDIA_SCAN_INTERVAL_MS = 2000;

  var config = null;
  var state = null;
  var lastPersistTs = 0;
  var lastUiRender = '';
  var lastActivityTs = Date.now();
  var lastTickTs = Date.now();
  var backgroundSinceTs = null;
  var mediaPlaying = false;
  var iframeDoc = null;
  var isPrimaryTab = true;
  var storage = null;
  var apiAdapter = null;
  var apiInitialized = false;
  var pendingInitHydrate = false;
  var replayingScorm = false;
  var tabId = String(Math.random()).slice(2);
  var lockKey = null;
  var driverAdapter = null;
  var timerStarted = false;
  var forceExitTriggered = false;
  var warningEl = null;
  var gentleNudgeEl = null;
  var walkBackEl = null;
  var launchModalEl = null;

  /* Debug logger gated by config. */
  function log() {
    if (!config || !config.debug) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[timegate]');
    try {
      console.log.apply(console, args);
    } catch (e) {
      // ignore
    }
  }

  /* Resolve storage mode from config with backward compatibility. */
  function resolveStorageMode() {
    var mode = config && typeof config.storageMode === 'string' ? config.storageMode : '';
    if (mode) return mode;
    return 'localStorage';
  }

  /* Parse JSON safely, returning null on failure. */
  function safeJsonParse(str) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  /*
   * Strip // line comments and block comments, plus trailing commas, so the
   * config file can be annotated with section headers and edited forgivingly
   * by non-developers. String-aware so comment markers inside values survive.
   * Only used for timegate.config.json, never for stored SCORM state.
   */
  function stripJsonComments(text) {
    if (typeof text !== 'string') return text;
    var out = '';
    var inString = false, strChar = '', inLine = false, inBlock = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i), n = text.charAt(i + 1);
      if (inLine) {
        if (c === '\n') { inLine = false; out += c; }
        continue;
      }
      if (inBlock) {
        if (c === '*' && n === '/') { inBlock = false; i++; }
        continue;
      }
      if (inString) {
        out += c;
        if (c === '\\') { out += n; i++; continue; }
        if (c === strChar) inString = false;
        continue;
      }
      if (c === '"' || c === "'") { inString = true; strChar = c; out += c; continue; }
      if (c === '/' && n === '/') { inLine = true; i++; continue; }
      if (c === '/' && n === '*') { inBlock = true; i++; continue; }
      out += c;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
  }

  /* Stringify JSON safely, returning null on failure. */
  function safeJsonStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return null;
    }
  }

  /* Merge default config with overrides. */
  function mergeConfig(base, override) {
    var out = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        out[key] = base[key];
      }
    }
    if (override) {
      for (key in override) {
        if (Object.prototype.hasOwnProperty.call(override, key)) {
          out[key] = override[key];
        }
      }
    }
    return out;
  }

  /* Resolve base URL of current script for config loading. */
  function getScriptBaseUrl() {
    var script = document.currentScript;
    if (!script) {
      var scripts = document.getElementsByTagName('script');
      script = scripts[scripts.length - 1];
    }
    if (!script || !script.src) return '';
    return script.src.replace(/\/[^/]*$/, '/');
  }

  /* Load config from global or JSON file. */
  function loadConfig(done) {
    if (window.TIMEGATE_CONFIG && typeof window.TIMEGATE_CONFIG === 'object') {
      done(mergeConfig(DEFAULT_CONFIG, window.TIMEGATE_CONFIG));
      return;
    }

    var baseUrl = getScriptBaseUrl();
    var configUrl =
      baseUrl ?
        baseUrl + 'timegate.config.json'
      : 'timegate/timegate.config.json'; // fallback only; normally resolved relative to this script's URL

    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', configUrl, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = safeJsonParse(stripJsonComments(xhr.responseText));
          done(mergeConfig(DEFAULT_CONFIG, parsed || {}));
        } else {
          log('Config load failed, using defaults', xhr.status);
          done(mergeConfig(DEFAULT_CONFIG, {}));
        }
      };
      xhr.send(null);
    } catch (e) {
      log('Config load error, using defaults', e);
      done(mergeConfig(DEFAULT_CONFIG, {}));
    }
  }

  /* Format seconds as H:MM:SS or M:SS. */
  function formatTime(totalSeconds) {
    var seconds = Math.max(0, Math.floor(totalSeconds));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var secs = seconds % 60;
    var pad = function (n) {
      return n < 10 ? '0' + n : '' + n;
    };
    if (hours > 0) {
      return hours + ':' + pad(minutes) + ':' + pad(secs);
    }
    return minutes + ':' + pad(secs);
  }

  /* Clamp timer delta to avoid time jumps. */
  function clampDelta(ms) {
    if (ms < 0) return 0;
    if (ms > MAX_DELTA_MS) return MAX_DELTA_MS;
    return ms;
  }

  /* Build and insert the timer overlay UI. */
  function createUi() {
    var root = document.createElement('div');
    root.id = 'timegate-root';
    root.className =
      'timegate--' +
      (config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right');

    var card = document.createElement('div');
    card.className = 'timegate-card';

      var close = document.createElement('button');
      close.className = 'timegate-close';
      close.type = 'button';
      close.textContent = '✕';
      close.setAttribute('aria-label', 'Hide timer');
      close.onclick = function () {
        document.getElementById('timegate-root').style.display = 'none';
      };

    var label = document.createElement('div');
    label.className = 'timegate-label';
    label.textContent = 'Time remaining';

    var time = document.createElement('div');
    time.className = 'timegate-time';
    time.textContent = '0:00';

    var sub = document.createElement('div');
    sub.className = 'timegate-sub';
    sub.textContent = '';

    card.appendChild(close);
    card.appendChild(label);
    card.appendChild(time);
    card.appendChild(sub);
    root.appendChild(card);

    root.setAttribute('aria-live', 'polite');
    root.setAttribute('role', 'status');

    document.body.appendChild(root);

    return {
      root: root,
      close: close,
      label: label,
      time: time,
      sub: sub,
    };
  }

  /* Build and insert the launch acknowledgment modal. */
  function createLaunchModal(onAcknowledge) {
    var overlay = document.createElement('div');
    overlay.id = 'timegate-launch-modal';
    overlay.className = 'timegate-launch-modal';

    var card = document.createElement('div');
    card.className = 'timegate-launch-card';

    var title = document.createElement('div');
    title.className = 'timegate-launch-title';
    title.textContent = 'Before you begin';
    title.id = 'timegate-launch-title';

    var body = document.createElement('div');
    body.className = 'timegate-launch-body';

    var p1 = document.createElement('p');
    p1.textContent =
      'Welcome! A timer in the bottom right of your screen tracks your progress. ' +
      'To complete this course, you\u2019ll need to finish all the content AND meet the minimum time requirement.';

    var p2 = document.createElement('p');
    p2.textContent =
      'Take your time, read carefully, and engage with the material. ' +
      'Pacing yourself supports better understanding and retention. It also ensures your training counts.';

    body.appendChild(p1);
    body.appendChild(p2);

    /* Preview timer widget — pulses in corner during modal to show learner where the timer will live. */
    var previewRoot = document.createElement('div');
    previewRoot.id = 'timegate-modal-preview';
    previewRoot.className =
      config && config.position === 'bottom-left' ? 'timegate--bottom-left' : '';

    var previewCard = document.createElement('div');
    previewCard.className = 'timegate-preview-card';

    var previewLabel = document.createElement('div');
    previewLabel.className = 'timegate-label';
    previewLabel.textContent = 'Time remaining';

    var previewTime = document.createElement('div');
    previewTime.className = 'timegate-time';
    var previewRemaining = state ?
      Math.max(0, state.minRequiredSeconds - Math.floor(state.elapsedSeconds)) : 0;
    previewTime.textContent = formatTime(previewRemaining);

    previewCard.appendChild(previewLabel);
    previewCard.appendChild(previewTime);
    previewRoot.appendChild(previewCard);
    document.body.appendChild(previewRoot);

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'timegate-launch-button';
    button.textContent = 'I understand';
    button.onclick = function () {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      if (previewRoot.parentNode) {
        previewRoot.parentNode.removeChild(previewRoot);
      }
      launchModalEl = null;
      if (typeof onAcknowledge === 'function') onAcknowledge();
    };

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(button);
    overlay.appendChild(card);

    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'timegate-launch-title');

    document.body.appendChild(overlay);
    launchModalEl = overlay;

    try { button.focus(); } catch (e) { /* ignore */ }

    return overlay;
  }

  /* Build the inactivity warning toast (hidden by default). */
  function createWarningToast() {
    var toast = document.createElement('div');
    toast.id = 'timegate-warning';
    toast.className = 'timegate-warning';
    toast.style.display = 'none';
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');

    var title = document.createElement('div');
    title.className = 'timegate-warning-title';
    title.textContent = 'Still there? Session ending';

    var msg = document.createElement('div');
    msg.className = 'timegate-warning-msg';

    var msgText = document.createTextNode('Session ending in ');
    var strong = document.createElement('strong');
    var secondsSpan = document.createElement('span');
    secondsSpan.className = 'timegate-warning-seconds';
    secondsSpan.textContent = '30';
    strong.appendChild(secondsSpan);
    var secondsLabel = document.createTextNode(' seconds');
    strong.appendChild(secondsLabel);
    var msgText2 = document.createTextNode(' due to inactivity.');
    msg.appendChild(msgText);
    msg.appendChild(strong);
    msg.appendChild(msgText2);

    var sub = document.createElement('div');
    sub.className = 'timegate-warning-sub';
    sub.textContent = 'Move your mouse or press any key to stay in the course.';

    toast.appendChild(title);
    toast.appendChild(msg);
    toast.appendChild(sub);
    document.body.appendChild(toast);

    warningEl = toast;
    return toast;
  }

  /* Show/update the warning toast countdown. */
  function showWarning(secondsRemaining) {
    if (!warningEl) createWarningToast();
    var secs = Math.max(0, Math.ceil(secondsRemaining));
    var secondsSpan = warningEl.querySelector('.timegate-warning-seconds');
    if (secondsSpan) secondsSpan.textContent = secs;
    if (warningEl.style.display === 'none') {
      warningEl.style.display = '';
    }
  }

  /* Hide the warning toast. */
  function hideWarning() {
    if (warningEl && warningEl.style.display !== 'none') {
      warningEl.style.display = 'none';
    }
  }

  /* Build the gentle "are you still here?" nudge (hidden by default). */
  function createGentleNudge() {
    var nudge = document.createElement('div');
    nudge.id = 'timegate-nudge';
    nudge.className = 'timegate-nudge';
    nudge.style.display = 'none';
    nudge.setAttribute('role', 'status');
    nudge.setAttribute('aria-live', 'polite');

    var title = document.createElement('div');
    title.className = 'timegate-nudge-title';
    title.textContent = 'Are you still here?';

    var sub = document.createElement('div');
    sub.className = 'timegate-nudge-sub';
    sub.textContent = 'Move your mouse, press a key, or tap the screen to keep going.';

    nudge.appendChild(title);
    nudge.appendChild(sub);
    document.body.appendChild(nudge);

    gentleNudgeEl = nudge;
    return nudge;
  }

  /* Show the gentle nudge. */
  function showGentleNudge() {
    if (!gentleNudgeEl) createGentleNudge();
    if (gentleNudgeEl.style.display === 'none') {
      gentleNudgeEl.style.display = '';
    }
  }

  /* Hide the gentle nudge. */
  function hideGentleNudge() {
    if (gentleNudgeEl && gentleNudgeEl.style.display !== 'none') {
      gentleNudgeEl.style.display = 'none';
    }
  }

  /* Build and display the walk-back overlay covering the course UI. */
  function showWalkBackOverlay() {
    if (walkBackEl) return;

    var overlay = document.createElement('div');
    overlay.id = 'timegate-walkback';
    overlay.className = 'timegate-walkback';

    var card = document.createElement('div');
    card.className = 'timegate-walkback-card';

    var title = document.createElement('div');
    title.className = 'timegate-walkback-title';
    title.id = 'timegate-walkback-title';
    title.textContent = 'Session ended due to inactivity';

    var msg = document.createElement('p');
    msg.className = 'timegate-walkback-msg';
    msg.textContent =
      'Your course session was closed after an extended period of no activity. ' +
      'Please close this window and relaunch the course from your LMS to resume where you left off.';

    card.appendChild(title);
    card.appendChild(msg);
    overlay.appendChild(card);

    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'timegate-walkback-title');
    document.body.appendChild(overlay);

    walkBackEl = overlay;
  }

  /* Terminate the SCORM session and show walk-back overlay. */
  function triggerForceExit() {
    if (forceExitTriggered) return;
    forceExitTriggered = true;
    log('Force exit triggered due to inactivity');

    if (apiAdapter) {
      try {
        if (apiAdapter.is2004) {
          setScormValue('cmi.exit', 'suspend');
        } else {
          setScormValue('cmi.core.exit', 'suspend');
        }
      } catch (e) {
        // ignore
      }
    }

    persistState(true);

    if (apiAdapter && apiAdapter.original.commit) {
      try { apiAdapter.original.commit(''); } catch (e) { /* ignore */ }
    }
    if (apiAdapter && apiAdapter.original.terminate) {
      try { apiAdapter.original.terminate(''); } catch (e) { /* ignore */ }
    }

    hideWarning();
    hideGentleNudge();
    showWalkBackOverlay();
  }

  /* Evaluate inactivity thresholds; show warning or trigger force exit. */
  function evaluateInactivity() {
    if (!config.inactivityForceExitEnabled) return;
    if (forceExitTriggered) return;
    if (!timerStarted) return;

    /*
     * Playing media counts as activity. A learner watching a video does not
     * generate mouse/keyboard events, so without this they would be force-
     * exited mid-playback. While media plays we treat the learner as active:
     * reset the inactivity clock and clear any pending warning. Gated by
     * countWhileMediaPlaying so publishers can opt out.
     */
    if (config.countWhileMediaPlaying && mediaPlaying) {
      lastActivityTs = Date.now();
      hideWarning();
      hideGentleNudge();
      return;
    }

    var now = Date.now();
    var inactiveMs = now - lastActivityTs;
    var forceExitMs = (config.inactivityForceExitMinutes || 0) * 60 * 1000;
    var warningMs = (config.inactivityWarningSeconds || 0) * 1000;
    var nudgeMs = config.gentleNudgeEnabled ? (config.gentleNudgeSeconds || 0) * 1000 : 0;

    if (forceExitMs <= 0) return;

    /*
     * Three-phase inactivity, measured backward from the force-exit point:
     *   [active] -> [gentle nudge] -> [final warning + countdown] -> [exit]
     * The gentle nudge gives a calm "still here?" prompt low on the screen
     * before the firmer countdown toast appears. Any activity (or playing
     * media, handled above) resets the clock and clears both.
     */
    if (inactiveMs >= forceExitMs) {
      triggerForceExit();
      return;
    }

    var msUntilExit = forceExitMs - inactiveMs;
    if (msUntilExit <= warningMs) {
      hideGentleNudge();
      showWarning(msUntilExit / 1000);
    } else if (nudgeMs > 0 && msUntilExit <= warningMs + nudgeMs) {
      hideWarning();
      showGentleNudge();
    } else {
      hideWarning();
      hideGentleNudge();
    }
  }

  /* Update overlay text and state classes. */
  function updateUi(ui, opts) {
    var display = opts.display;
    var sub = opts.sub;
    var complete = opts.complete;
    var paused = opts.paused;
    var locked = opts.locked;
    var stateClass = opts.stateClass;
    var labelText = opts.labelText;
    var showLabel = opts.showLabel;

    ui.time.textContent = display;

    ui.sub.textContent = sub || '';

    if (typeof labelText === 'string') {
      ui.label.textContent = labelText;
    }
    ui.label.style.display = showLabel ? '' : 'none';

    var rootClass = ui.root.className;
    var nextClass =
      'timegate--' +
      (config.position === 'bottom-left' ? 'bottom-left' : 'bottom-right');

    if (paused) nextClass += ' timegate--paused';
    if (locked) nextClass += ' timegate--locked';
    if (complete) nextClass += ' timegate--complete';
    if (stateClass) nextClass += ' ' + stateClass;
    if (config.hideWhenComplete && complete) nextClass += ' timegate--hidden';

    if (rootClass !== nextClass) {
      ui.root.className = nextClass;
    }
  }

  /* Test and return localStorage if usable. */
  function getLocalStorage() {
    try {
      var ls = window.localStorage;
      var key = '__timegate_v2_test__';
      ls.setItem(key, '1');
      ls.removeItem(key);
      return ls;
    } catch (e) {
      return null;
    }
  }

  /* Locate SCORM API in window ancestry, opener, or child frames. */
  function findApi(win) {
    var maxDepth = 10;
    var visited = [];
    var trace = [];

    function describeWindow(target) {
      var info = { name: '', href: '', isTop: false };
      if (!target) return info;
      try {
        info.name = target.name || '';
      } catch (e) {
        // ignore
      }
      try {
        info.href = target.location && target.location.href ? target.location.href : '';
      } catch (e) {
        // ignore
      }
      try {
        info.isTop = target === target.top;
      } catch (e) {
        // ignore
      }
      return info;
    }

    function recordTrace(kind, context, target, extra) {
      if (!config || !config.debug) return;
      var info = describeWindow(target);
      trace.push({
        kind: kind,
        context: context || '',
        name: info.name,
        href: info.href,
        isTop: info.isTop,
        extra: extra || ''
      });
    }

    function wasVisited(target) {
      for (var i = 0; i < visited.length; i++) {
        if (visited[i] === target) return true;
      }
      return false;
    }

    function markVisited(target) {
      if (!target || wasVisited(target)) return false;
      visited.push(target);
      return true;
    }

    function checkWindow(target, context) {
      if (!target || !markVisited(target)) return null;
      try {
        if (target.API_1484_11) {
          recordTrace('found', context, target, '2004');
          return { api: target.API_1484_11, version: '2004' };
        }
        if (target.API) {
          recordTrace('found', context, target, '1.2');
          return { api: target.API, version: '1.2' };
        }
        recordTrace('checked', context, target, 'none');
      } catch (e) {
        recordTrace('blocked', context, target, 'cross-domain');
      }
      return null;
    }

    function scanParents(start) {
      var current = start;
      var depth = 0;
      while (current && depth++ < maxDepth) {
        var found = checkWindow(current, 'parent:' + depth);
        if (found) return found;
        try {
          if (current.parent && current.parent !== current) {
            current = current.parent;
            continue;
          }
        } catch (e) {
          // ignore cross-domain
        }
        break;
      }
      return null;
    }

    function scanChildren(start, depth) {
      if (!start || depth > maxDepth) return null;
      var frames;
      try {
        frames = start.frames;
      } catch (e) {
        recordTrace('blocked', 'children:' + depth, start, 'cross-domain');
        return null;
      }
      if (!frames || !frames.length) return null;
      for (var i = 0; i < frames.length; i++) {
        var child = frames[i];
        var found = checkWindow(child, 'child:' + depth + '.' + i);
        if (found) return found;
        found = scanChildren(child, depth + 1);
        if (found) return found;
      }
      return null;
    }

    var api = scanParents(win);
    if (api) {
      if (trace.length) log('SCORM API trace', trace);
      return api;
    }

    var opener = null;
    try {
      if (win.top && win.top.opener) opener = win.top.opener;
    } catch (e) {
      // ignore cross-domain
    }
    if (!opener) {
      try {
        if (win.opener) opener = win.opener;
      } catch (e) {
        // ignore cross-domain
      }
    }
    if (opener) {
      api = scanParents(opener);
      if (api) {
        if (trace.length) log('SCORM API trace', trace);
        return api;
      }
      api = scanChildren(opener, 0);
      if (api) {
        if (trace.length) log('SCORM API trace', trace);
        return api;
      }
    }

    api = scanChildren(win, 0);
    if (api) {
      if (trace.length) log('SCORM API trace', trace);
      return api;
    }

    if (trace.length) log('SCORM API trace', trace);

    return null;
  }

  /* Create SCORM adapter and wrap Initialize if present. */
  function createApiAdapter() {
    var info = findApi(window);
    if (!info) {
      log('SCORM API not found');
      return null;
    }

    var api = info.api;
    var is2004 = info.version === '2004';
    var method = {
      initialize: is2004 ? 'Initialize' : 'LMSInitialize',
      terminate: is2004 ? 'Terminate' : 'LMSFinish',
      getValue: is2004 ? 'GetValue' : 'LMSGetValue',
      setValue: is2004 ? 'SetValue' : 'LMSSetValue',
      commit: is2004 ? 'Commit' : 'LMSCommit',
    };

    if (!api[method.setValue]) {
      log('SCORM API missing SetValue');
      return null;
    }

    var adapter = {
      api: api,
      is2004: is2004,
      method: method,
      original: {
        initialize:
          api[method.initialize] ? api[method.initialize].bind(api) : null,
        terminate:
          api[method.terminate] ? api[method.terminate].bind(api) : null,
        getValue: api[method.getValue] ? api[method.getValue].bind(api) : null,
        setValue: api[method.setValue].bind(api),
        commit: api[method.commit] ? api[method.commit].bind(api) : null,
      },
    };

    if (adapter.original.initialize) {
      api[method.initialize] = function () {
        var result = adapter.original.initialize.apply(api, arguments);
        apiInitialized = true;
        if (pendingInitHydrate) {
          pendingInitHydrate = false;
          hydrateFromStorage();
        }
        syncCompletionFromLms('initialize');
        if (storage && (storage.type === 'suspend_data' || storage.type === 'dual')) {
          persistState(true);
        }
        return result;
      };
    }

    return adapter;
  }

  /* Wrap driver-level completion functions (Rise uses these). */
  function createDriverAdapter() {
    var names = ['SetReachedEnd', 'SetPassed', 'SetFailed', 'SetStatus'];
    var originals = {};
    var found = false;
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (typeof window[name] === 'function') {
        originals[name] = window[name].bind(window);
        found = true;
      }
    }
    if (!found) return null;
    return { originals: originals };
  }

  /* Read SCORM value safely. */
  function getScormValue(element) {
    if (!apiAdapter || !apiAdapter.original.getValue) return '';
    try {
      return apiAdapter.original.getValue(element);
    } catch (e) {
      return '';
    }
  }

  /* Write SCORM value safely. */
  function setScormValue(element, value) {
    if (!apiAdapter) return false;
    try {
      return apiAdapter.original.setValue(element, value);
    } catch (e) {
      return false;
    }
  }

  /* Commit SCORM data safely. */
  function commitScorm() {
    if (!apiAdapter || !apiAdapter.original.commit) return false;
    try {
      return apiAdapter.original.commit('');
    } catch (e) {
      return false;
    }
  }

  /* Derive a stable course key for storage. */
  function buildCourseKey() {
    if (config && config.courseKey) return config.courseKey;
    var title = '';
    try {
      if (typeof window.getCourseTitle === 'function') {
        title = window.getCourseTitle();
      } else {
        title = document.title || '';
      }
    } catch (e) {
      title = document.title || '';
    }
    var path =
      window.location && window.location.pathname ?
        window.location.pathname
      : '';
    return (path || 'course') + '|' + title;
  }

  /*
   * Derive learner key from SCORM, or 'anonymous' when no id is available. This
   * runs during init, before the course calls Initialize, so on some LMSs the id
   * is not yet readable and the key stays 'anonymous'. That only matters in
   * localStorage-only mode on a machine shared by multiple learners; the default
   * 'dual' mode persists to SCORM suspend_data, which the LMS already scopes per
   * learner, so the key is not relied on there.
   */
  function buildLearnerKey() {
    var id = '';
    if (apiAdapter && apiAdapter.original.getValue) {
      if (apiAdapter.is2004) {
        id = getScormValue('cmi.learner_id');
      } else {
        id = getScormValue('cmi.core.student_id');
      }
    }
    if (!id) id = 'anonymous';
    return String(id);
  }

  /* Read Timegate payload from suspend_data. */
  function readSuspendData() {
    if (!apiAdapter) return null;
    var raw = getScormValue('cmi.suspend_data');
    if (config && config.debug) {
      log('Suspend_data read', {
        length: raw ? raw.length : 0,
        hasValue: !!raw,
      });
    }
    if (!raw) return null;
    var parsed = safeJsonParse(raw);
    if (config && config.debug) {
      log('Suspend_data parse', {
        json: !!parsed,
        hasTimegate: !!(parsed && parsed[SUSPEND_DATA_KEY])
      });
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed[SUSPEND_DATA_KEY]) return null;
    return safeJsonStringify(parsed[SUSPEND_DATA_KEY]);
  }

  /* Write Timegate payload into suspend_data namespace. */
  function writeSuspendData(serialized) {
    if (!apiAdapter) return false;
    var raw = getScormValue('cmi.suspend_data');
    var container = {};
    if (raw) {
      var parsed = safeJsonParse(raw);
      if (parsed && typeof parsed === 'object') {
        container = parsed;
      } else {
        // Unsafe to overwrite unknown suspend_data format.
        log('Suspend_data not JSON; skipping write');
        return false;
      }
    }
    var payload = safeJsonParse(serialized);
    if (!payload || typeof payload !== 'object') return false;
    container[SUSPEND_DATA_KEY] = payload;
    var next = safeJsonStringify(container);
    if (!next) return false;
    if (next.length > 3800) {
      log('Suspend_data payload too large; skipping write');
      return false;
    }
    var ok = setScormValue('cmi.suspend_data', next);
    if (ok && apiAdapter.original.commit) {
      commitScorm();
    }
    return ok;
  }

  /* Choose persistence backend (localStorage or suspend_data). */
  function createStorage() {
    var ls = getLocalStorage();
    var mode = resolveStorageMode();

    if (mode === 'dual' && ls && apiAdapter) {
      return {
        type: 'dual',
        get: function (key) {
          var scormVal = readSuspendData();
          if (scormVal) {
            if (storage) storage.lastGetSource = 'suspend_data';
            return scormVal;
          }
          try {
            var val = ls.getItem(key);
            if (val) {
              if (storage) storage.lastGetSource = 'localStorage';
              return val;
            }
          } catch (e) {
            // ignore
          }
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = false;
          try {
            ls.setItem(key, value);
            ok = true;
          } catch (e) {
            ok = false;
          }
          var sdOk = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'dual',
            localStorage: ok,
            suspend_data: apiInitialized ? sdOk : 'deferred',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    if (mode === 'suspend_data') {
      return {
        type: 'suspend_data',
        get: function (key) {
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'suspend_data',
            ok: apiInitialized ? ok : false,
            reason: apiInitialized ? '' : 'api-not-initialized',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    if (mode === 'localStorage' && ls) {
      return {
        type: 'localStorage',
        get: function (key) {
          try {
            if (storage) storage.lastGetSource = 'localStorage';
            return ls.getItem(key);
          } catch (e) {
            return null;
          }
        },
        set: function (key, value) {
          try {
            ls.setItem(key, value);
            log('Persist', {
              backend: 'localStorage',
              ok: true,
              bytes: value ? value.length : 0
            });
            return true;
          } catch (e) {
            log('Persist', {
              backend: 'localStorage',
              ok: false,
              bytes: value ? value.length : 0
            });
            return false;
          }
        },
      };
    }

    if (mode === 'dual' && apiAdapter) {
      return {
        type: 'suspend_data',
        get: function (key) {
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'suspend_data',
            ok: apiInitialized ? ok : false,
            reason: apiInitialized ? '' : 'api-not-initialized',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    if (apiAdapter) {
      return {
        type: 'suspend_data',
        get: function (key) {
          if (storage) storage.lastGetSource = 'suspend_data';
          return readSuspendData();
        },
        set: function (key, value) {
          var ok = apiInitialized ? writeSuspendData(value) : false;
          log('Persist', {
            backend: 'suspend_data',
            ok: apiInitialized ? ok : false,
            reason: apiInitialized ? '' : 'api-not-initialized',
            bytes: value ? value.length : 0
          });
          return ok;
        },
      };
    }

    return {
      type: 'memory',
      get: function () {
        if (storage) storage.lastGetSource = 'memory';
        return null;
      },
      set: function () {
        return false;
      },
    };
  }

  /* Load persisted timer state into memory. */
  function hydrateFromStorage() {
    if (!storage) return false;
    var raw = storage.get(state.storageKey);
    if (!raw) return false;
    var parsed = safeJsonParse(raw);
    if (!parsed || parsed.version !== STATE_VERSION) return false;

    var storedElapsed = parsed.elapsedSeconds || 0;
    if (storedElapsed > state.elapsedSeconds) {
      state.elapsedSeconds = storedElapsed;
    }
    if (!state.minMetAt && storedElapsed >= state.minRequiredSeconds) {
      state.minMetAt = parsed.minMetAt || new Date().toISOString();
    }
    if (typeof parsed.courseCompleteSent === 'boolean') {
      state.courseCompleteSent = parsed.courseCompleteSent;
    }
    if (typeof parsed.courseCompletePending === 'boolean') {
      state.courseCompletePending = parsed.courseCompletePending;
    }
    if (!state.pendingScorm && parsed.pendingScorm) {
      state.pendingScorm = parsed.pendingScorm;
    }
    if (!state.pendingDriverCalls && parsed.pendingDriverCalls) {
      state.pendingDriverCalls = parsed.pendingDriverCalls;
    }

    log('Hydrated state', state);
    log('Hydrated from', storage.lastGetSource || storage.type || 'unknown');
    return true;
  }

  /* Persist current state at a controlled cadence. */
  function persistState(force) {
    if (!storage) return;
    var now = Date.now();
    if (!force && now - lastPersistTs < PERSIST_INTERVAL_MS) return;

    var payload = {
      version: STATE_VERSION,
      courseKey: state.courseKey,
      learnerKey: state.learnerKey,
      elapsedSeconds: Math.floor(state.elapsedSeconds || 0),
      minRequiredSeconds: state.minRequiredSeconds,
      minMetAt: state.minMetAt,
      lastTickTs: now,
      courseCompleteSent: !!state.courseCompleteSent,
      courseCompletePending: !!state.courseCompletePending,
      pendingScorm: state.pendingScorm || null,
      pendingDriverCalls: state.pendingDriverCalls || null,
    };

    var serialized = safeJsonStringify(payload);
    if (!serialized) return;
    var ok = storage.set(state.storageKey, serialized);
    if (ok) lastPersistTs = now;
  }

  /* Determine if time should accrue right now. */
  function getPauseReason() {
    var now = Date.now();
    var idleLimit = (config.idleTimeoutSeconds || 60) * 1000;
    var backgroundGraceMs = (config.backgroundGraceSeconds || 0) * 1000;
    var idle = now - lastActivityTs > idleLimit;
    var isForeground = true;

    if (document.hidden) isForeground = false;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) isForeground = false;
    if (!isPrimaryTab) isForeground = false;

    if (!isForeground) {
      if (backgroundSinceTs === null) {
        backgroundSinceTs = now;
      }
      if (now - backgroundSinceTs > backgroundGraceMs) {
        return 'background';
      }
    } else {
      backgroundSinceTs = null;
    }

    if (idle) {
      if (config.countWhileMediaPlaying && mediaPlaying) {
        return '';
      }
      return 'inactivity';
    }
    return '';
  }

  function isActive() {
    return !getPauseReason();
  }

  /* Enforce single active tab using a storage lock. */
  function updateLock() {
    if (!lockKey || !storage || storage.type !== 'localStorage') {
      isPrimaryTab = true;
      return;
    }
    var now = Date.now();
    var raw = storage.get(lockKey);
    var parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || !parsed.tabId || now - parsed.ts > LOCK_TTL_MS) {
      storage.set(lockKey, safeJsonStringify({ tabId: tabId, ts: now }));
      isPrimaryTab = true;
      return;
    }
    if (parsed.tabId === tabId) {
      storage.set(lockKey, safeJsonStringify({ tabId: tabId, ts: now }));
      isPrimaryTab = true;
      return;
    }
    isPrimaryTab = false;
  }

  /* Return true if any video/audio element in a document is playing. */
  function docHasPlayingMedia(doc) {
    if (!doc) return false;
    var media;
    try {
      media = doc.querySelectorAll('video, audio');
    } catch (e) {
      return false;
    }
    for (var i = 0; i < media.length; i++) {
      var el = media[i];
      try {
        if (!el.paused && !el.ended && el.readyState >= 2) {
          return true;
        }
      } catch (e) {
        // ignore individual element errors
      }
    }
    return false;
  }

  /* Recursively scan a window and its same-origin frames for playing media. */
  function windowHasPlayingMedia(win, depth) {
    if (!win || depth > 6) return false;
    var doc;
    try {
      doc = win.document;
    } catch (e) {
      return false; // cross-origin frame; cannot inspect
    }
    if (docHasPlayingMedia(doc)) return true;
    var frames;
    try {
      frames = win.frames;
    } catch (e) {
      return false;
    }
    if (!frames || !frames.length) return false;
    for (var i = 0; i < frames.length; i++) {
      try {
        if (windowHasPlayingMedia(frames[i], depth + 1)) return true;
      } catch (e) {
        // ignore cross-origin child
      }
    }
    return false;
  }

  /*
   * Detect active media playback. Rise nests its content (and video) in one or
   * more iframes, so we scan the top window and every same-origin frame, not
   * just the single bound iframe document. The bound iframeDoc is checked as a
   * fallback in case frame traversal misses it.
   */
  function updateMediaPlaying() {
    if (!config.countWhileMediaPlaying) {
      mediaPlaying = false;
      return;
    }
    var playing = false;
    try {
      playing = windowHasPlayingMedia(window, 0);
    } catch (e) {
      playing = false;
    }
    if (!playing && iframeDoc) {
      playing = docHasPlayingMedia(iframeDoc);
    }
    mediaPlaying = playing;
  }

  /*
   * Forward-skip prevention. Mirrors the "restrict seeking" behavior an author
   * can set on a Rise video block, but applies it at runtime so it holds even
   * when the author forgot. For each video we track the furthest point actually
   * watched and silently clamp any forward seek back to it; rewinding to
   * re-watch is always allowed. Works for plain MP4 and HLS alike because it
   * operates on the element's currentTime. Same-origin only — a cross-origin
   * embedded player cannot be controlled.
   */
  var SEEK_TOLERANCE_S = 0.75;

  function guardVideoSeek(video) {
    if (!video || video.__timegateSeekGuarded) return;
    video.__timegateSeekGuarded = true;
    // Seed the watermark from the current position so a legitimate resume
    // (Rise restoring a saved spot) is not yanked back to zero.
    var maxWatched = video.currentTime || 0;
    video.addEventListener('timeupdate', function () {
      if (!video.seeking && video.currentTime > maxWatched) {
        maxWatched = video.currentTime;
      }
    });
    var clamp = function () {
      try {
        if (video.currentTime > maxWatched + SEEK_TOLERANCE_S) {
          video.currentTime = maxWatched;
        }
      } catch (e) {
        // ignore element errors
      }
    };
    video.addEventListener('seeking', clamp);
    video.addEventListener('seeked', clamp);
    log('seek guard attached to a video element');
  }

  /* Attach the seek guard to every video element in a document. */
  function guardDocVideos(doc) {
    if (!doc) return;
    var vids;
    try {
      vids = doc.querySelectorAll('video');
    } catch (e) {
      return;
    }
    for (var i = 0; i < vids.length; i++) {
      try {
        guardVideoSeek(vids[i]);
      } catch (e) {
        // ignore individual element errors
      }
    }
  }

  /* Recursively guard videos in a window and its same-origin frames. */
  function guardWindowVideos(win, depth) {
    if (!win || depth > 6) return;
    var doc;
    try {
      doc = win.document;
    } catch (e) {
      if (depth > 0) log('cross-origin frame; cannot disable video skip there');
      return;
    }
    guardDocVideos(doc);
    var frames;
    try {
      frames = win.frames;
    } catch (e) {
      return;
    }
    if (!frames || !frames.length) return;
    for (var i = 0; i < frames.length; i++) {
      try {
        guardWindowVideos(frames[i], depth + 1);
      } catch (e) {
        // ignore cross-origin child
      }
    }
  }

  /*
   * Find and guard any not-yet-guarded videos. Run on the same periodic scan as
   * media detection so videos that load as the learner navigates (Rise loads
   * lessons on demand) are picked up shortly after they appear.
   */
  function updateVideoSeekGuards() {
    if (!config.disableVideoSkip) return;
    try {
      guardWindowVideos(window, 0);
    } catch (e) {
      // ignore
    }
    if (iframeDoc) guardDocVideos(iframeDoc);
  }

  /* Mark recent user activity. */
  function trackActivity() {
    lastActivityTs = Date.now();
  }

  /* Attach activity listeners to a document. */
  function attachActivityListeners(doc) {
    if (!doc) return;
    var events = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'pointerdown',
      'wheel',
    ];
    for (var i = 0; i < events.length; i++) {
      doc.addEventListener(events[i], trackActivity, true);
    }
  }

  /* Bind to course iframe and wire activity tracking. */
  function attachIframeListeners() {
    var iframe =
      document.getElementById('content-frame') ||
      document.querySelector('iframe[name="scormdriver_content"]');
    if (!iframe) return;

    iframe.addEventListener('load', function () {
      try {
        iframeDoc = iframe.contentWindow.document;
        attachActivityListeners(iframeDoc);
      } catch (e) {
        iframeDoc = null;
      }
    });

    try {
      if (iframe.contentWindow && iframe.contentWindow.document) {
        iframeDoc = iframe.contentWindow.document;
        attachActivityListeners(iframeDoc);
      }
    } catch (e) {
      iframeDoc = null;
    }
  }

  /* Check if SCORM element/value indicates completion. */
  function isCompletionElement(element, value) {
    if (!apiAdapter) return false;
    var val = String(value).toLowerCase();
    if (apiAdapter.is2004) {
      if (element === 'cmi.completion_status') return val === 'completed';
      if (element === 'cmi.success_status')
        return val === 'passed' || val === 'failed';
      return false;
    }
    if (element === 'cmi.core.lesson_status') {
      return val === 'completed' || val === 'passed' || val === 'failed';
    }
    return false;
  }

  function isCompletionValue(value) {
    if (value === null || typeof value === 'undefined') return false;
    var val = String(value).toLowerCase();
    return val === 'completed' || val === 'passed' || val === 'failed';
  }

  function readCompletionFromLms() {
    if (!apiAdapter || !apiAdapter.original.getValue) return null;
    if (apiAdapter.is2004) {
      var completion = getScormValue('cmi.completion_status');
      var success = getScormValue('cmi.success_status');
      if (isCompletionValue(completion) || isCompletionValue(success)) return true;
      if (completion || success) return false;
      return null;
    }
    var status = getScormValue('cmi.core.lesson_status');
    if (isCompletionValue(status)) return true;
    if (status) return false;
    return null;
  }

  function syncCompletionFromLms(source) {
    var completed = readCompletionFromLms();
    if (completed === true) {
      state.courseCompleteSent = true;
      state.courseCompletePending = false;
      persistState(true);
      log('Completion sync', source || 'unknown');
    }
  }

  /* Check if a driver function call implies completion. */
  function isDriverCompletion(name, args) {
    if (name === 'SetReachedEnd' || name === 'SetPassed' || name === 'SetFailed') {
      return true;
    }
    if (name === 'SetStatus') {
      var val = args && args.length ? args[0] : null;
      if (typeof val === 'string') {
        var norm = val.toLowerCase();
        return norm === 'completed' || norm === 'passed' || norm === 'failed';
      }
      if (typeof val === 'number') {
        if (typeof window.LESSON_STATUS_PASSED !== 'undefined' && val === window.LESSON_STATUS_PASSED) return true;
        if (typeof window.LESSON_STATUS_COMPLETED !== 'undefined' && val === window.LESSON_STATUS_COMPLETED) return true;
        if (typeof window.LESSON_STATUS_FAILED !== 'undefined' && val === window.LESSON_STATUS_FAILED) return true;
      }
    }
    return false;
  }

  /* Intercept SCORM SetValue to gate completion. */
  function wrapScormSetValue() {
    if (!apiAdapter) return;
    var methodName = apiAdapter.method.setValue;
    var original = apiAdapter.original.setValue;

    apiAdapter.api[methodName] = function (element, value) {
      var el = String(element);
      var isCompletion = isCompletionElement(el, value);
      apiInitialized = true;
      if (pendingInitHydrate) {
        pendingInitHydrate = false;
        hydrateFromStorage();
      }
      if (
        config.enforceCompletion &&
        !replayingScorm &&
        !state.minMetAt &&
        isCompletion
      ) {
        if (!state.pendingScorm) state.pendingScorm = {};
        state.pendingScorm[el] = value;
        state.courseCompletePending = true;
        persistState(true);
        log('Gated completion status', el, value);
        return 'true';
      }
      if (isCompletion) {
        state.courseCompleteSent = true;
        state.courseCompletePending = false;
        persistState(true);
      }
      return original(el, value);
    };
  }

  /* Intercept driver functions used by Rise to report completion. */
  function wrapDriverFunctions() {
    if (!driverAdapter || !driverAdapter.originals) return;
    var originals = driverAdapter.originals;
    var names = Object.keys(originals);
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        if (window[name] && window[name][WRAPPED_FLAG]) {
          return;
        }
        window[name] = function () {
          var args = ([]).slice.call(arguments);
          var isCompletion = isDriverCompletion(name, args);
          if (
            config.enforceCompletion &&
            !replayingScorm &&
            !state.minMetAt &&
            isCompletion
          ) {
            if (!state.pendingDriverCalls) state.pendingDriverCalls = [];
            state.pendingDriverCalls.push({ name: name, args: args });
            state.courseCompletePending = true;
            persistState(true);
            log('Gated driver completion', name, args);
            return true;
          }
          if (isCompletion) {
            state.courseCompleteSent = true;
            state.courseCompletePending = false;
            persistState(true);
          }
          return originals[name].apply(window, args);
        };
        window[name][WRAPPED_FLAG] = true;
      })(names[i]);
    }
  }

  /* Replay deferred SCORM completion values. */
  function replayPendingScorm() {
    if (!config.enforceCompletion) return;
    if (!state.pendingScorm) return;
    if (!apiAdapter) return;

    replayingScorm = true;
    var key;
    for (key in state.pendingScorm) {
      if (Object.prototype.hasOwnProperty.call(state.pendingScorm, key)) {
        try {
          apiAdapter.original.setValue(key, state.pendingScorm[key]);
        } catch (e) {
          // ignore
        }
      }
    }
    if (apiAdapter.original.commit) {
      try {
        apiAdapter.original.commit('');
      } catch (e) {
        // ignore
      }
    }
    replayingScorm = false;

    state.pendingScorm = null;
    state.courseCompleteSent = true;
    state.courseCompletePending = false;
    persistState(true);
  }

  /* Replay deferred driver completion calls. */
  function replayPendingDriverCalls() {
    if (!config.enforceCompletion) return;
    if (!state.pendingDriverCalls || !state.pendingDriverCalls.length) return;
    if (!driverAdapter || !driverAdapter.originals) return;

    replayingScorm = true;
    for (var i = 0; i < state.pendingDriverCalls.length; i++) {
      var call = state.pendingDriverCalls[i];
      if (!call || !call.name || !driverAdapter.originals[call.name]) continue;
      try {
        driverAdapter.originals[call.name].apply(window, call.args || []);
      } catch (e) {
        // ignore
      }
    }
    replayingScorm = false;

    state.pendingDriverCalls = null;
    state.courseCompleteSent = true;
    state.courseCompletePending = false;
    persistState(true);
  }

  /* Compute UI state based on timer and activity. */
  function computeUiState() {
    var remaining = Math.max(
      0,
      state.minRequiredSeconds - state.elapsedSeconds,
    );
    var display = formatTime(remaining);
    var pauseReason = getPauseReason();
    var paused = !!pauseReason;
    var locked = !!(config.enforceCompletion && !state.minMetAt);
    var minMet = !!state.minMetAt;
    var sub = '';
    var labelText = 'Time remaining';
    var showLabel = true;
    var stateClass = 'timegate--state-normal';

    if (minMet) {
      display = 'Ensure you\'ve completed all course content before exiting.';
      labelText = 'Time Requirement Met';
      showLabel = true;
      stateClass = 'timegate--state-complete';
    } else if (paused) {
      labelText = 'Idle Timeout';
      sub = '';
      stateClass = 'timegate--state-paused';
    }

    return {
      display: display,
      paused: paused,
      locked: locked,
      complete: minMet,
      sub: sub,
      labelText: labelText,
      showLabel: showLabel,
      stateClass: stateClass,
    };
  }

  /* Advance timer, persist, and render UI. */
  function tick(ui) {
    var now = Date.now();
    var delta = clampDelta(now - lastTickTs);
    lastTickTs = now;

    if (forceExitTriggered) {
      return;
    }

    updateLock();

    evaluateInactivity();

    if (timerStarted && isActive()) {
      state.elapsedSeconds += delta / 1000;
    }

    if (!state.minMetAt && state.elapsedSeconds >= state.minRequiredSeconds) {
      state.minMetAt = new Date().toISOString();
      syncCompletionFromLms('timer-complete');
      replayPendingScorm();
      replayPendingDriverCalls();
    }

    persistState(false);

    var uiState = computeUiState();
    var signature =
      uiState.display +
      '|' +
      uiState.sub +
      '|' +
      (uiState.complete ? '1' : '0') +
      '|' +
      (uiState.paused ? '1' : '0') +
      '|' +
      (uiState.locked ? '1' : '0') +
      '|' +
      uiState.labelText +
      '|' +
      (uiState.showLabel ? '1' : '0') +
      '|' +
      uiState.stateClass +
      '|' +
      uiState.sub;
    if (signature !== lastUiRender) {
      updateUi(ui, uiState);
      lastUiRender = signature;
    }
  }

  /* Start timers, listeners, and periodic checks. */
  function start(ui) {
    attachIframeListeners();
    attachActivityListeners(document);
    document.addEventListener('visibilitychange', trackActivity, true);
    window.addEventListener('focus', trackActivity, true);

    setInterval(function () {
      updateMediaPlaying();
      updateVideoSeekGuards();
    }, MEDIA_SCAN_INTERVAL_MS);

    setInterval(function () {
      tick(ui);
    }, 1000);

    window.addEventListener('pagehide', function () {
      persistState(true);
    });
  }

  /* Initialize Timegate state and UI. */
  function init() {
    apiAdapter = createApiAdapter();
    driverAdapter = createDriverAdapter();

    storage = createStorage();

    state = {
      version: STATE_VERSION,
      courseKey: buildCourseKey(),
      learnerKey: buildLearnerKey(),
      elapsedSeconds: 0,
      minRequiredSeconds: Math.max(
        0,
        Math.floor((config.minRequiredMinutes || 0) * 60),
      ),
      minMetAt: null,
      courseCompleteSent: false,
      courseCompletePending: false,
      pendingScorm: null,
      pendingDriverCalls: null,
    };

    state.storageKey =
      INSTANCE_KEY + '.v1.' + state.courseKey + '.' + state.learnerKey;
    lockKey = INSTANCE_KEY + '.lock.' + state.courseKey;

    var hydrated = hydrateFromStorage();
    pendingInitHydrate = !!(
      apiAdapter &&
      (storage.type === 'suspend_data' || storage.type === 'dual') &&
      !apiInitialized
    );
    syncCompletionFromLms('init');

    if (!state.minMetAt && state.minRequiredSeconds === 0) {
      state.minMetAt = new Date().toISOString();
    }

    if (apiAdapter) {
      wrapScormSetValue();
    }
    if (driverAdapter) {
      wrapDriverFunctions();
    }

    var ui = createUi();
    if (config.launchModalEnabled) {
      ui.root.style.visibility = 'hidden';
    }
    start(ui);
    tick(ui);

    function beginTracking() {
      timerStarted = true;
      lastActivityTs = Date.now();
      lastTickTs = Date.now();
      if (ui && ui.root) ui.root.style.visibility = '';
      log('Timer tracking started');
    }

    if (config.launchModalEnabled) {
      createLaunchModal(beginTracking);
    } else {
      beginTracking();
    }

    log('Timegate initialized', state);
  }

  loadConfig(function (loaded) {
    config = loaded;
    init();
  });
})();
