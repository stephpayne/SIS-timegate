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
    maxAllowedMinutes: null,
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
  var OBSERVABILITY_METRICS_INTERVAL_MS = 5000;
  var COMPLETION_RETRY_INTERVAL_MS = 5000;
  var CONFIG_LOAD_TIMEOUT_MS = 10000;

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
  var apiTerminated = false;
  var bootstrapGate = null;
  var pendingInitHydrate = false;
  var replayingScorm = false;
  var lastCompletionReplayTs = 0;
  var tabId = String(Math.random()).slice(2);
  var lockKey = null;
  var driverAdapter = null;
  var timerStarted = false;
  var forceExitTriggered = false;
  var forcedTerminationReason = '';
  var lastTerminationAttemptTs = 0;
  var warningEl = null;
  var gentleNudgeEl = null;
  var walkBackEl = null;
  var launchModalEl = null;
  var observedPauseReason = '';
  var observedPauseSinceTs = null;
  var observedIdleSeconds = 0;
  var lastMetricsEventTs = 0;
  var persistenceFailureActive = false;
  var minimumTimeEventSent = false;
  var maximumTimeEventSent = false;
  var maximumExitFinalized = false;
  var configurationBlocked = false;

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

  /*
   * Publish a narrow, privacy-safe event stream for optional observability.
   * Event construction and dispatch are fully guarded so a listener (or an
   * older browser without CustomEvent) can never affect Timegate behavior.
   */
  function emitTimegateEvent(type, detail) {
    try {
      var payload = {
        version: 1,
        type: String(type || ''),
        occurredAt: new Date().toISOString()
      };
      var key;
      if (detail && typeof detail === 'object') {
        for (key in detail) {
          if (Object.prototype.hasOwnProperty.call(detail, key)) {
            payload[key] = detail[key];
          }
        }
      }
      var event;
      if (typeof window.CustomEvent === 'function') {
        event = new window.CustomEvent('sis:timegate', { detail: payload });
      } else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('sis:timegate', false, false, payload);
      }
      document.dispatchEvent(event);
    } catch (e) {
      // Observability is strictly fail-open.
    }
  }

  function currentObservedIdleSeconds(timestamp) {
    var total = observedIdleSeconds;
    if (observedPauseReason && observedPauseSinceTs !== null) {
      total += Math.max(0, (timestamp - observedPauseSinceTs) / 1000);
    }
    return total;
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

  /* Validate configuration without allowing malformed values to disable gates. */
  function normalizeTimeLimits(loaded) {
    var normalized = mergeConfig(DEFAULT_CONFIG, loaded || {});
    var errors = [];
    var numericRules = {
      minRequiredMinutes: 0,
      idleTimeoutSeconds: 0,
      backgroundGraceSeconds: 0,
      inactivityForceExitMinutes: 0,
      inactivityWarningSeconds: 0,
      gentleNudgeSeconds: 0
    };
    var numericMaximums = {
      minRequiredMinutes: 600,
      idleTimeoutSeconds: 3600,
      backgroundGraceSeconds: 3600,
      inactivityForceExitMinutes: 240,
      inactivityWarningSeconds: 600,
      gentleNudgeSeconds: 600
    };
    var key;

    if (loaded && !loaded.configLoadError) {
      if (!Object.prototype.hasOwnProperty.call(loaded, 'minRequiredMinutes')) {
        errors.push('minRequiredMinutes is required');
      }
      for (key in loaded) {
        if (!Object.prototype.hasOwnProperty.call(loaded, key)) continue;
        if (
          !Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key) &&
          key !== 'courseKey'
        ) {
          errors.push('Unknown configuration field: ' + key);
        }
      }
    }

    for (key in numericRules) {
      if (!Object.prototype.hasOwnProperty.call(numericRules, key)) continue;
      var rawNumericValue = normalized[key];
      var numericValue = rawNumericValue;
      if (
        rawNumericValue === null ||
        rawNumericValue === '' ||
        typeof rawNumericValue !== 'number' ||
        !isFinite(numericValue) ||
        numericValue < numericRules[key]
      ) {
        errors.push(key + ' must be a finite non-negative number');
      } else if (numericValue > numericMaximums[key]) {
        errors.push(key + ' exceeds the supported maximum');
      } else {
        normalized[key] = numericValue;
      }
    }
    if (normalized.idleTimeoutSeconds <= 0) {
      errors.push('idleTimeoutSeconds must be greater than zero');
    }
    if (normalized.inactivityForceExitMinutes <= 0) {
      errors.push('inactivityForceExitMinutes must be greater than zero');
    }

    var rawMax = normalized.maxAllowedMinutes;
    if (rawMax === null) {
      normalized.maxAllowedMinutes = null;
    } else {
      var maxMinutes = rawMax;
      if (
        typeof rawMax !== 'number' ||
        !isFinite(maxMinutes) ||
        maxMinutes > 600 ||
        maxMinutes <= normalized.minRequiredMinutes
      ) {
        errors.push(
          'maxAllowedMinutes must be at most 600 and greater than minRequiredMinutes'
        );
        normalized.maxAllowedMinutes = null;
      } else {
        normalized.maxAllowedMinutes = maxMinutes;
      }
    }

    var booleanKeys = [
      'enforceCompletion',
      'countWhileMediaPlaying',
      'hideWhenComplete',
      'debug',
      'inactivityForceExitEnabled',
      'gentleNudgeEnabled',
      'launchModalEnabled',
      'disableVideoSkip'
    ];
    for (var i = 0; i < booleanKeys.length; i++) {
      key = booleanKeys[i];
      if (typeof normalized[key] !== 'boolean') {
        errors.push(key + ' must be true or false');
      }
    }

    if (
      normalized.position !== 'bottom-left' &&
      normalized.position !== 'bottom-right'
    ) {
      errors.push('position must be bottom-left or bottom-right');
    }
    if (
      normalized.storageMode !== 'dual' &&
      normalized.storageMode !== 'localStorage' &&
      normalized.storageMode !== 'suspend_data'
    ) {
      errors.push('storageMode must be dual, localStorage, or suspend_data');
    }
    if (Object.prototype.hasOwnProperty.call(normalized, 'courseKey')) {
      if (
        typeof normalized.courseKey !== 'string' ||
        normalized.courseKey.trim() === ''
      ) {
        errors.push('courseKey must be a non-empty string when provided');
      } else if (normalized.courseKey.length > 256) {
        errors.push('courseKey must not exceed 256 characters');
      }
    }

    if (loaded && loaded.configLoadError) {
      errors.unshift(String(loaded.configLoadError));
    }
    if (errors.length) {
      normalized.configLoadError = errors.join('; ');
      normalized.enforceCompletion = true;
    } else {
      delete normalized.configLoadError;
    }
    return normalized;
  }

  function hasMaximumTimeLimit() {
    return !!(
      state &&
      typeof state.maxAllowedSeconds === 'number' &&
      isFinite(state.maxAllowedSeconds) &&
      state.maxAllowedSeconds > 0
    );
  }

  function isMaximumTimeReached() {
    return !!(
      hasMaximumTimeLimit() &&
      state.elapsedSeconds >= state.maxAllowedSeconds
    );
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

  function failedConfig(message) {
    return mergeConfig(DEFAULT_CONFIG, {
      configLoadError: message || 'Timegate configuration could not be loaded',
      enforceCompletion: true
    });
  }

  /* Load config from global or JSON file. The bootstrap gate stays closed. */
  function loadConfig(done) {
    if (typeof window.TIMEGATE_CONFIG !== 'undefined') {
      if (
        window.TIMEGATE_CONFIG &&
        typeof window.TIMEGATE_CONFIG === 'object' &&
        !Array.isArray(window.TIMEGATE_CONFIG)
      ) {
        done(window.TIMEGATE_CONFIG);
      } else {
        done(failedConfig('window.TIMEGATE_CONFIG must be an object'));
      }
      return;
    }

    var baseUrl = getScriptBaseUrl();
    var configUrl =
      baseUrl ?
        baseUrl + 'timegate.config.json'
      : 'timegate/timegate.config.json'; // fallback only; normally resolved relative to this script's URL

    try {
      var xhr = new XMLHttpRequest();
      var settled = false;
      var timeoutId = null;
      var finish = function (value) {
        if (settled) return;
        settled = true;
        if (timeoutId) window.clearTimeout(timeoutId);
        done(value);
      };
      timeoutId = window.setTimeout(function () {
        try { xhr.abort(); } catch (e) { /* ignore */ }
        finish(failedConfig('timegate.config.json did not load in time'));
      }, CONFIG_LOAD_TIMEOUT_MS);
      xhr.open('GET', configUrl, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status >= 200 && xhr.status < 300) {
          var parsed = safeJsonParse(stripJsonComments(xhr.responseText));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            finish(failedConfig('timegate.config.json is not valid JSON'));
            return;
          }
          finish(parsed);
        } else {
          finish(failedConfig(
            'timegate.config.json could not be loaded (HTTP ' + xhr.status + ')'
          ));
        }
      };
      xhr.onerror = function () {
        finish(failedConfig('timegate.config.json could not be loaded'));
      };
      xhr.send(null);
    } catch (e) {
      done(failedConfig('timegate.config.json could not be loaded'));
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

    var live = document.createElement('div');
    live.className = 'timegate-live';
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');

    var label = document.createElement('div');
    label.className = 'timegate-label';
    label.textContent = 'Time remaining';

    var time = document.createElement('div');
    time.className = 'timegate-time';
    time.textContent = '0:00';

    var sub = document.createElement('div');
    sub.className = 'timegate-sub';
    sub.textContent = '';

    var helpWrap = document.createElement('div');
    helpWrap.className = 'timegate-help-wrap';

    var help = document.createElement('button');
    help.className = 'timegate-help-button';
    help.type = 'button';
    help.textContent = 'What\'s this?';
    help.setAttribute('aria-expanded', 'false');
    help.setAttribute('aria-controls', 'timegate-help-tooltip');

    var tooltip = document.createElement('div');
    tooltip.id = 'timegate-help-tooltip';
    tooltip.className = 'timegate-help-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    tooltip.textContent =
      'This timer tracks your active time across course visits. You must meet ' +
      'the minimum time and finish the course content. If a maximum is set, ' +
      'the timer then shows how much active time remains before the session ends.';

    function setHelpOpen(open) {
      help.setAttribute('aria-expanded', open ? 'true' : 'false');
      tooltip.hidden = !open;
    }

    help.onclick = function () {
      setHelpOpen(help.getAttribute('aria-expanded') !== 'true');
    };
    help.onkeydown = function (event) {
      if (event.key === 'Escape' || event.keyCode === 27) {
        setHelpOpen(false);
      }
    };
    help.onblur = function () { setHelpOpen(false); };

    card.appendChild(close);
    live.appendChild(label);
    live.appendChild(time);
    live.appendChild(sub);
    card.appendChild(live);
    helpWrap.appendChild(help);
    helpWrap.appendChild(tooltip);
    card.appendChild(helpWrap);
    root.appendChild(card);

    document.body.appendChild(root);

    return {
      root: root,
      close: close,
      label: label,
      time: time,
      sub: sub,
    };
  }

  /* Animate the modal's sample timer into the corner where the live timer stays. */
  function startTimerHandoff(source, targetRoot) {
    if (
      !source ||
      !targetRoot ||
      typeof targetRoot.querySelector !== 'function'
    ) return null;
    var target = targetRoot.querySelector('.timegate-preview-card');
    if (!target) return null;

    var reducedMotion = false;
    try {
      reducedMotion = !!(
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (e) {
      reducedMotion = false;
    }

    function revealTarget() {
      targetRoot.classList.remove('timegate-preview-awaiting');
      targetRoot.classList.add('timegate-preview-arrived');
    }

    if (reducedMotion || typeof source.animate !== 'function') {
      revealTarget();
      return null;
    }

    var sourceRect = source.getBoundingClientRect();
    var targetRect = target.getBoundingClientRect();
    if (!sourceRect.width || !sourceRect.height || !targetRect.width) {
      revealTarget();
      return null;
    }

    var clone = source.cloneNode(true);
    clone.id = 'timegate-handoff-clone';
    clone.className = source.className + ' timegate-handoff-clone';
    clone.setAttribute('aria-hidden', 'true');
    clone.style.left = sourceRect.left + 'px';
    clone.style.top = sourceRect.top + 'px';
    clone.style.width = sourceRect.width + 'px';
    document.body.appendChild(clone);

    var deltaX = targetRect.left - sourceRect.left;
    var deltaY = targetRect.top - sourceRect.top;
    var targetScale = targetRect.width / sourceRect.width;
    var destinationTransform =
      'translate3d(' + deltaX + 'px, ' + deltaY + 'px, 0) ' +
      'scale(' + targetScale + ')';
    var animation;
    try {
      animation = clone.animate([
        {
          opacity: 0.96,
          transform: 'translate3d(0, 0, 0) scale(1)'
        },
        {
          offset: 0.82,
          opacity: 0.88,
          transform: destinationTransform
        },
        {
          opacity: 0,
          transform: destinationTransform
        }
      ], {
        duration: 1100,
        easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)',
        fill: 'forwards'
      });
    } catch (e) {
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      revealTarget();
      return null;
    }

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      if (clone.parentNode) clone.parentNode.removeChild(clone);
      revealTarget();
    }
    animation.onfinish = finish;
    animation.oncancel = finish;

    return {
      cancel: function () {
        try { animation.cancel(); } catch (e) { finish(); }
      }
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

    if (hasMaximumTimeLimit()) {
      p1.textContent +=
        ' This course allows up to ' +
        formatTime(state.maxAllowedSeconds) +
        ' of active time.';
    }

    var p2 = document.createElement('p');
    p2.textContent =
      'Take your time, read carefully, and engage with the material. ' +
      'Pacing yourself supports better understanding and retention. It also ensures your training counts.';

    body.appendChild(p1);
    body.appendChild(p2);

    var guide = document.createElement('div');
    guide.className = 'timegate-launch-guide';

    var guideCopy = document.createElement('div');
    guideCopy.className = 'timegate-launch-guide-copy';

    var guideTitle = document.createElement('div');
    guideTitle.className = 'timegate-launch-guide-title';
    guideTitle.textContent = 'Keep an eye on this timer';

    var guideText = document.createElement('div');
    guideText.className = 'timegate-launch-guide-text';
    guideText.textContent =
      'It moves to the corner and counts down only while you are actively participating.';

    var previewRemaining = state ?
      Math.max(0, state.minRequiredSeconds - Math.floor(state.elapsedSeconds)) : 0;

    var demoCard = document.createElement('div');
    demoCard.className = 'timegate-demo-card';

    var demoLabel = document.createElement('div');
    demoLabel.className = 'timegate-label';
    demoLabel.textContent = 'Time remaining';

    var demoTime = document.createElement('div');
    demoTime.className = 'timegate-time';
    demoTime.textContent = formatTime(previewRemaining);

    guideCopy.appendChild(guideTitle);
    guideCopy.appendChild(guideText);
    demoCard.appendChild(demoLabel);
    demoCard.appendChild(demoTime);
    guide.appendChild(guideCopy);
    guide.appendChild(demoCard);
    body.appendChild(guide);

    /* Preview timer widget — pulses in corner during modal to show learner where the timer will live. */
    var previewRoot = document.createElement('div');
    previewRoot.id = 'timegate-modal-preview';
    previewRoot.className = 'timegate-preview-awaiting';
    if (config && config.position === 'bottom-left') {
      previewRoot.className += ' timegate--bottom-left';
    }

    var previewCard = document.createElement('div');
    previewCard.className = 'timegate-preview-card';

    var previewLabel = document.createElement('div');
    previewLabel.className = 'timegate-label';
    previewLabel.textContent = 'Time remaining';

    var previewTime = document.createElement('div');
    previewTime.className = 'timegate-time';
    previewTime.textContent = formatTime(previewRemaining);

    previewCard.appendChild(previewLabel);
    previewCard.appendChild(previewTime);
    previewRoot.appendChild(previewCard);
    document.body.appendChild(previewRoot);

    var handoff = null;

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
      if (handoff && typeof handoff.cancel === 'function') handoff.cancel();
      launchModalEl = null;
      if (typeof onAcknowledge === 'function') onAcknowledge();
      var liveCard = document.querySelector('#timegate-root .timegate-card');
      if (liveCard) {
        liveCard.classList.add('timegate-card-attention');
        setTimeout(function () {
          liveCard.classList.remove('timegate-card-attention');
        }, 1400);
      }
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

    handoff = startTimerHandoff(demoCard, previewRoot);

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
  function showWalkBackOverlay(titleText, messageText) {
    if (walkBackEl) return;

    var overlay = document.createElement('div');
    overlay.id = 'timegate-walkback';
    overlay.className = 'timegate-walkback';

    var card = document.createElement('div');
    card.className = 'timegate-walkback-card';

    var title = document.createElement('div');
    title.className = 'timegate-walkback-title';
    title.id = 'timegate-walkback-title';
    title.textContent = titleText || 'Session ended due to inactivity';

    var msg = document.createElement('p');
    msg.className = 'timegate-walkback-msg';
    msg.textContent = messageText ||
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

  function formatScorm12SessionTime(seconds) {
    var hundredths = Math.max(0, Math.round(Number(seconds || 0) * 100));
    var totalSeconds = Math.floor(hundredths / 100);
    var fraction = hundredths % 100;
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var secs = totalSeconds % 60;
    var pad2 = function (value) {
      return value < 10 ? '0' + value : String(value);
    };
    var hourText = String(hours);
    while (hourText.length < 4) hourText = '0' + hourText;
    return hourText + ':' + pad2(minutes) + ':' + pad2(secs) + '.' + pad2(fraction);
  }

  function formatScorm2004SessionTime(seconds) {
    var hundredths = Math.max(0, Math.round(Number(seconds || 0) * 100));
    var hours = Math.floor(hundredths / 360000);
    var minutes = Math.floor((hundredths % 360000) / 6000);
    var secs = (hundredths % 6000) / 100;
    return 'PT' + hours + 'H' + minutes + 'M' + secs + 'S';
  }

  function writeSessionTime() {
    if (!apiAdapter || !apiInitialized || apiTerminated) return false;
    var element = apiAdapter.is2004 ?
      'cmi.session_time' : 'cmi.core.session_time';
    var value = apiAdapter.is2004 ?
      formatScorm2004SessionTime(state.sessionSeconds) :
      formatScorm12SessionTime(state.sessionSeconds);
    return setScormValue(element, value);
  }

  function finalizeLmsData(reason) {
    if (!apiAdapter || !apiInitialized || apiTerminated) {
      return { ok: false, sessionTime: false, persistence: false, commit: false };
    }
    var sessionTimeOk = writeSessionTime();
    var exitOk = true;
    if (reason === 'inactivity' || reason === 'maximum') {
      exitOk = setScormValue(
        apiAdapter.is2004 ? 'cmi.exit' : 'cmi.core.exit',
        'suspend'
      );
    }
    var persistenceOk = persistState(true);
    var commitOk = commitScorm();
    var ok = sessionTimeOk && exitOk && persistenceOk && commitOk;
    if (!ok) {
      emitTimegateEvent('lms_operation_failed', {
        reason: reason || 'course',
        operation: 'finalize',
        sessionTime: sessionTimeOk,
        persistence: persistenceOk,
        resultBoolean: commitOk
      });
    }
    return {
      ok: ok,
      sessionTime: sessionTimeOk,
      persistence: persistenceOk,
      commit: commitOk
    };
  }

  function terminateLmsSession(reason, args) {
    if (apiTerminated) return 'true';
    if (!apiAdapter || !apiAdapter.original.terminate || !apiInitialized) {
      return 'false';
    }
    lastTerminationAttemptTs = Date.now();
    var pendingBeforeAttempt = state.pendingTerminate;
    state.pendingTerminate = null;
    var finalization = finalizeLmsData(reason);
    if (!finalization.ok) {
      state.pendingTerminate = pendingBeforeAttempt || {
        requestedAt: new Date().toISOString()
      };
      persistState(true);
      return 'false';
    }
    var result;
    try {
      result = apiAdapter.original.terminate.apply(
        apiAdapter.api,
        args && args.length ? args : ['']
      );
    } catch (e) {
      result = 'false';
    }
    if (scormCallSucceeded(result)) {
      apiTerminated = true;
      apiInitialized = false;
      state.pendingTerminate = null;
      maximumExitFinalized = reason === 'maximum' || maximumExitFinalized;
      emitTimegateEvent('termination_completed', {
        reason: reason || 'course',
        operation: apiAdapter.method.terminate,
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: currentObservedIdleSeconds(Date.now()),
        success: true
      });
    } else {
      state.pendingTerminate = pendingBeforeAttempt || {
        requestedAt: new Date().toISOString()
      };
      persistState(true);
      emitTimegateEvent('lms_operation_failed', {
        reason: reason || 'course',
        operation: apiAdapter.method.terminate
      });
    }
    return result;
  }

  function replayPendingTerminate(reason) {
    if (
      !state ||
      !state.pendingTerminate ||
      state.courseCompletePending ||
      apiTerminated ||
      !apiInitialized
    ) return;
    terminateLmsSession(reason === 'maximum' ? 'maximum' : 'course', ['']);
  }

  /* Terminate the SCORM session and show walk-back overlay. */
  function triggerForceExit() {
    if (!forceExitTriggered) {
      forceExitTriggered = true;
      forcedTerminationReason = 'inactivity';
      log('Force exit triggered due to inactivity');
      emitTimegateEvent('forced_exit', {
        reason: 'inactivity',
        activeSeconds: state ? Math.floor(state.elapsedSeconds || 0) : 0,
        idleSeconds: currentObservedIdleSeconds(Date.now()),
        durationSeconds: Math.max(0, (Date.now() - lastActivityTs) / 1000)
      });
    }

    if (!apiTerminated && apiInitialized) {
      terminateLmsSession('inactivity', ['']);
    }

    hideWarning();
    hideGentleNudge();
    showWalkBackOverlay();
  }

  /* Persist and lock the course when cumulative active time reaches its cap. */
  function triggerMaximumTimeExit(reason) {
    if (!isMaximumTimeReached()) return;
    if (state.elapsedSeconds > state.maxAllowedSeconds) {
      state.elapsedSeconds = state.maxAllowedSeconds;
    }
    if (!state.maxReachedAt) state.maxReachedAt = new Date().toISOString();

    if (!maximumTimeEventSent) {
      maximumTimeEventSent = true;
      emitTimegateEvent('maximum_time_reached', {
        reason: reason || 'timer',
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: currentObservedIdleSeconds(Date.now()),
        limitSeconds: state.maxAllowedSeconds
      });
    }

    forceExitTriggered = true;
    forcedTerminationReason = 'maximum';
    clearPendingCompletion();
    persistState(true);
    if (!maximumExitFinalized && !apiTerminated && apiInitialized) {
      terminateLmsSession('maximum', ['']);
    }
    hideWarning();
    hideGentleNudge();
    showWalkBackOverlay(
      'Maximum course time reached',
      'You have reached the maximum active time allowed for this course. ' +
      'Please close this window and contact your training administrator if you need another attempt.'
    );
  }

  /* Evaluate inactivity thresholds; show warning or trigger force exit. */
  function evaluateInactivity() {
    if (!config.inactivityForceExitEnabled) return;
    if (forceExitTriggered) return;
    if (!timerStarted) return;

    /*
     * The inactivity clock only runs while the tab is visible. In a hidden
     * tab the nudge and countdown warnings cannot be seen, so force-exiting
     * from there reads as a crash when the learner returns. Seat time is
     * already paused for hidden tabs (background pause), so pausing the
     * force-exit clock here gives up no seat-time protection.
     */
    if (document.hidden) {
      lastActivityTs = Date.now();
      hideWarning();
      hideGentleNudge();
      return;
    }

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
    if (config.hideWhenComplete && complete && !hasMaximumTimeLimit()) {
      nextClass += ' timegate--hidden';
    }

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

  function isTerminalStatusForVersion(is2004, element, value) {
    var el = String(element || '');
    var val = String(value || '').toLowerCase();
    if (is2004) {
      if (el === 'cmi.completion_status') return val === 'completed';
      if (el === 'cmi.success_status') {
        return val === 'passed' || val === 'failed';
      }
      return false;
    }
    return el === 'cmi.core.lesson_status' && (
      val === 'completed' || val === 'passed' || val === 'failed'
    );
  }

  function isNonterminalStatusForVersion(is2004, element, value) {
    var el = String(element || '');
    var val = String(value || '').toLowerCase();
    if (is2004) {
      if (el === 'cmi.completion_status') {
        return val === 'incomplete' || val === 'not attempted' || val === 'unknown';
      }
      if (el === 'cmi.success_status') return val === 'unknown';
      return false;
    }
    return el === 'cmi.core.lesson_status' && (
      val === 'incomplete' || val === 'not attempted' || val === 'browsed'
    );
  }

  function isCanonicalStatusForVersion(is2004, element) {
    var el = String(element || '');
    return is2004 ?
      el === 'cmi.completion_status' :
      el === 'cmi.core.lesson_status';
  }

  function objectHasKeys(value) {
    if (!value || typeof value !== 'object') return false;
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return true;
    }
    return false;
  }

  /*
   * Install a minimal gate synchronously, before the asynchronous config read.
   * This closes the launch-order window where Rise could report completion and
   * terminate the LMS session before the full runtime was ready.
   */
  function installBootstrapGate() {
    var info = findApi(window);
    if (!info || !info.api) return null;
    var api = info.api;
    var is2004 = info.version === '2004';
    var method = {
      initialize: is2004 ? 'Initialize' : 'LMSInitialize',
      terminate: is2004 ? 'Terminate' : 'LMSFinish',
      setValue: is2004 ? 'SetValue' : 'LMSSetValue'
    };
    if (typeof api[method.setValue] !== 'function') return null;

    var gate = {
      active: true,
      api: api,
      is2004: is2004,
      method: method,
      initialized: false,
      terminated: false,
      pendingScorm: {},
      pendingTerminate: null,
      original: {
        initialize:
          typeof api[method.initialize] === 'function' ?
            api[method.initialize].bind(api) : null,
        terminate:
          typeof api[method.terminate] === 'function' ?
            api[method.terminate].bind(api) : null,
        setValue: api[method.setValue].bind(api)
      }
    };

    if (gate.original.initialize) {
      api[method.initialize] = function () {
        var result = gate.original.initialize.apply(api, arguments);
        if (scormCallSucceeded(result)) gate.initialized = true;
        return result;
      };
    }
    api[method.setValue] = function (element, value) {
      if (!gate.active) return gate.original.setValue(element, value);
      var el = String(element);
      if (isTerminalStatusForVersion(is2004, el, value)) {
        gate.pendingScorm[el] = value;
        emitTimegateEvent('completion_gated', {
          reason: 'runtime_initializing',
          completionStatus: String(value).slice(0, 40),
          success: true,
          activeSeconds: 0,
          idleSeconds: 0
        });
        return 'true';
      }
      if (isNonterminalStatusForVersion(is2004, el, value)) {
        var resetResult = gate.original.setValue(el, value);
        if (scormCallSucceeded(resetResult)) {
          delete gate.pendingScorm[el];
          emitTimegateEvent('completion_reset', {
            reason: 'status_reset',
            completionStatus: String(value).slice(0, 40),
            canonicalCompletion: isCanonicalStatusForVersion(is2004, el),
            activeSeconds: 0,
            idleSeconds: 0
          });
        }
        return resetResult;
      }
      return gate.original.setValue(el, value);
    };
    if (gate.original.terminate) {
      api[method.terminate] = function () {
        if (gate.active && objectHasKeys(gate.pendingScorm)) {
          gate.pendingTerminate = Array.prototype.slice.call(arguments);
          emitTimegateEvent('termination_deferred', {
            reason: 'completion_pending',
            success: true,
            activeSeconds: 0,
            idleSeconds: 0
          });
          return 'true';
        }
        var result = gate.original.terminate.apply(api, arguments);
        if (scormCallSucceeded(result)) gate.terminated = true;
        return result;
      };
    }

    /*
     * A course can report completion and Finish before configuration finishes
     * loading. If the page then unloads, the full runtime has not installed its
     * lifecycle listener or durable state yet. End that LMS session without
     * forwarding the gated completion; otherwise the acknowledged Finish is
     * lost with the page.
     */
    window.addEventListener('pagehide', function (event) {
      if (
        !gate.active ||
        gate.terminated ||
        !gate.pendingTerminate ||
        !gate.original.terminate ||
        (event && event.persisted === true)
      ) return;

      var args = gate.pendingTerminate;
      var result;
      try {
        result = gate.original.terminate.apply(
          api,
          args.length ? args : ['']
        );
      } catch (e) {
        result = 'false';
      }
      if (scormCallSucceeded(result)) {
        gate.terminated = true;
        gate.initialized = false;
        gate.pendingTerminate = null;
        emitTimegateEvent('termination_completed', {
          reason: 'course',
          operation: method.terminate,
          activeSeconds: 0,
          idleSeconds: 0,
          success: true
        });
      } else {
        emitTimegateEvent('lms_operation_failed', {
          reason: 'course',
          operation: method.terminate
        });
      }
    }, true);
    return gate;
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

    var boot = bootstrapGate && bootstrapGate.api === api ? bootstrapGate : null;
    var adapter = {
      api: api,
      is2004: is2004,
      method: method,
      original: {
        initialize:
          boot ? boot.original.initialize :
            (api[method.initialize] ? api[method.initialize].bind(api) : null),
        terminate:
          boot ? boot.original.terminate :
            (api[method.terminate] ? api[method.terminate].bind(api) : null),
        getValue: api[method.getValue] ? api[method.getValue].bind(api) : null,
        setValue: boot ? boot.original.setValue : api[method.setValue].bind(api),
        commit: api[method.commit] ? api[method.commit].bind(api) : null,
      },
    };

    if (boot) {
      boot.active = false;
      apiInitialized = !!boot.initialized;
      apiTerminated = !!boot.terminated;
    }

    if (adapter.original.initialize) {
      api[method.initialize] = function () {
        var result = adapter.original.initialize.apply(api, arguments);
        var initializeSucceeded = scormCallSucceeded(result);
        if (!initializeSucceeded) {
          emitTimegateEvent('lms_operation_failed', {
            reason: 'initialize',
            operation: method.initialize
          });
          return result;
        }
        apiInitialized = true;
        apiTerminated = false;
        refreshLearnerIdentity();
        if (pendingInitHydrate) {
          pendingInitHydrate = false;
          hydrateFromStorage();
        }
        syncCompletionFromLms('initialize');
        if (isMaximumTimeReached()) {
          triggerMaximumTimeExit('hydrated');
          return result;
        }
        if (forceExitTriggered && forcedTerminationReason) {
          terminateLmsSession(forcedTerminationReason, ['']);
          return result;
        }
        if (storage && (storage.type === 'suspend_data' || storage.type === 'dual')) {
          persistState(true);
        }
        replayPendingCompletion('initialize');
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
    if (
      !apiAdapter ||
      !apiAdapter.original.getValue ||
      !apiInitialized ||
      apiTerminated
    ) return '';
    try {
      return apiAdapter.original.getValue(element);
    } catch (e) {
      return '';
    }
  }

  /* Write SCORM value safely. */
  function setScormValue(element, value) {
    if (!apiAdapter || !apiInitialized || apiTerminated) return false;
    try {
      return scormCallSucceeded(apiAdapter.original.setValue(element, value));
    } catch (e) {
      return false;
    }
  }

  /* Commit SCORM data safely. */
  function commitScorm() {
    if (
      !apiAdapter ||
      !apiAdapter.original.commit ||
      !apiInitialized ||
      apiTerminated
    ) return false;
    try {
      return scormCallSucceeded(apiAdapter.original.commit(''));
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
    var origin =
      window.location && window.location.origin ? window.location.origin : '';
    return origin + '|' + (path || 'course') + '|' + title;
  }

  /* Resolve learner identity only after the LMS accepts Initialize. */
  function buildLearnerKey() {
    if (!apiInitialized || apiTerminated) return null;
    var id = '';
    if (apiAdapter && apiAdapter.original.getValue) {
      if (apiAdapter.is2004) {
        id = getScormValue('cmi.learner_id');
      } else {
        id = getScormValue('cmi.core.student_id');
      }
    }
    id = String(id || '').trim();
    return id || null;
  }

  function readEntryMode() {
    if (!apiInitialized || apiTerminated) return '';
    var value = getScormValue(
      apiAdapter && apiAdapter.is2004 ? 'cmi.entry' : 'cmi.core.entry'
    );
    return String(value || '').toLowerCase();
  }

  function refreshLearnerIdentity() {
    if (!state || !apiInitialized || apiTerminated) return false;
    var resolved = buildLearnerKey();
    if (resolved) state.learnerKey = resolved;
    state.entryMode = readEntryMode();
    state.allowLocalFallback = !!(
      resolved && state.entryMode === 'resume'
    );
    state.storageKey =
      INSTANCE_KEY + '.v1.' + state.courseKey + '.' +
      (resolved || 'unresolved');
    lockKey = resolved ?
      INSTANCE_KEY + '.lock.' + state.courseKey + '.' + resolved : null;
    updateLock();
    return !!resolved;
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
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
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        container = parsed;
      } else {
        // Unsafe to overwrite unknown suspend_data format.
        log('Suspend_data not JSON; skipping write');
        return false;
      }
    }
    var payload = safeJsonParse(serialized);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return false;
    }
    container[SUSPEND_DATA_KEY] = payload;
    var next = safeJsonStringify(container);
    if (!next) return false;
    if (next.length > 3800) {
      log('Suspend_data payload too large; skipping write');
      return false;
    }
    var ok = setScormValue('cmi.suspend_data', next);
    if (!ok) return false;
    return commitScorm();
  }

  /* Choose persistence backend (localStorage or suspend_data). */
  function createStorage() {
    var ls = getLocalStorage();
    var mode = resolveStorageMode();

    if (mode === 'dual' && ls && apiAdapter) {
      return {
        type: 'dual',
        get: function (key) {
          var scormVal = apiInitialized ? readSuspendData() : null;
          if (scormVal) {
            if (storage) storage.lastGetSource = 'suspend_data';
            return scormVal;
          }
          if (state && state.allowLocalFallback && state.learnerKey) {
            try {
              var val = ls.getItem(key);
              if (val) {
                if (storage) storage.lastGetSource = 'localStorage';
                return val;
              }
            } catch (e) {
              // ignore
            }
          }
          if (storage) storage.lastGetSource = 'suspend_data';
          return null;
        },
        set: function (key, value) {
          var localOk = false;
          if (state && state.learnerKey && state.learnerKey !== 'unresolved') {
            try {
              ls.setItem(key, value);
              localOk = true;
            } catch (e) {
              localOk = false;
            }
          }
          var sdOk = apiInitialized && !apiTerminated ?
            writeSuspendData(value) : false;
          log('Persist', {
            backend: 'dual',
            localStorage: localOk,
            suspend_data: apiInitialized ? sdOk : 'deferred',
            bytes: value ? value.length : 0
          });
          return apiInitialized ? sdOk : false;
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
          if (
            !state ||
            !state.allowLocalFallback ||
            !state.learnerKey ||
            state.learnerKey === 'unresolved'
          ) {
            return null;
          }
          try {
            if (storage) storage.lastGetSource = 'localStorage';
            return ls.getItem(key);
          } catch (e) {
            return null;
          }
        },
        set: function (key, value) {
          if (!state || !state.learnerKey || state.learnerKey === 'unresolved') {
            return false;
          }
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
    if (parsed.courseKey && parsed.courseKey !== state.courseKey) return false;
    if (
      storage.lastGetSource === 'localStorage' &&
      parsed.learnerKey !== state.learnerKey
    ) return false;

    var storedElapsed = Number(parsed.elapsedSeconds) || 0;
    if (!isFinite(storedElapsed) || storedElapsed < 0) storedElapsed = 0;
    if (storedElapsed > state.elapsedSeconds) {
      state.elapsedSeconds = storedElapsed;
    }
    if (
      !configurationBlocked &&
      !state.minMetAt &&
      storedElapsed >= state.minRequiredSeconds
    ) {
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
    if (
      !state.pendingTerminate &&
      parsed.pendingTerminate &&
      typeof parsed.pendingTerminate === 'object' &&
      typeof parsed.pendingTerminate.requestedAt === 'string'
    ) {
      state.pendingTerminate = {
        requestedAt: parsed.pendingTerminate.requestedAt
      };
    }
    if (isMaximumTimeReached()) {
      state.elapsedSeconds = state.maxAllowedSeconds;
      state.maxReachedAt = parsed.maxReachedAt || new Date().toISOString();
    } else {
      state.maxReachedAt = null;
    }

    log('Hydrated state', state);
    log('Hydrated from', storage.lastGetSource || storage.type || 'unknown');
    return true;
  }

  /* Persist current state at a controlled cadence. */
  function persistState(force) {
    if (!storage || !state) return false;
    if (lockKey && !isPrimaryTab) {
      if (!persistenceFailureActive) {
        persistenceFailureActive = true;
        emitTimegateEvent('persistence_failed', {
          reason: 'secondary_tab',
          backend: storage.type || 'unknown',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
      }
      return false;
    }
    var now = Date.now();
    if (!force && now - lastPersistTs < PERSIST_INTERVAL_MS) return true;

    var payload = {
      version: STATE_VERSION,
      courseKey: state.courseKey,
      learnerKey: state.learnerKey,
      elapsedSeconds: Math.floor(state.elapsedSeconds || 0),
      minRequiredSeconds: state.minRequiredSeconds,
      maxAllowedSeconds: state.maxAllowedSeconds,
      minMetAt: state.minMetAt,
      maxReachedAt: state.maxReachedAt,
      lastTickTs: now,
      courseCompleteSent: !!state.courseCompleteSent,
      courseCompletePending: !!state.courseCompletePending,
      pendingScorm: state.pendingScorm || null,
      pendingDriverCalls: state.pendingDriverCalls || null,
      pendingTerminate: state.pendingTerminate || null,
    };

    var serialized = safeJsonStringify(payload);
    if (!serialized) return false;
    var ok = storage.set(state.storageKey, serialized);
    if (ok) {
      var recovered = persistenceFailureActive;
      lastPersistTs = now;
      persistenceFailureActive = false;
      if (recovered) {
        emitTimegateEvent('persistence_recovered', {
          reason: 'write_succeeded',
          backend: storage.type || 'unknown',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(now)
        });
      }
    } else {
      var deferredUntilInitialize = !!(
        !apiInitialized && apiAdapter
      );
      if (!deferredUntilInitialize && !persistenceFailureActive) {
        persistenceFailureActive = true;
        emitTimegateEvent('persistence_failed', {
          reason: 'write_failed',
          backend: storage.type || 'unknown',
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(now)
        });
      }
    }
    return !!ok;
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
    var ls = getLocalStorage();
    var wasPrimary = isPrimaryTab;
    if (!lockKey || !ls) {
      isPrimaryTab = true;
      return;
    }
    var now = Date.now();
    var raw = null;
    try { raw = ls.getItem(lockKey); } catch (e) { raw = null; }
    var parsed = raw ? safeJsonParse(raw) : null;
    if (!parsed || !parsed.tabId || now - parsed.ts > LOCK_TTL_MS) {
      try {
        ls.setItem(lockKey, safeJsonStringify({ tabId: tabId, ts: now }));
      } catch (e) {
        isPrimaryTab = true;
        return;
      }
      isPrimaryTab = true;
      if (!wasPrimary && state && storage) {
        var previousLocalFallback = state.allowLocalFallback;
        state.allowLocalFallback = true;
        hydrateFromStorage();
        state.allowLocalFallback = previousLocalFallback;
      }
      return;
    }
    if (parsed.tabId === tabId) {
      try {
        ls.setItem(lockKey, safeJsonStringify({ tabId: tabId, ts: now }));
      } catch (e) {
        // Keep the current lock decision for this tick.
      }
      isPrimaryTab = true;
      return;
    }
    isPrimaryTab = false;
  }

  function releaseLock() {
    if (!lockKey) return;
    var ls = getLocalStorage();
    if (!ls) return;
    try {
      var current = safeJsonParse(ls.getItem(lockKey));
      if (current && current.tabId === tabId) ls.removeItem(lockKey);
    } catch (e) {
      // The lock expires automatically if storage is unavailable during exit.
    }
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

  function handleVisibilityChange() {
    var now = Date.now();
    if (document.hidden) {
      if (backgroundSinceTs === null) backgroundSinceTs = now;
    } else {
      /* Do not treat returning to a frozen/background tab as learner activity. */
      lastTickTs = now;
    }
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

  /* Check if a SCORM element/value is a terminal reporting status. */
  function isCompletionElement(element, value) {
    return !!(
      apiAdapter &&
      isTerminalStatusForVersion(apiAdapter.is2004, element, value)
    );
  }

  function isNonterminalCompletionElement(element, value) {
    return !!(
      apiAdapter &&
      isNonterminalStatusForVersion(apiAdapter.is2004, element, value)
    );
  }

  function isCanonicalCompletionElement(element) {
    if (!apiAdapter) return false;
    return isCanonicalStatusForVersion(apiAdapter.is2004, element);
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
      if (String(completion || '').toLowerCase() === 'completed') return true;
      if (completion) return false;
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
      if (!objectHasKeys(state.pendingScorm)) state.pendingScorm = null;
      updateCompletionPendingFlag();
      persistState(true);
      log('Completion sync', source || 'unknown');
    } else if (completed === false) {
      state.courseCompleteSent = false;
    }
  }

  function updateCompletionPendingFlag() {
    if (!state) return;
    state.courseCompletePending = !!(
      objectHasKeys(state.pendingScorm) ||
      (state.pendingDriverCalls && state.pendingDriverCalls.length)
    );
  }

  function completionGateOpen() {
    return !!(
      state &&
      isPrimaryTab &&
      !configurationBlocked &&
      state.minMetAt &&
      !isMaximumTimeReached()
    );
  }

  function queueScormStatus(element, value) {
    if (!state.pendingScorm) state.pendingScorm = {};
    state.pendingScorm[String(element)] = value;
    updateCompletionPendingFlag();
  }

  function clearPendingCompletion() {
    state.pendingScorm = null;
    state.pendingDriverCalls = null;
    state.courseCompletePending = false;
  }

  function resetPendingScormStatus(element, value) {
    var canonical = isCanonicalCompletionElement(element);
    if (state.pendingScorm) {
      delete state.pendingScorm[element];
      if (!objectHasKeys(state.pendingScorm)) state.pendingScorm = null;
    }
    if (canonical) {
      state.pendingDriverCalls = null;
      state.courseCompleteSent = false;
    }
    updateCompletionPendingFlag();
    persistState(true);
    emitTimegateEvent('completion_reset', {
      reason: 'status_reset',
      completionStatus: String(value).slice(0, 40),
      canonicalCompletion: canonical,
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now())
    });
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

  function isDriverReset(name, args) {
    if (name !== 'SetStatus') return false;
    var value = args && args.length ? args[0] : null;
    if (typeof value === 'string') {
      var normalized = value.toLowerCase();
      return normalized === 'incomplete' ||
        normalized === 'not attempted' ||
        normalized === 'unknown' ||
        normalized === 'browsed';
    }
    if (typeof value !== 'number') return false;
    var resetConstants = [
      'LESSON_STATUS_INCOMPLETE',
      'LESSON_STATUS_NOT_ATTEMPTED',
      'LESSON_STATUS_BROWSED'
    ];
    for (var i = 0; i < resetConstants.length; i++) {
      if (
        typeof window[resetConstants[i]] !== 'undefined' &&
        value === window[resetConstants[i]]
      ) return true;
    }
    return false;
  }

  function driverCallSucceeded(result) {
    if (result === false || result === 0) return false;
    return !(
      typeof result === 'string' && result.toLowerCase() === 'false'
    );
  }

  function confirmDriverCompletion(driverSucceeded) {
    if (!driverSucceeded) {
      return { confirmed: false, committed: false, succeeded: false };
    }
    if (!apiAdapter) {
      return { confirmed: true, committed: true, succeeded: true };
    }
    var confirmed = readCompletionFromLms() === true;
    var committed = confirmed && commitScorm();
    return {
      confirmed: confirmed,
      committed: committed,
      succeeded: confirmed && committed
    };
  }

  /* Intercept SCORM SetValue to gate completion. */
  function wrapScormSetValue() {
    if (!apiAdapter) return;
    var methodName = apiAdapter.method.setValue;
    var original = apiAdapter.original.setValue;

    apiAdapter.api[methodName] = function (element, value) {
      var el = String(element);
      var isCompletion = isCompletionElement(el, value);
      var isReset = isNonterminalCompletionElement(el, value);

      if (apiTerminated) {
        if (isCompletion) {
          emitTimegateEvent('completion_gated', {
            reason: 'lms_session_terminated',
            completionStatus: String(value).slice(0, 40),
            success: false,
            activeSeconds: Math.floor(state.elapsedSeconds || 0),
            idleSeconds: currentObservedIdleSeconds(Date.now())
          });
          return 'false';
        }
        return original(el, value);
      }

      if (isMaximumTimeReached() && isCompletion) {
        triggerMaximumTimeExit('completion_call');
        emitTimegateEvent('completion_gated', {
          reason: 'maximum_time_reached',
          completionStatus: String(value).slice(0, 40),
          success: false,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
        return 'false';
      }

      if (isReset) {
        var resetResult = original(el, value);
        if (scormCallSucceeded(resetResult)) {
          resetPendingScormStatus(el, value);
          replayPendingTerminate('status_reset');
        }
        return resetResult;
      }

      if (
        config.enforceCompletion &&
        !replayingScorm &&
        !completionGateOpen() &&
        isCompletion
      ) {
        queueScormStatus(el, value);
        var queuedDurably = persistState(true);
        log('Gated completion status', el, value);
        emitTimegateEvent('completion_gated', {
          reason: configurationBlocked ?
            'configuration_error' : 'minimum_time_not_met',
          completionStatus:
            typeof value === 'string' ? value.slice(0, 40) : '',
          success: queuedDurably && !configurationBlocked,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
        return queuedDurably && !configurationBlocked ? 'true' : 'false';
      }
      if (isCompletion) {
        queueScormStatus(el, value);
        var setResult = original(el, value);
        var writeSucceeded = scormCallSucceeded(setResult);
        var commitSucceeded = writeSucceeded && commitScorm();
        if (writeSucceeded && commitSucceeded) {
          if (state.pendingScorm) delete state.pendingScorm[el];
          if (!objectHasKeys(state.pendingScorm)) state.pendingScorm = null;
          if (isCanonicalCompletionElement(el)) {
            state.courseCompleteSent = true;
          }
          updateCompletionPendingFlag();
        }
        persistState(true);
        emitTimegateEvent('completion_replayed', {
          reason: 'scorm',
          replayMode: 'direct',
          canonicalCompletion: isCanonicalCompletionElement(el),
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now()),
          completionStatus: String(value).slice(0, 40),
          success: writeSucceeded,
          resultBoolean: commitSucceeded
        });
        if (writeSucceeded && commitSucceeded) {
          replayPendingTerminate('direct_completion');
        }
        return setResult;
      }
      return original(el, value);
    };
  }

  function wrapScormTerminate() {
    if (!apiAdapter || !apiAdapter.original.terminate) return;
    var methodName = apiAdapter.method.terminate;
    apiAdapter.api[methodName] = function () {
      var args = Array.prototype.slice.call(arguments);
      if (apiTerminated) return 'true';
      if (forceExitTriggered && forcedTerminationReason) {
        return terminateLmsSession(forcedTerminationReason, args);
      }
      if (configurationBlocked) {
        clearPendingCompletion();
        persistState(true);
        return terminateLmsSession('course', args);
      }
      if (
        config.enforceCompletion &&
        state.courseCompletePending &&
        !forceExitTriggered
      ) {
        state.pendingTerminate = { requestedAt: new Date().toISOString() };
        var terminateQueuedDurably = persistState(true);
        emitTimegateEvent('termination_deferred', {
          reason: 'completion_pending',
          success: terminateQueuedDurably,
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(Date.now())
        });
        return terminateQueuedDurably ? 'true' : 'false';
      }
      return terminateLmsSession('course', args);
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
          var isReset = isDriverReset(name, args);
          if (isMaximumTimeReached() && isCompletion) {
            triggerMaximumTimeExit('driver_call');
            return false;
          }
          if (isReset) {
            var resetResult = originals[name].apply(window, args);
            if (driverCallSucceeded(resetResult)) {
              clearPendingCompletion();
              state.courseCompleteSent = false;
              persistState(true);
              emitTimegateEvent('completion_reset', {
                reason: 'driver_status_reset',
                completionStatus: name,
                canonicalCompletion: true,
                activeSeconds: Math.floor(state.elapsedSeconds || 0),
                idleSeconds: currentObservedIdleSeconds(Date.now())
              });
              replayPendingTerminate('driver_status_reset');
            }
            return resetResult;
          }
          if (
            config.enforceCompletion &&
            !replayingScorm &&
            !completionGateOpen() &&
            isCompletion
          ) {
            state.pendingDriverCalls = [{ name: name, args: args }];
            updateCompletionPendingFlag();
            var driverQueuedDurably = persistState(true);
            log('Gated driver completion', name, args);
            emitTimegateEvent('completion_gated', {
              reason: 'minimum_time_not_met',
              completionStatus: name,
              success: driverQueuedDurably,
              activeSeconds: Math.floor(state.elapsedSeconds || 0),
              idleSeconds: currentObservedIdleSeconds(Date.now())
            });
            return driverQueuedDurably;
          }
          if (isCompletion) {
            state.pendingDriverCalls = [{ name: name, args: args }];
            updateCompletionPendingFlag();
            var result = originals[name].apply(window, args);
            var confirmation = confirmDriverCompletion(
              driverCallSucceeded(result)
            );
            if (confirmation.succeeded) {
              state.pendingDriverCalls = null;
              state.courseCompleteSent = true;
              updateCompletionPendingFlag();
            }
            persistState(true);
            emitTimegateEvent('completion_replayed', {
              reason: 'rise_driver',
              replayMode: 'direct',
              activeSeconds: Math.floor(state.elapsedSeconds || 0),
              idleSeconds: currentObservedIdleSeconds(Date.now()),
              completionStatus: name,
              canonicalCompletion: true,
              success: confirmation.succeeded,
              resultBoolean: confirmation.committed
            });
            if (!state.courseCompletePending) {
              replayPendingTerminate('direct_driver_completion');
            }
            return result;
          }
          return originals[name].apply(window, args);
        };
        window[name][WRAPPED_FLAG] = true;
      })(names[i]);
    }
  }

  /* Replay deferred SCORM completion values. */
  function scormCallSucceeded(result) {
    if (result === true || result === 1) return true;
    if (typeof result !== 'string') return false;
    var normalized = result.toLowerCase();
    return normalized === 'true' || normalized === '1';
  }

  function replayPendingScorm() {
    if (!config.enforceCompletion) return;
    if (!objectHasKeys(state.pendingScorm)) return;
    if (!apiAdapter || !apiInitialized || apiTerminated) return;
    if (!completionGateOpen()) return;

    var replayCount = 0;
    var writeSucceeded = true;
    var commitSucceeded = !!apiAdapter.original.commit;
    var canonicalCompletionReplayed = false;
    replayingScorm = true;
    var key;
    for (key in state.pendingScorm) {
      if (Object.prototype.hasOwnProperty.call(state.pendingScorm, key)) {
        replayCount += 1;
        if (isCanonicalCompletionElement(key)) {
          canonicalCompletionReplayed = true;
        }
        try {
          var setResult =
            apiAdapter.original.setValue(key, state.pendingScorm[key]);
          if (!scormCallSucceeded(setResult)) writeSucceeded = false;
        } catch (e) {
          writeSucceeded = false;
        }
      }
    }
    if (apiAdapter.original.commit) {
      try {
        commitSucceeded =
          scormCallSucceeded(apiAdapter.original.commit(''));
      } catch (e) {
        commitSucceeded = false;
      }
    }
    replayingScorm = false;

    var succeeded = writeSucceeded && commitSucceeded;
    if (succeeded) {
      state.pendingScorm = null;
      if (canonicalCompletionReplayed) state.courseCompleteSent = true;
      updateCompletionPendingFlag();
    } else {
      updateCompletionPendingFlag();
    }
    persistState(true);
    emitTimegateEvent('completion_replayed', {
      reason: 'scorm',
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now()),
      completionStatus: replayCount ? 'replayed' : 'none',
      canonicalCompletion: canonicalCompletionReplayed,
      success: writeSucceeded,
      resultBoolean: commitSucceeded
    });
    if (succeeded) replayPendingTerminate('scorm_replay');
  }

  /* Replay deferred driver completion calls. */
  function replayPendingDriverCalls() {
    if (!config.enforceCompletion) return;
    if (!state.pendingDriverCalls || !state.pendingDriverCalls.length) return;
    if (!driverAdapter || !driverAdapter.originals) return;
    if (!completionGateOpen() || apiTerminated) return;

    var replayCount = state.pendingDriverCalls.length;
    var replaySucceeded = true;
    replayingScorm = true;
    for (var i = 0; i < state.pendingDriverCalls.length; i++) {
      var call = state.pendingDriverCalls[i];
      if (!call || !call.name || !driverAdapter.originals[call.name]) continue;
      try {
        var driverResult =
          driverAdapter.originals[call.name].apply(window, call.args || []);
        if (!driverCallSucceeded(driverResult)) replaySucceeded = false;
      } catch (e) {
        replaySucceeded = false;
      }
    }
    replayingScorm = false;

    var confirmation = confirmDriverCompletion(replaySucceeded);
    if (confirmation.succeeded) {
      state.pendingDriverCalls = null;
      state.courseCompleteSent = true;
    }
    updateCompletionPendingFlag();
    persistState(true);
    emitTimegateEvent('completion_replayed', {
      reason: 'rise_driver',
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now()),
      completionStatus: replayCount ? 'replayed' : 'none',
      canonicalCompletion: true,
      success: confirmation.succeeded,
      resultBoolean: confirmation.committed
    });
    if (!state.courseCompletePending) {
      replayPendingTerminate('driver_replay');
    }
  }

  function replayPendingCompletion(reason) {
    if (!state || !completionGateOpen() || apiTerminated) return;
    var now = Date.now();
    if (
      reason === 'timer_retry' &&
      now - lastCompletionReplayTs < COMPLETION_RETRY_INTERVAL_MS
    ) return;
    lastCompletionReplayTs = now;
    replayPendingScorm();
    replayPendingDriverCalls();
  }

  function emitMinimumTimeMet(reason) {
    if (minimumTimeEventSent || !state || !state.minMetAt) return;
    minimumTimeEventSent = true;
    emitTimegateEvent('minimum_time_met', {
      reason: reason || 'timer',
      activeSeconds: Math.floor(state.elapsedSeconds || 0),
      idleSeconds: currentObservedIdleSeconds(Date.now())
    });
  }

  function observePauseTransition(reason, timestamp) {
    var nextReason = reason || '';
    if (nextReason === observedPauseReason) return;
    if (observedPauseReason) {
      var pausedDuration =
        observedPauseSinceTs === null ?
          0 : Math.max(0, (timestamp - observedPauseSinceTs) / 1000);
      observedIdleSeconds += pausedDuration;
      emitTimegateEvent('idle_exited', {
        reason: observedPauseReason,
        durationSeconds: pausedDuration,
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: observedIdleSeconds
      });
    }
    observedPauseReason = nextReason;
    observedPauseSinceTs = nextReason ? timestamp : null;
    if (nextReason) {
      emitTimegateEvent('idle_entered', {
        reason: nextReason,
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: observedIdleSeconds
      });
    }
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

    if (configurationBlocked) {
      display = 'Reporting unavailable';
      labelText = 'Configuration Error';
      sub = 'Close this course and contact your training administrator.';
      stateClass = 'timegate--state-paused';
    } else if (isMaximumTimeReached()) {
      display = 'Maximum time reached';
      labelText = 'Session Ended';
      stateClass = 'timegate--state-paused';
    } else if (minMet && hasMaximumTimeLimit()) {
      display = formatTime(
        Math.max(0, state.maxAllowedSeconds - state.elapsedSeconds)
      );
      labelText = 'Maximum time remaining';
      sub = 'Minimum time requirement met';
      stateClass = 'timegate--state-complete';
    } else if (minMet) {
      display = 'Ensure you\'ve completed all course content before exiting.';
      labelText = 'Time Requirement Met';
      showLabel = true;
      stateClass = 'timegate--state-complete';
    } else if (paused) {
      labelText = 'Idle Timeout';
      sub = '';
      stateClass = 'timegate--state-paused';
    } else if (hasMaximumTimeLimit()) {
      sub = 'Maximum active time: ' + formatTime(state.maxAllowedSeconds);
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
      pauseReason: pauseReason,
    };
  }

  /* Advance timer, persist, and render UI. */
  function tick(ui) {
    var now = Date.now();
    var delta = clampDelta(now - lastTickTs);
    lastTickTs = now;

    if (forceExitTriggered) {
      if (
        forcedTerminationReason &&
        !apiTerminated &&
        apiInitialized &&
        now - lastTerminationAttemptTs >= COMPLETION_RETRY_INTERVAL_MS
      ) {
        terminateLmsSession(forcedTerminationReason, ['']);
      }
      return;
    }

    updateLock();

    evaluateInactivity();
    if (forceExitTriggered) return;

    if (timerStarted && isActive()) {
      var activeDelta = delta / 1000;
      if (hasMaximumTimeLimit()) {
        activeDelta = Math.min(
          activeDelta,
          Math.max(0, state.maxAllowedSeconds - state.elapsedSeconds)
        );
      }
      state.elapsedSeconds += activeDelta;
      state.sessionSeconds += activeDelta;
    }

    if (
      !configurationBlocked &&
      !state.minMetAt &&
      state.elapsedSeconds >= state.minRequiredSeconds
    ) {
      state.minMetAt = new Date().toISOString();
      emitMinimumTimeMet('timer');
      syncCompletionFromLms('timer-complete');
      replayPendingCompletion('minimum_met');
    }

    if (isMaximumTimeReached()) {
      state.elapsedSeconds = state.maxAllowedSeconds;
      triggerMaximumTimeExit('timer');
      return;
    }

    persistState(false);
    replayPendingCompletion('timer_retry');
    replayPendingTerminate('timer_retry');

    var uiState = computeUiState();
    if (timerStarted) {
      observePauseTransition(uiState.pauseReason, now);
      if (
        lastMetricsEventTs === 0 ||
        now - lastMetricsEventTs >= OBSERVABILITY_METRICS_INTERVAL_MS
      ) {
        lastMetricsEventTs = now;
        emitTimegateEvent('metrics', {
          activeSeconds: Math.floor(state.elapsedSeconds || 0),
          idleSeconds: currentObservedIdleSeconds(now)
        });
      }
    }
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
    document.addEventListener('visibilitychange', handleVisibilityChange, true);

    setInterval(function () {
      updateMediaPlaying();
      updateVideoSeekGuards();
    }, MEDIA_SCAN_INTERVAL_MS);

    setInterval(function () {
      tick(ui);
    }, 1000);

    window.addEventListener('pagehide', function () {
      if (!apiInitialized || apiTerminated) {
        persistState(true);
        releaseLock();
        return;
      }
      var sessionTimeOk = writeSessionTime();
      var persistenceOk = persistState(true);
      var commitOk = commitScorm();
      if (!sessionTimeOk || !persistenceOk || !commitOk) {
        emitTimegateEvent('lms_operation_failed', {
          reason: 'course',
          operation: 'finalize',
          sessionTime: sessionTimeOk,
          persistence: persistenceOk,
          resultBoolean: commitOk
        });
      }
      releaseLock();
    }, true);
    window.addEventListener('pageshow', function () {
      lastTickTs = Date.now();
    });
  }

  /* Initialize Timegate state and UI. */
  function init() {
    apiAdapter = createApiAdapter();
    driverAdapter = createDriverAdapter();

    storage = createStorage();
    configurationBlocked = !!config.configLoadError;

    var minRequiredSeconds = Math.max(
      0,
      Math.floor((config.minRequiredMinutes || 0) * 60)
    );
    var maxAllowedSeconds =
      config.maxAllowedMinutes === null ?
        null : Math.floor(config.maxAllowedMinutes * 60);
    if (maxAllowedSeconds !== null && maxAllowedSeconds <= minRequiredSeconds) {
      maxAllowedSeconds = null;
    }

    state = {
      version: STATE_VERSION,
      courseKey: buildCourseKey(),
      learnerKey: 'unresolved',
      entryMode: '',
      allowLocalFallback: false,
      elapsedSeconds: 0,
      sessionSeconds: 0,
      minRequiredSeconds: minRequiredSeconds,
      maxAllowedSeconds: maxAllowedSeconds,
      minMetAt: null,
      maxReachedAt: null,
      courseCompleteSent: false,
      courseCompletePending: false,
      pendingScorm:
        bootstrapGate && objectHasKeys(bootstrapGate.pendingScorm) ?
          bootstrapGate.pendingScorm : null,
      pendingDriverCalls: null,
      pendingTerminate:
        bootstrapGate && bootstrapGate.pendingTerminate ?
          { requestedAt: new Date().toISOString() } : null,
    };

    state.storageKey =
      INSTANCE_KEY + '.v1.' + state.courseKey + '.unresolved';
    updateCompletionPendingFlag();

    var hydrated = false;
    if (apiInitialized && !apiTerminated) {
      refreshLearnerIdentity();
      hydrated = hydrateFromStorage();
    }
    pendingInitHydrate = !!(apiAdapter && !apiInitialized && !apiTerminated);
    syncCompletionFromLms('init');

    if (
      !configurationBlocked &&
      !state.minMetAt &&
      state.minRequiredSeconds === 0
    ) {
      state.minMetAt = new Date().toISOString();
    }
    emitMinimumTimeMet(hydrated ? 'hydrated' : 'initial');

    if (apiAdapter) {
      wrapScormSetValue();
      wrapScormTerminate();
    }
    if (driverAdapter) {
      wrapDriverFunctions();
    }

    var ui = createUi();
    if (
      config.launchModalEnabled &&
      !configurationBlocked &&
      !isMaximumTimeReached()
    ) {
      ui.root.style.visibility = 'hidden';
    }
    start(ui);
    if (configurationBlocked) {
      tick(ui);
      emitTimegateEvent('configuration_failed', {
        reason: config.configLoadError,
        activeSeconds: 0,
        idleSeconds: 0
      });
      showWalkBackOverlay(
        'Course reporting unavailable',
        'Timegate could not verify this course\'s settings, so progress will not ' +
        'be reported as complete. Please close the course and contact your ' +
        'training administrator.'
      );
      if (state.pendingTerminate) {
        clearPendingCompletion();
        persistState(true);
        replayPendingTerminate('configuration_error');
      }
    } else if (isMaximumTimeReached()) {
      triggerMaximumTimeExit(hydrated ? 'hydrated' : 'initial');
    } else {
      tick(ui);
    }

    replayPendingCompletion(hydrated ? 'hydrated' : 'initial');
    replayPendingTerminate('initial');

    function beginTracking() {
      timerStarted = true;
      lastActivityTs = Date.now();
      lastTickTs = Date.now();
      lastMetricsEventTs = lastTickTs;
      if (ui && ui.root) ui.root.style.visibility = '';
      log('Timer tracking started');
      emitTimegateEvent('tracking_started', {
        reason: config.launchModalEnabled ? 'acknowledged' : 'automatic',
        activeSeconds: Math.floor(state.elapsedSeconds || 0),
        idleSeconds: observedIdleSeconds
      });
    }

    if (
      config.launchModalEnabled &&
      !configurationBlocked &&
      !forceExitTriggered
    ) {
      createLaunchModal(beginTracking);
    } else if (!configurationBlocked && !forceExitTriggered) {
      beginTracking();
    }

    log('Timegate initialized', state);
  }

  bootstrapGate = installBootstrapGate();
  loadConfig(function (loaded) {
    config = normalizeTimeLimits(loaded);
    if (document.body) {
      init();
      return;
    }
    document.addEventListener('DOMContentLoaded', function initializeAfterParse() {
      document.removeEventListener(
        'DOMContentLoaded',
        initializeAfterParse,
        false
      );
      init();
    }, false);
  });
})();
