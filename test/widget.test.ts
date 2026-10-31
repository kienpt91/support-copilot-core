import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

/*
 * The widget is tested without a browser: its pure logic is loaded into a bare vm context (no window,
 * no document), and the DOM-building code runs against a tiny hand-written fake document. This checks
 * the logic and that server text is only ever put into text nodes. It does NOT check layout, CSS,
 * focus behaviour or anything else a real browser does; that has not been tested.
 */

const SOURCE = readFileSync(new URL("../src/widget/widget.js", import.meta.url), "utf8");

type ParseResult =
  | { ok: true; view: { conversationId: string; answer: string; outcome: string; citations: { n: number; title: string; snippet: string }[]; escalated: boolean; ticketId: string | null } }
  | { ok: false; message: string };
interface MountedUi {
  root: FakeElement;
  log: FakeElement;
  input: FakeElement;
  form: FakeElement;
  launch: FakeElement;
  close: FakeElement;
}

interface Widget {
  normalizeConfig(raw: unknown): { key: string; api: string; title: string; position: string };
  buildChatRequest(config: unknown, text: string, conversationId?: string | null): { url: string; init: { method: string; mode: string; credentials: string; headers: Record<string, string>; body: string } };
  parseChatResponse(status: number, json: unknown): ParseResult;
  splitCitations(answer: string): ({ type: "text"; text: string } | { type: "cite"; n: number })[];
  loadConversationId(storage: unknown, config: unknown): string | null;
  createClient(options: { config: unknown; fetch: unknown; storage: unknown }): { conversationId: string | null; send(text: string): Promise<ParseResult>; reset(): void };
  mount(doc: unknown, client: unknown, config: unknown): MountedUi;
  autoInit(doc: unknown): unknown;
}

function load(): Widget {
  const sandbox = { module: { exports: {} as unknown }, URL, console, fetch: async () => Promise.reject(new Error("no network in tests")) };
  vm.runInNewContext(SOURCE, sandbox);
  return sandbox.module.exports as Widget;
}
const widget = load();

const KEY = `scp_${"a1b2c3d4e5f6"}_${"X".repeat(43)}`;
const config = widget.normalizeConfig({ key: KEY, api: "https://api.example.test/" });

class FakeText {
  constructor(readonly text: string) {}
}
class FakeElement {
  children: (FakeElement | FakeText)[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  className = "";
  type = "";
  value = "";
  disabled = false;
  maxLength = 0;
  scrollTop = 0;
  scrollHeight = 0;
  focused = false;
  private own = "";
  constructor(readonly tag: string) {}
  set textContent(v: string) {
    this.own = v;
    this.children = [];
  }
  get textContent(): string {
    return this.own + this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join("");
  }
  set innerHTML(_v: string) {
    throw new Error("innerHTML must never be used");
  }
  appendChild(child: FakeElement | FakeText) {
    this.children.push(child);
    return child;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  focus() {
    this.focused = true;
  }
  fire(type: string, event: object = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...event });
  }
  all(tag: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) if (c instanceof FakeElement) out.push(...(c.tag === tag ? [c] : []), ...c.all(tag));
    return out;
  }
}
const fakeDoc = (currentScript?: unknown) => {
  const body = new FakeElement("body");
  return { body, currentScript, createElement: (t: string) => new FakeElement(t), createTextNode: (t: string) => new FakeText(t) };
};

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), removeItem: (k: string) => void delete data[k] };
}

const okResponse = (body: unknown, status = 200) => ({ status, json: async () => body });
const goodBody = { conversationId: "conv_abc", answer: "Use the link. [1]", outcome: "answered", citations: [{ n: 1, title: "Passwords", snippet: "We send a link." }], escalation: null, ticket: null };

describe("widget source", () => {
  it("never uses HTML-injection or dynamic-code APIs", () => {
    expect(SOURCE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|XMLHttpRequest/);
  });

  it("is a single small file with no imports", () => {
    expect(SOURCE).not.toMatch(/^\s*(import|export)\s/m);
    expect(Buffer.byteLength(SOURCE)).toBeLessThan(20_000);
  });

  it("loads in a context with no DOM and exposes its pure functions", () => {
    expect(Object.keys(widget)).toEqual(expect.arrayContaining(["normalizeConfig", "buildChatRequest", "parseChatResponse", "splitCitations", "createClient", "mount", "init", "autoInit"]));
  });

  it("sets a browser global when there is no module system", () => {
    const sandbox: Record<string, unknown> = { URL, console };
    vm.runInNewContext(SOURCE, sandbox);
    expect(typeof (sandbox.SupportCopilotWidget as Widget).normalizeConfig).toBe("function");
  });
});

describe("normalizeConfig", () => {
  it("accepts a public key and an absolute API URL and normalises the origin", () => {
    expect(widget.normalizeConfig({ key: KEY, api: "https://api.example.test/some/path?x=1", title: "  Ask us ", position: "left" })).toEqual({
      key: KEY,
      api: "https://api.example.test",
      title: "Ask us",
      position: "left",
    });
  });

  it("defaults the title and position", () => {
    expect(widget.normalizeConfig({ key: KEY, api: "http://localhost:3000" })).toMatchObject({ title: "Help", position: "right", api: "http://localhost:3000" });
  });

  it.each([
    ["missing key", { api: "https://a.test" }],
    ["secret key", { key: `scs_${"a1b2c3d4e5f6"}_${"X".repeat(43)}`, api: "https://a.test" }],
    ["malformed key", { key: "scp_short", api: "https://a.test" }],
    ["relative api", { key: KEY, api: "/v1" }],
    ["javascript api", { key: KEY, api: "javascript:alert(1)" }],
    ["api with credentials", { key: KEY, api: "https://user:pw@a.test" }],
    ["no api", { key: KEY }],
  ])("rejects %s", (_name, raw) => {
    expect(() => widget.normalizeConfig(raw)).toThrow();
  });

  it("truncates long titles and strips control characters", () => {
    const c = widget.normalizeConfig({ key: KEY, api: "https://a.test", title: `Hi\u0000${"x".repeat(100)}` });
    expect(c.title.length).toBe(40);
    expect(c.title).not.toContain("\u0000");
  });
});

describe("buildChatRequest", () => {
  it("builds a credential-less JSON POST with the key in the query string", () => {
    const req = widget.buildChatRequest(config, "  How do I reset my password?  ", null);
    expect(req.url).toBe(`https://api.example.test/v1/chat?pk=${KEY}`);
    expect(req.init).toMatchObject({ method: "POST", mode: "cors", credentials: "omit", headers: { "content-type": "application/json" } });
    expect(JSON.parse(req.init.body)).toEqual({ message: "How do I reset my password?" });
  });

  it("includes the conversation id when there is one", () => {
    expect(JSON.parse(widget.buildChatRequest(config, "hi", "conv_1").init.body)).toEqual({ message: "hi", conversationId: "conv_1" });
  });

  it("rejects empty and over-long messages and strips control characters", () => {
    expect(() => widget.buildChatRequest(config, "   ", null)).toThrow(/empty/);
    expect(() => widget.buildChatRequest(config, "x".repeat(2001), null)).toThrow(/longer than 2000/);
    expect(JSON.parse(widget.buildChatRequest(config, "a\u0000b\u0007c", null).init.body).message).toBe("abc");
  });
});

describe("parseChatResponse", () => {
  it("keeps only the fields the UI needs", () => {
    const parsed = widget.parseChatResponse(200, { ...goodBody, confidence: 0.9, evil: "<script>", ticket: { id: "tkt_1" }, escalation: { id: "esc_1" } });
    expect(parsed).toEqual({
      ok: true,
      view: { conversationId: "conv_abc", answer: "Use the link. [1]", outcome: "answered", citations: [{ n: 1, title: "Passwords", snippet: "We send a link." }], escalated: true, ticketId: "tkt_1" },
    });
  });

  it("limits and sanitises citations", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ n: i + 1, title: `T${i}`, snippet: "s".repeat(1000) }));
    const parsed = widget.parseChatResponse(200, { ...goodBody, citations: [null, "x", { title: "no n" }, ...many] });
    if (!parsed.ok) throw new Error("expected ok");
    expect(parsed.view.citations).toHaveLength(5);
    expect(parsed.view.citations[0]!.snippet.length).toBe(300);
  });

  it.each([
    [429, "too quickly"],
    [403, "not available"],
    [401, "not available"],
    [400, "could not be sent"],
    [413, "could not be sent"],
    [500, "Something went wrong"],
    [502, "Something went wrong"],
  ])("maps HTTP %i to a friendly message without exposing server text", (status, fragment) => {
    const parsed = widget.parseChatResponse(status, { error: { message: "internal stack trace" } });
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.message).toContain(fragment);
      expect(parsed.message).not.toContain("stack");
    }
  });

  it("treats a malformed success body as an error", () => {
    expect(widget.parseChatResponse(200, null).ok).toBe(false);
    expect(widget.parseChatResponse(200, { answer: 5 }).ok).toBe(false);
    expect(widget.parseChatResponse(200, { answer: "x" }).ok).toBe(false);
  });
});

describe("splitCitations", () => {
  it("separates text from citation markers", () => {
    expect(widget.splitCitations("Do this [1] then that [2].")).toEqual([
      { type: "text", text: "Do this " },
      { type: "cite", n: 1 },
      { type: "text", text: " then that " },
      { type: "cite", n: 2 },
      { type: "text", text: "." },
    ]);
    expect(widget.splitCitations("plain")).toEqual([{ type: "text", text: "plain" }]);
    expect(widget.splitCitations("")).toEqual([]);
    expect(widget.splitCitations("[x] [123]")).toEqual([{ type: "text", text: "[x] [123]" }]);
  });
});

describe("client", () => {
  it("sends, stores the conversation id and reuses it", async () => {
    const storage = memoryStorage();
    const calls: { url: string; body: unknown }[] = [];
    const client = widget.createClient({
      config,
      storage,
      fetch: async (url: string, init: { body: string }) => (calls.push({ url, body: JSON.parse(init.body) }), okResponse(goodBody)),
    });
    expect(client.conversationId).toBeNull();
    const first = await client.send("hello");
    expect(first).toMatchObject({ ok: true });
    expect(client.conversationId).toBe("conv_abc");
    await client.send("again");
    expect(calls[1]!.body).toEqual({ message: "again", conversationId: "conv_abc" });
    expect(Object.values(storage.data)).toEqual(["conv_abc"]);
  });

  it("resumes a stored conversation but ignores a malformed stored id", () => {
    const key = "scc:a1b2c3d4e5f6";
    expect(widget.createClient({ config, storage: memoryStorage({ [key]: "conv_old" }), fetch: vi.fn() }).conversationId).toBe("conv_old");
    expect(widget.loadConversationId(memoryStorage({ [key]: "<script>" }), config)).toBeNull();
  });

  it("forgets a conversation the server no longer knows", async () => {
    const storage = memoryStorage({ "scc:a1b2c3d4e5f6": "conv_old" });
    const client = widget.createClient({ config, storage, fetch: async () => okResponse({ error: {} }, 404) });
    const res = await client.send("hi");
    expect(res.ok).toBe(false);
    expect(client.conversationId).toBeNull();
    expect(storage.data).toEqual({});
  });

  it("turns network failures and unreadable bodies into friendly errors", async () => {
    const offline = widget.createClient({ config, storage: null, fetch: async () => { throw new TypeError("Failed to fetch"); } });
    expect(await offline.send("hi")).toEqual({ ok: false, message: expect.stringContaining("Could not reach") });
    const broken = widget.createClient({ config, storage: null, fetch: async () => ({ status: 200, json: async () => { throw new SyntaxError("bad json"); } }) });
    expect(await broken.send("hi")).toMatchObject({ ok: false });
  });

  it("works when storage throws", async () => {
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const client = widget.createClient({ config, storage, fetch: async () => okResponse(goodBody) });
    expect(await client.send("hi")).toMatchObject({ ok: true });
    client.reset();
  });

  it("does not call the network for an empty message", async () => {
    const fetchFn = vi.fn();
    const res = await widget.createClient({ config, storage: null, fetch: fetchFn }).send("   ");
    expect(res).toMatchObject({ ok: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("mount (fake DOM)", () => {
  const stubClient = (result: unknown) => ({ send: vi.fn(async () => result) });
  const submit = async (ui: MountedUi, text: string) => {
    ui.input.value = text;
    ui.form.fire("submit");
    for (let i = 0; i < 5; i++) await Promise.resolve(); // let the client's promise chain settle
  };

  it("renders server text only as text nodes, never as elements", async () => {
    const doc = fakeDoc();
    const evil = "<img src=x onerror=alert(1)> see [1]";
    const client = stubClient({ ok: true, view: { conversationId: "c", answer: evil, outcome: "answered", citations: [{ n: 1, title: "<b>T</b>", snippet: "<script>x</script>" }], escalated: false, ticketId: null } });
    const ui = widget.mount(doc, client, config);
    await submit(ui, "hello <b>there</b>");
    expect(ui.log.all("img")).toEqual([]);
    expect(ui.log.all("script")).toEqual([]);
    expect(ui.log.all("b")).toEqual([]);
    expect(ui.log.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(ui.log.textContent).toContain("hello <b>there</b>");
    expect(ui.log.all("sup")).toHaveLength(1);
    expect(ui.log.textContent).toContain("[1] <b>T</b> \u2014 <script>x</script>");
  });

  it("shows friendly error messages in the log and re-enables sending", async () => {
    const doc = fakeDoc();
    const ui = widget.mount(doc, stubClient({ ok: false, message: "Chat is not available on this site." }), config);
    await submit(ui, "hi");
    expect(ui.log.textContent).toContain("Chat is not available on this site.");
    expect(ui.form.all("button")[0]!.disabled).toBe(false);
  });

  it("ignores blank input and sends the trimmed text", async () => {
    const doc = fakeDoc();
    const client = stubClient({ ok: true, view: { conversationId: "c", answer: "ok", outcome: "answered", citations: [], escalated: false, ticketId: null } });
    const ui = widget.mount(doc, client, config);
    await submit(ui, "   ");
    expect(client.send).not.toHaveBeenCalled();
    await submit(ui, "  hi  ");
    expect(client.send).toHaveBeenCalledWith("hi");
    expect(ui.input.value).toBe("");
  });

  it("opens and closes the panel and labels controls for assistive tech", () => {
    const doc = fakeDoc();
    const ui = widget.mount(doc, stubClient({}), { ...config, position: "left" });
    expect(doc.body.children).toContain(ui.root);
    expect(ui.root.className).toBe("scc-root scc-left");
    ui.launch.fire("click");
    expect(ui.root.className).toBe("scc-root scc-left scc-open");
    expect(ui.input.focused).toBe(true);
    ui.close.fire("click");
    expect(ui.root.className).toBe("scc-root scc-left");
    expect(ui.log.attrs).toMatchObject({ role: "log", "aria-live": "polite" });
    expect(ui.input.attrs["aria-label"]).toBe("Your message");
    expect(ui.close.attrs["aria-label"]).toBe("Close chat");
  });
});

describe("autoInit", () => {
  const script = (attrs: Record<string, string>, src = "https://api.example.test/widget.js") => ({ src, getAttribute: (k: string) => attrs[k] ?? null });

  it("reads data attributes and defaults the API to the script's origin", () => {
    const doc = fakeDoc(script({ "data-key": KEY, "data-title": "Ask", "data-position": "left" }));
    const result = widget.autoInit(doc) as { config: { api: string; title: string; position: string } } | null;
    expect(result?.config).toMatchObject({ api: "https://api.example.test", title: "Ask", position: "left" });
    expect(doc.body.children).toHaveLength(1);
  });

  it("does nothing without a data-key or a current script", () => {
    expect(widget.autoInit(fakeDoc(script({})))).toBeNull();
    expect(widget.autoInit(fakeDoc(undefined))).toBeNull();
  });

  it("reports a bad configuration on the console instead of throwing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const doc = fakeDoc(script({ "data-key": "nope" }));
    expect(widget.autoInit(doc)).toBeNull();
    expect(doc.body.children).toHaveLength(0);
    err.mockRestore();
  });
});
