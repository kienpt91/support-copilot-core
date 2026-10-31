/*
 * Support chat widget: one file, no dependencies, no build step.
 *
 *   <script src="https://YOUR-API/widget.js" data-key="PUBLIC_KEY"></script>
 *
 * Optional attributes: data-api (API origin, defaults to the origin this script came from),
 * data-title (header text), data-position ("right" or "left").
 *
 * The pure logic (config validation, request building, response parsing, state handling) is
 * exposed as `SupportCopilotWidget` so it can be unit tested without a browser. All text from the
 * server is rendered as text nodes (createTextNode/textContent), never as markup.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.SupportCopilotWidget = api;
  if (typeof document !== "undefined") api.autoInit(document);
})(this, function () {
  "use strict";

  var MAX_MESSAGE = 2000;
  var MAX_CITATIONS = 5;
  var KEY_PATTERN = /^scp_[0-9a-f]{12}_[A-Za-z0-9_-]{20,64}$/;

  function cleanText(value, max) {
    if (typeof value !== "string") return "";
    // Drop control characters; keep tab and newline.
    return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max);
  }

  /** Validates widget settings. Throws an Error with a readable message for anything unusable. */
  function normalizeConfig(raw) {
    var input = raw || {};
    var key = typeof input.key === "string" ? input.key.trim() : "";
    if (!KEY_PATTERN.test(key)) throw new Error("data-key must be a public widget key (scp_...)");
    var api;
    try {
      api = new URL(String(input.api || ""));
    } catch (e) {
      throw new Error("data-api must be an absolute http(s) URL");
    }
    if (api.protocol !== "https:" && api.protocol !== "http:") throw new Error("data-api must use http or https");
    if (api.username || api.password) throw new Error("data-api must not contain credentials");
    var position = input.position === "left" ? "left" : "right";
    return {
      key: key,
      api: api.origin,
      title: cleanText(input.title, 40).trim() || "Help",
      position: position,
    };
  }

  /** Builds the fetch() arguments for one chat message. The public key travels in the query string so CORS preflight can check it. */
  function buildChatRequest(config, text, conversationId) {
    var message = cleanText(text, MAX_MESSAGE * 2).trim();
    if (message.length === 0) throw new Error("message is empty");
    if (message.length > MAX_MESSAGE) throw new Error("message is longer than " + MAX_MESSAGE + " characters");
    var body = { message: message };
    if (conversationId) body.conversationId = conversationId;
    return {
      url: config.api + "/v1/chat?pk=" + encodeURIComponent(config.key),
      init: {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    };
  }

  function friendlyError(status) {
    if (status === 429) return "You are sending messages too quickly. Please wait a moment and try again.";
    if (status === 401 || status === 403) return "Chat is not available on this site.";
    if (status === 400 || status === 413) return "That message could not be sent. Try a shorter one.";
    return "Something went wrong. Please try again later.";
  }

  /** Turns an HTTP status and decoded JSON body into either {ok:true, view} or {ok:false, message}. */
  function parseChatResponse(status, json) {
    if (status < 200 || status >= 300) return { ok: false, message: friendlyError(status) };
    if (!json || typeof json !== "object" || typeof json.answer !== "string" || typeof json.conversationId !== "string") {
      return { ok: false, message: friendlyError(500) };
    }
    var citations = [];
    var list = Array.isArray(json.citations) ? json.citations : [];
    for (var i = 0; i < list.length && citations.length < MAX_CITATIONS; i++) {
      var c = list[i];
      if (!c || typeof c !== "object" || typeof c.n !== "number") continue;
      citations.push({ n: Math.floor(c.n), title: cleanText(c.title, 120), snippet: cleanText(c.snippet, 300) });
    }
    return {
      ok: true,
      view: {
        conversationId: cleanText(json.conversationId, 64),
        answer: cleanText(json.answer, 4000),
        outcome: typeof json.outcome === "string" ? cleanText(json.outcome, 40) : "",
        citations: citations,
        escalated: Boolean(json.escalation),
        ticketId: json.ticket && typeof json.ticket.id === "string" ? cleanText(json.ticket.id, 64) : null,
      },
    };
  }

  /** Splits an answer into text parts and citation markers, so markers can be rendered as elements. */
  function splitCitations(answer) {
    var parts = [];
    var re = /\[(\d{1,2})\]/g;
    var last = 0;
    var m;
    while ((m = re.exec(answer)) !== null) {
      if (m.index > last) parts.push({ type: "text", text: answer.slice(last, m.index) });
      parts.push({ type: "cite", n: Number(m[1]) });
      last = m.index + m[0].length;
    }
    if (last < answer.length) parts.push({ type: "text", text: answer.slice(last) });
    return parts;
  }

  function storageKey(config) {
    return "scc:" + config.key.slice(4, 16);
  }

  function loadConversationId(storage, config) {
    try {
      var v = storage && storage.getItem(storageKey(config));
      return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function saveConversationId(storage, config, id) {
    try {
      if (storage) {
        if (id) storage.setItem(storageKey(config), id);
        else storage.removeItem(storageKey(config));
      }
    } catch (e) {
      // Storage can be blocked (private mode, disabled cookies). The chat still works, it just will not resume.
    }
  }

  /** Network side of the widget: remembers the conversation id and talks to the API through an injected fetch. */
  function createClient(options) {
    var config = options.config;
    var doFetch = options.fetch;
    var storage = options.storage;
    var conversationId = loadConversationId(storage, config);
    return {
      get conversationId() {
        return conversationId;
      },
      reset: function () {
        conversationId = null;
        saveConversationId(storage, config, null);
      },
      send: function (text) {
        var req;
        try {
          req = buildChatRequest(config, text, conversationId);
        } catch (e) {
          return Promise.resolve({ ok: false, message: e.message });
        }
        return doFetch(req.url, req.init).then(
          function (res) {
            return res.json().then(
              function (json) {
                return finish(res.status, json);
              },
              function () {
                return finish(res.status, null);
              },
            );
          },
          function () {
            return { ok: false, message: "Could not reach the support service. Check your connection and try again." };
          },
        );
      },
    };

    function finish(status, json) {
      var parsed = parseChatResponse(status, json);
      if (parsed.ok) {
        conversationId = parsed.view.conversationId;
        saveConversationId(storage, config, conversationId);
      } else if (status === 404) {
        // The stored conversation is gone (server restarted, or the id is stale): start fresh next time.
        conversationId = null;
        saveConversationId(storage, config, null);
      }
      return parsed;
    }
  }

  var STYLE =
    ".scc-root{position:fixed;bottom:16px;z-index:2147483000;font:14px/1.4 system-ui,sans-serif;color:#1a1a1a}" +
    ".scc-root.scc-right{right:16px}.scc-root.scc-left{left:16px}" +
    ".scc-launch{background:#1f4fd8;color:#fff;border:0;border-radius:999px;padding:10px 16px;cursor:pointer;font:inherit}" +
    ".scc-panel{display:none;width:320px;max-width:calc(100vw - 32px);height:420px;max-height:calc(100vh - 80px);background:#fff;border:1px solid #c8ccd4;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);flex-direction:column;overflow:hidden}" +
    ".scc-open .scc-panel{display:flex}.scc-open .scc-launch{display:none}" +
    ".scc-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#1f4fd8;color:#fff}" +
    ".scc-close{background:transparent;color:#fff;border:0;font-size:18px;cursor:pointer}" +
    ".scc-log{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}" +
    ".scc-msg{max-width:85%;padding:8px 10px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word}" +
    ".scc-user{align-self:flex-end;background:#e6ecff}.scc-bot{align-self:flex-start;background:#f2f3f5}.scc-err{align-self:center;background:#fdecec;color:#8a1c1c}" +
    ".scc-cite{font-size:11px;vertical-align:super}.scc-src{font-size:12px;color:#555;margin-top:4px}" +
    ".scc-form{display:flex;gap:6px;padding:8px;border-top:1px solid #e1e3e8}" +
    ".scc-input{flex:1;padding:8px;border:1px solid #c8ccd4;border-radius:6px;font:inherit}" +
    ".scc-send{background:#1f4fd8;color:#fff;border:0;border-radius:6px;padding:8px 12px;cursor:pointer;font:inherit}.scc-send[disabled]{opacity:.6;cursor:default}";

  /** Builds the UI with createElement/textContent only. `doc` is the document to build in. */
  function mount(doc, client, config) {
    var root = doc.createElement("div");
    root.className = "scc-root scc-" + config.position;
    var style = doc.createElement("style");
    style.textContent = STYLE;

    var launch = doc.createElement("button");
    launch.type = "button";
    launch.className = "scc-launch";
    launch.textContent = config.title;
    launch.setAttribute("aria-label", "Open chat: " + config.title);

    var panel = doc.createElement("div");
    panel.className = "scc-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", config.title);

    var head = doc.createElement("div");
    head.className = "scc-head";
    var heading = doc.createElement("span");
    heading.textContent = config.title;
    var close = doc.createElement("button");
    close.type = "button";
    close.className = "scc-close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", "Close chat");
    head.appendChild(heading);
    head.appendChild(close);

    var log = doc.createElement("div");
    log.className = "scc-log";
    log.setAttribute("role", "log");
    log.setAttribute("aria-live", "polite");

    var form = doc.createElement("form");
    form.className = "scc-form";
    var input = doc.createElement("input");
    input.type = "text";
    input.className = "scc-input";
    input.maxLength = MAX_MESSAGE;
    input.setAttribute("aria-label", "Your message");
    input.setAttribute("autocomplete", "off");
    var send = doc.createElement("button");
    send.type = "submit";
    send.className = "scc-send";
    send.textContent = "Send";
    form.appendChild(input);
    form.appendChild(send);

    panel.appendChild(head);
    panel.appendChild(log);
    panel.appendChild(form);
    root.appendChild(style);
    root.appendChild(launch);
    root.appendChild(panel);

    function addMessage(kind, parts) {
      var el = doc.createElement("div");
      el.className = "scc-msg scc-" + kind;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "cite") {
          var sup = doc.createElement("sup");
          sup.className = "scc-cite";
          sup.textContent = "[" + parts[i].n + "]";
          el.appendChild(sup);
        } else {
          el.appendChild(doc.createTextNode(parts[i].text));
        }
      }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
      return el;
    }

    function addSources(msgEl, citations) {
      for (var i = 0; i < citations.length; i++) {
        var src = doc.createElement("div");
        src.className = "scc-src";
        src.textContent = "[" + citations[i].n + "] " + citations[i].title + (citations[i].snippet ? " \u2014 " + citations[i].snippet : "");
        msgEl.appendChild(src);
      }
    }

    function setOpen(open) {
      root.className = "scc-root scc-" + config.position + (open ? " scc-open" : "");
      if (open) input.focus();
    }
    launch.addEventListener("click", function () {
      setOpen(true);
    });
    close.addEventListener("click", function () {
      setOpen(false);
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      send.disabled = true;
      addMessage("user", [{ type: "text", text: text }]);
      client.send(text).then(function (result) {
        send.disabled = false;
        if (!result.ok) {
          addMessage("err", [{ type: "text", text: result.message }]);
          return;
        }
        var el = addMessage("bot", splitCitations(result.view.answer));
        addSources(el, result.view.citations);
      });
    });

    doc.body.appendChild(root);
    return { root: root, log: log, input: input, form: form, launch: launch, close: close };
  }

  function init(options) {
    var doc = options.document;
    var config = normalizeConfig(options.config);
    var storage = null;
    try {
      storage = options.storage !== undefined ? options.storage : typeof sessionStorage !== "undefined" ? sessionStorage : null;
    } catch (e) {
      storage = null;
    }
    var client = createClient({ config: config, fetch: options.fetch || fetch.bind(globalThis), storage: storage });
    return { config: config, client: client, ui: mount(doc, client, config) };
  }

  /** Reads data-* attributes from the script tag that loaded this file. */
  function autoInit(doc) {
    var script = doc.currentScript;
    if (!script || !script.getAttribute("data-key")) return null;
    var api = script.getAttribute("data-api");
    if (!api && script.src) {
      try {
        api = new URL(script.src).origin;
      } catch (e) {
        api = "";
      }
    }
    try {
      return init({
        document: doc,
        config: {
          key: script.getAttribute("data-key"),
          api: api,
          title: script.getAttribute("data-title"),
          position: script.getAttribute("data-position"),
        },
      });
    } catch (e) {
      if (typeof console !== "undefined") console.error("[support widget] " + e.message);
      return null;
    }
  }

  return {
    normalizeConfig: normalizeConfig,
    buildChatRequest: buildChatRequest,
    parseChatResponse: parseChatResponse,
    splitCitations: splitCitations,
    loadConversationId: loadConversationId,
    saveConversationId: saveConversationId,
    createClient: createClient,
    mount: mount,
    init: init,
    autoInit: autoInit,
  };
});
