/* Timegate module wrapper and bootstrap. */
(function () {
  'use strict';

  var INSTANCE_KEY = 'timegate-overhaul';
  var LOADED_FLAG = '__timegateOverhaulLoaded';
  var WRAPPED_FLAG = '__timegateOverhaulWrapped';
  var SUSPEND_DATA_KEY = '__timegate_overhaul';

  if (window[LOADED_FLAG]) {
    return;
  }
  window[LOADED_FLAG] = true;

  var DEFAULT_CONFIG = {
    minRequiredMinutes: 0,
    enforceCompletion: false,
    idleTimeoutSeconds: 60,
    backgroundGraceSeconds: 30,
    countWhileMediaPlaying: true,
    hideWhenComplete: false,
    position: 'bottom-right',
    debug: false,
    storageMode: ''
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
      : 'timegate-overhaul/timegate.config.json';

    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', configUrl, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = safeJsonParse(xhr.responseText);
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
      var key = '__timegate_overhaul_test__';
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

  /* Derive learner key from SCORM or anonymous. */
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

  /* Detect active media playback in iframe. */
  function updateMediaPlaying() {
    if (!iframeDoc || !config.countWhileMediaPlaying) {
      mediaPlaying = false;
      return;
    }
    var media = iframeDoc.querySelectorAll('video, audio');
    var playing = false;
    for (var i = 0; i < media.length; i++) {
      var el = media[i];
      if (!el.paused && !el.ended) {
        playing = true;
        break;
      }
    }
    mediaPlaying = playing;
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

    updateLock();

    if (isActive()) {
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
    document.addEventListener('visibilitychange', trackActivity, true);
    window.addEventListener('focus', trackActivity, true);

    setInterval(function () {
      updateMediaPlaying();
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
    start(ui);
    tick(ui);
    log('Timegate initialized', state);
  }

  loadConfig(function (loaded) {
    config = loaded;
    init();
  });
})();
