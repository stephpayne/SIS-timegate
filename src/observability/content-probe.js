/*
 * SIS SCORM Observability — Rise content-frame probe.
 *
 * This probe performs no storage or networking. It forwards a privacy-filtered
 * event stream to the validated parent collector over MessageChannel.
 */
(function () {
  'use strict';

  var LOADED_FLAG = '__sisObservabilityContentProbeLoaded';
  var PROTOCOL_VERSION = 1;
  var MAX_PENDING_EVENTS = 100;
  var CONNECT_RETRY_MS = 1000;
  var MAX_CONNECT_ATTEMPTS = 30;

  if (window[LOADED_FLAG]) return;
  window[LOADED_FLAG] = true;
  if (!window.parent || window.parent === window) return;

  var nonce = createNonce();
  var port = null;
  var pending = [];
  var connectAttempts = 0;
  var connectTimer = null;

  function boundedString(value, max) {
    if (value === null || typeof value === 'undefined') return '';
    var text = String(value);
    return text.length > max ? text.slice(0, max) : text;
  }

  function finiteNumber(value) {
    if (value === null || typeof value === 'undefined' || value === '') return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function createNonce() {
    var cryptoObject = window.crypto || window.msCrypto;
    if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
      try {
        var bytes = new Uint8Array(16);
        cryptoObject.getRandomValues(bytes);
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
          hex += (bytes[i] + 256).toString(16).slice(1);
        }
        return hex;
      } catch (error) {
        // Fall through.
      }
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 18);
  }

  function ownOrigin() {
    try {
      return window.location.origin;
    } catch (error) {
      return '';
    }
  }

  function parentOriginAllowed(origin) {
    var originHere = ownOrigin();
    if (originHere === 'null') return origin === 'null';
    return !!originHere && origin === originHere;
  }

  function redactUrlPathSecrets(value) {
    var text = boundedString(value, 1000).replace(
      /\b(token|access_token|auth|authorization|cookie|secret|api_key|key)=([^&#\s/]+)/gi,
      '$1=[redacted]'
    );
    var staticSegments = {
      scormcontent: true,
      scormdriver: true,
      index: true,
      indexapi: true,
      launch: true,
      course: true,
      courses: true,
      content: true,
      lesson: true,
      lessons: true,
      block: true,
      blocks: true,
      quiz: true,
      quizzes: true,
      preview: true,
      review: true,
      results: true,
      summary: true,
      home: true,
      player: true
    };
    return text.replace(/(^|[\/#])([^\/?#]+)/g, function (
      match,
      prefix,
      segment
    ) {
      var lower = segment.toLowerCase();
      if (staticSegments[lower]) return prefix + segment;
      var file = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9]{1,8})$/.exec(segment);
      if (
        file &&
        (staticSegments[file[1].toLowerCase()] ||
          /^(js|css|html|htm|png|jpg|jpeg|gif|svg|webp|woff2?)$/i.test(file[2]))
      ) {
        return prefix + '[resource].' + file[2].toLowerCase();
      }
      return prefix + '[redacted-route-segment]';
    });
  }

  function stripUrlSecrets(value) {
    var text = boundedString(value, 500);
    if (!text) return '';
    try {
      var parsed = new URL(text, window.location.href);
      var hash = parsed.hash || '';
      var hashQuery = hash.indexOf('?');
      if (hashQuery !== -1) hash = hash.slice(0, hashQuery);
      return boundedString(redactUrlPathSecrets(parsed.pathname + hash), 500);
    } catch (error) {
      var query = text.indexOf('?');
      return boundedString(
        redactUrlPathSecrets(query === -1 ? text : text.slice(0, query)),
        500
      );
    }
  }

  function currentRoute() {
    try {
      return stripUrlSecrets(
        (window.location.pathname || '') + (window.location.hash || '')
      );
    } catch (error) {
      return '';
    }
  }

  function safeMessage(error) {
    var allowedNames = {
      Error: true,
      TypeError: true,
      RangeError: true,
      ReferenceError: true,
      SyntaxError: true,
      URIError: true,
      EvalError: true,
      DOMException: true,
      AbortError: true,
      NetworkError: true,
      NotAllowedError: true,
      SecurityError: true,
      QuotaExceededError: true,
      MediaError: true
    };
    var name = '';
    try {
      name = error && typeof error === 'object' ? String(error.name || '') : '';
    } catch (ignored) {
      name = '';
    }
    return allowedNames[name] ? name : 'BrowserRuntimeError';
  }

  function send(type, data) {
    var event = {
      type: boundedString(type, 80),
      data: data && typeof data === 'object' ? data : {}
    };
    if (!port) {
      pending.push(event);
      while (pending.length > MAX_PENDING_EVENTS) pending.shift();
      return;
    }
    try {
      port.postMessage({
        type: 'sis-observability-event',
        protocolVersion: PROTOCOL_VERSION,
        nonce: nonce,
        event: event
      });
    } catch (error) {
      port = null;
      pending.push(event);
      while (pending.length > MAX_PENDING_EVENTS) pending.shift();
      requestConnection();
    }
  }

  function flushPending() {
    if (!port) return;
    var queued = pending.slice();
    pending.length = 0;
    for (var i = 0; i < queued.length; i++) {
      send(queued[i].type, queued[i].data);
    }
  }

  function requestConnection() {
    if (port || connectAttempts >= MAX_CONNECT_ATTEMPTS) return;
    connectAttempts += 1;
    try {
      window.parent.postMessage({
        type: 'sis-observability-connect',
        protocolVersion: PROTOCOL_VERSION,
        nonce: nonce
      }, ownOrigin() === 'null' ? '*' : ownOrigin());
    } catch (error) {
      // The retry loop below remains fail-open.
    }
    if (!port && connectAttempts < MAX_CONNECT_ATTEMPTS && connectTimer === null) {
      connectTimer = window.setTimeout(function () {
        connectTimer = null;
        requestConnection();
      }, CONNECT_RETRY_MS);
    }
  }

  window.addEventListener('message', function (event) {
    var message = event && event.data;
    if (
      event.source !== window.parent ||
      !parentOriginAllowed(event.origin) ||
      !message ||
      message.type !== 'sis-observability-connected' ||
      message.protocolVersion !== PROTOCOL_VERSION ||
      message.nonce !== nonce ||
      !event.ports ||
      !event.ports[0]
    ) {
      return;
    }
    port = event.ports[0];
    if (typeof port.start === 'function') port.start();
    if (connectTimer !== null) {
      window.clearTimeout(connectTimer);
      connectTimer = null;
    }
    flushPending();
  }, false);

  window.addEventListener('error', function (event) {
    try {
      var target = event && event.target;
      if (target && target !== window && target !== document) {
        var tagName = boundedString(target.tagName, 40).toLowerCase();
        var resource = '';
        resource = target.currentSrc || target.src || target.href || '';
        send('resource_error', {
          resourceType: tagName || 'resource',
          filename: stripUrlSecrets(resource),
          message: 'Resource failed to load'
        });
        return;
      }
      send('javascript_error', {
        message: safeMessage(event && (event.error || event.message)),
        filename: stripUrlSecrets(event && event.filename)
      });
    } catch (ignored) {
      // A hostile event object must never affect the page.
    }
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    try {
      send('unhandled_rejection', {
        message: safeMessage(event && event.reason)
      });
    } catch (ignored) {
      // A hostile rejection object must never affect the page.
    }
  }, true);

  function reportRoute(reason) {
    send('route_change', {
      operation: boundedString(reason, 40),
      route: currentRoute()
    });
  }

  window.addEventListener('hashchange', function () {
    reportRoute('hashchange');
  }, false);
  window.addEventListener('popstate', function () {
    reportRoute('popstate');
  }, false);

  function wrapHistoryMethod(name) {
    if (!window.history || typeof window.history[name] !== 'function') return;
    var original = window.history[name];
    window.history[name] = function () {
      var result = original.apply(this, arguments);
      reportRoute(name);
      return result;
    };
  }

  try {
    wrapHistoryMethod('pushState');
    wrapHistoryMethod('replaceState');
  } catch (error) {
    // Route observation is optional.
  }

  function mediaBlockId(element) {
    var current = element;
    for (var depth = 0; current && depth < 6; depth++) {
      try {
        if (current.getAttribute) {
          var id =
            current.getAttribute('data-block-id') ||
            current.getAttribute('data-id');
          if (id) return boundedString(id, 160);
        }
      } catch (error) {
        return '';
      }
      current = current.parentNode;
    }
    return '';
  }

  function reportMedia(event) {
    try {
      var element = event && event.target;
      if (!element) return;
      var tagName = boundedString(element.tagName, 20).toLowerCase();
      if (tagName !== 'video' && tagName !== 'audio') return;
      var data = {
        operation: boundedString(event.type, 40),
        resourceType: tagName,
        blockId: mediaBlockId(element)
      };
      var currentTime = finiteNumber(element.currentTime);
      if (currentTime !== null) data.mediaCurrentTime = currentTime;
      if (event.type === 'error') {
        data.message = 'Media playback error';
      }
      send('media_event', data);
    } catch (ignored) {
      // Media observation is strictly fail-open.
    }
  }

  var mediaEvents = ['play', 'ended', 'stalled', 'error'];
  for (var i = 0; i < mediaEvents.length; i++) {
    document.addEventListener(mediaEvents[i], reportMedia, true);
  }

  reportRoute('initial');
  requestConnection();
})();
