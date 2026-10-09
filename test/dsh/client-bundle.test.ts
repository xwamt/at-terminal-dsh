import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The built Client half (`dsh/client.js`), executed for real in a sandbox.
 *
 * The bundle is a compiled artifact, so what can silently break is *wiring*, and
 * wiring is what this file drives: the ModuleLoader registration, `apply()`'s
 * five registrations (dictionaries, styles, tab type, two seats), and the Body
 * component rendered through a small React stand-in — the same technique the
 * previous handwritten-client suite used, now pointed at the generated bundle.
 *
 * What is asserted through the rendered tree are the behaviours a user hits:
 * the assets page is a list with toolbar and context menu (no inline row
 * buttons), a failed Host read renders as a failure with its code (never as an
 * empty list — the `services-unavailable` regression), the form page reuses the
 * VS Code variant's markup classes, save/export/import call the right RPCs with
 * the right payloads, and the terminal socket speaks the `terminal.*` protocol
 * including pause-on-backpressure.
 *
 * Not covered here, honestly: the xterm engine itself (it needs a real DOM and
 * GPU/DOM renderer — it is assembled from `webview/terminal/*` building blocks
 * that have their own tests, and the in-app check is the user's walkthrough),
 * and real SSH bytes (unchanged from before: needs a reachable host).
 */

/* --------------------------------- React shim -------------------------------- */

interface ElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

interface ProviderLike {
  __isProvider: true;
  context: { current: unknown; defaultValue: unknown };
}

function isProvider(value: unknown): value is ProviderLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __isProvider?: unknown }).__isProvider === true
  );
}

function createReactShim() {
  const stateSlots: unknown[] = [];
  const refSlots: Array<{ current: unknown }> = [];
  let cursor = 0;
  let effectQueue: Array<() => unknown> = [];
  const cleanups: Array<() => void> = [];

  const createElement = (type: unknown, props: unknown, ...children: unknown[]): ElementLike => {
    const merged: Record<string, unknown> = { ...((props ?? {}) as Record<string, unknown>) };
    if (children.length > 0) {
      merged.children = children.length === 1 ? children[0] : children;
    }
    return { type, props: merged };
  };

  const createContext = (defaultValue: unknown) => {
    const context = {
      __isContext: true,
      defaultValue,
      current: defaultValue,
      Provider: undefined as unknown
    };
    context.Provider = { __isProvider: true, context };
    return context;
  };

  return {
    react: {
      createElement,
      createContext,
      useContext: (context: { current?: unknown; defaultValue?: unknown }) =>
        context.current === undefined ? context.defaultValue : context.current,
      useState: (initial: unknown) => {
        const index = cursor;
        cursor += 1;
        if (!(index in stateSlots)) {
          stateSlots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        }
        return [
          stateSlots[index],
          (next: unknown) => {
            stateSlots[index] =
              typeof next === 'function' ? (next as (prev: unknown) => unknown)(stateSlots[index]) : next;
          }
        ];
      },
      useRef: (initial: unknown) => {
        const index = cursor;
        cursor += 1;
        if (!(index in refSlots)) refSlots[index] = { current: initial };
        return refSlots[index];
      },
      useEffect: (run: () => unknown) => {
        cursor += 1;
        effectQueue.push(run);
      },
      /**
       * The badge store's re-render trigger and the SFTP read's parameter object. Both
       * advance the same cursor the other hooks use, so a component's hook order still has
       * to stay stable across renders — which is the real contract this shim exists to
       * protect. `useMemo` is deliberately not memoised: a shim that cached would hide a
       * body whose hook order drifts between renders.
       */
      useReducer: (reducer: (state: unknown, action: unknown) => unknown, initial: unknown) => {
        const index = cursor;
        cursor += 1;
        if (!(index in stateSlots)) stateSlots[index] = initial;
        return [
          stateSlots[index],
          (action: unknown) => {
            stateSlots[index] = reducer(stateSlots[index], action);
          }
        ];
      },
      useMemo: (compute: () => unknown) => {
        cursor += 1;
        return compute();
      }
    },
    /** Run one component function; hooks resolve against the slot arrays above. */
    render(component: (props: Record<string, unknown>) => unknown): unknown {
      cursor = 0;
      return component({});
    },
    /** Instantiate an element tree one level of components deep (providers + the body). */
    instantiate(element: unknown): unknown {
      if (element === null || typeof element !== 'object') return element;
      const node = element as ElementLike;
      if (isProvider(node.type)) {
        node.type.context.current = node.props.value;
        return this.instantiate(node.props.children);
      }
      if (typeof node.type === 'function') {
        cursor = 0;
        return (node.type as (props: Record<string, unknown>) => unknown)(node.props);
      }
      return node;
    },
    drainEffects(): void {
      const queued = effectQueue;
      effectQueue = [];
      for (const run of queued) {
        const cleanup = run();
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => void);
      }
    },
    runCleanups(): void {
      for (const cleanup of cleanups.splice(0)) cleanup();
    }
  };
}

/* ------------------------------- tree helpers -------------------------------- */

type Tree = unknown;

function walk(tree: Tree, visit: (node: ElementLike) => void): void {
  if (Array.isArray(tree)) {
    for (const item of tree) walk(item, visit);
    return;
  }
  if (tree === null || typeof tree !== 'object') return;
  const node = tree as ElementLike;
  if (!('props' in node)) return;
  visit(node);
  walk(node.props.children, visit);
}

function findByAction(tree: Tree, action: string): ElementLike | null {
  let found: ElementLike | null = null;
  walk(tree, (node) => {
    if (found === null && node.props['data-at-terminal-action'] === action) found = node;
  });
  return found;
}

function findAllByClass(tree: Tree, className: string): ElementLike[] {
  const found: ElementLike[] = [];
  walk(tree, (node) => {
    const value = node.props.className;
    if (typeof value === 'string' && value.split(/\s+/).includes(className)) found.push(node);
  });
  return found;
}

function findByAttribute(tree: Tree, attribute: string): ElementLike | null {
  let found: ElementLike | null = null;
  walk(tree, (node) => {
    if (found === null && node.props[attribute] !== undefined) found = node;
  });
  return found;
}

function collectText(tree: Tree): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === 'object' && 'props' in (node as object)) {
      visit((node as ElementLike).props.children);
    }
  };
  visit(tree);
  return parts.join(' ');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Fire the form's submit the way the browser does when the `type=submit` button
 * is clicked. Deliberately not a synthetic `onClick` on the button: the real
 * click path ends in the form's `onSubmit`, and wiring the save to both would
 * double-submit inside one browser tick.
 */
function submitForm(harness: Harness): void {
  const form = findAllByClass(harness.tree, 'server-form')[0];
  expect(form, 'the server form is not rendered').toBeDefined();
  (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
}

/**
 * Reach a live terminal the way a user does on a **terminal tab**: pick the server, press 连接.
 *
 * The route changed with the tab split, and it got shorter. It used to go through the 资产 row's
 * context menu, because a row double-click had already become "ask the frame for a new tab" and this
 * harness has no body for a tab the frame mints. Now the body that owns the socket is a registered
 * seat of its own, so this drives it directly: `harness.setBody('session')` is the tab switch, and
 * the 连接 click is the same `connectSession` the toolbar, the reconnect banner and the mount effect
 * all reach. Nothing about the protocol is exercised differently by going in this way.
 *
 * Asynchronous because switching bodies mounts a fresh session body, whose server list has to settle
 * before its selector has anything in it.
 */
async function connectInThisTab(harness: Harness): Promise<void> {
  harness.setTab(harness.tabInfo('tab-under-test', { serverId: 'srv-prod-1' }));
  await harness.settle();
}

/**
 * A harness driving the **终端** body, primed with the happy path and holding a tab identity.
 *
 * The file-tree and protocol suites all start this way; naming it once keeps "which of the two tab
 * kinds am I looking at" out of every individual test. The body is fixed at construction because the
 * shim cannot render two of them in one harness (see `BodyPage`).
 *
 * **Deliberately not settled.** The terminal body connects exactly once per mount and guards that
 * with a ref, and the shim keeps one hook-slot array per harness — so a render before the tab has
 * been told what it was opened for would both burn that one connect on an empty target and make
 * every later render a no-op. Tests therefore either call `connectInThisTab`/`renderTabWith` (which
 * set the tab and then settle) or settle themselves.
 */
function createSessionHarness(options: {
  location?: { protocol: string; host: string; origin: string; href: string };
} = {}): Harness {
  const harness = createHarness({ ...options, body: 'session' });
  harness.apply();
  primeHappyPath(harness);
  // A tab with no server: enough for a body to render as a tab, and enough for the tests that never
  // connect. Anything that connects re-sets it before the first render.
  harness.setTab(harness.tabInfo('tab-under-test', {}));
  return harness;
}

/**
 * A stand-in for one mounted panel, shaped the way `focusedServerId` reads a real one.
 *
 * The 「在新标签页中连接」 command lives in `apply` and finds what to act on through the DOM —
 * `closest`, `dataset`, `querySelector` — because the body's React state is not reachable from
 * there. Since `activeBody` consults the gesture's own `target` first, an object whose `closest`
 * answers with this is enough to drive the real path end to end. The alternative was a
 * "no DOM, then guess nothing" branch in the product, which only a test would ever take — and a
 * permissive double that certifies an untrue path is worse than no double.
 *
 * `page` is one of the body's own `data-at-terminal-body` values; `row` is the highlighted asset
 * (present only on 资产) and `select` this tab's own target (rendered on every page). Both are
 * separately settable because the two controls exist independently and the order between them is
 * the thing being asserted.
 */
function fakePanel(page: string, selected: { row?: string; select?: string }): unknown {
  return {
    dataset: { atTerminalBody: page },
    querySelector(selector: string) {
      if (selector.includes('[data-at-terminal-row]')) {
        return selected.row === undefined
          ? null
          : {
              getAttribute: (name: string) =>
                name === 'data-at-terminal-row' ? selected.row : null
            };
      }
      if (selector.includes('term-select')) {
        return selected.select === undefined ? null : { value: selected.select };
      }
      return null;
    }
  };
}

/** The context object the shortcut dispatcher hands `resolve`, for a gesture inside `panel`. */
function gestureIn(panel: unknown): { region: string; modal: null; target: unknown } {
  return { region: 'page', modal: null, target: { closest: () => panel } };
}

/**
 * Render the **终端** body as a tab the frame opened with `params`.
 *
 * `harness.render()` otherwise calls the body with `{}` — no frame tab at all — which is right for
 * everything that does not depend on the tab's identity. The `params` path does: it is the half that
 * decides whether the tab the user asked for is usable or empty, and nothing else in this suite can
 * reach it. `harness.setTab` hands the body the `useTabInfo` the frame would inject, so the real
 * `readTabParams` runs rather than a copy of its logic.
 *
 * Settles the way `harness.settle()` does — render, drain, flush, repeat — because the host reads
 * settle across rounds while the connect happens in the first one. The tab identity is memoised per
 * id, so calling this twice is the **same** tab re-rendering, which is what a background/foreground
 * round trip actually is.
 *
 * The harness must already be driving the terminal body (`createHarness({ body: 'session' })`);
 * the shim cannot carry two bodies at once.
 */
async function renderTabWith(
  harness: Harness,
  params: Record<string, unknown>,
  tabId = 'tab-under-test'
): Promise<Tree> {
  expect(harness.bodies.map((entry) => entry.key)).toContain(SESSION_KEY);
  harness.setTab(harness.tabInfo(tabId, params));
  return harness.settle();
}

/* --------------------------------- harness ----------------------------------- */

interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

interface SocketStub {
  url: string;
  sent: Array<Record<string, unknown>>;
  readyState: number;
  closed: boolean;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  receive(message: Record<string, unknown>): void;
  send(data: string): void;
  close(): void;
}

interface Harness {
  tree: Tree;
  render(): Tree;
  settle(): Promise<Tree>;
  apply(): void;
  registrations: Array<{ id: string; factory: (require: (id: string) => unknown) => unknown }>;
  localeRegistrations: Array<{ ns: string; dicts: { zh: Record<string, string>; en: Record<string, string> } }>;
  tabDefinitions: Array<Record<string, unknown>>;
  /** Commands handed to `ctx.shortcuts.register`: the page switches plus 在新标签页中连接. */
  shortcutRegistrations: Array<Record<string, unknown>>;
  /**
   * Every `ctx.sidebarRight.openTab` call, so the new-tab route can be asserted without a frame.
   * `options` is recorded because `params.serverId` is the whole difference between a tab that
   * connects and one that lands the user back on the asset list.
   */
  openTabCalls: Array<{ kind: string; options?: Record<string, unknown> }>;
  /**
   * The two registered pane bodies, by the key each was registered under.
   *
   * Two tab kinds mean two seats, and which one `render()` drives is the test's choice rather than
   * an accident of registration order: the 资产 page and the 终端 page are different surfaces with
   * different props, and a suite that always rendered whichever registered first could not tell a
   * missing body from a reordered one.
   */
  bodies: Array<{ key: string; component: (props: Record<string, unknown>) => unknown }>;
  /**
   * The `useTabInfo` the frame injects, for bodies driven as a real tab.
   *
   * Memoised per tab id, because a repeated call has to be the same tab **re-rendering** — a fresh
   * object per call would make every render look like a different tab, and a fresh abort signal per
   * call would make the occurrence look closed.
   */
  tabInfo(tabId: string, params: Record<string, unknown>): Record<string, unknown>;
  /** Hand `render()`/`settle()` a tab identity, or `null` for a body with no frame behind it. */
  setTab(record: Record<string, unknown> | null): void;
  /**
   * The frame writing the tab's `params` **after** the body has rendered — the order the real frame
   * produces (`place()` records them from `onCommitted`), and the one a mount-time read misses.
   */
  setTabParams(params: Record<string, unknown>): void;
  /**
   * The tab occurrence aborting, i.e. the frame's own account of "this record left the layout".
   *
   * Simulated separately from the inventory so the two witnesses can be made to disagree, which is
   * the case a session must survive: an abort whose tab is still listed did not mean a close.
   */
  abortTab(tabId: string): void;
  /**
   * How many live subscribers the tab's navigation handle has.
   *
   * The one thing a re-rendering harness cannot otherwise see. `settle()` re-renders the body
   * unconditionally, so a body that only *reads* the params would look identical to one that
   * subscribes — while on a real frame the difference is the whole bug: nothing tells a
   * non-subscribing body that the write happened.
   */
  navigationListeners(): number;
  /**
   * The frame's open-tab inventory, as `ctx.sidebarRight.openTabs` publishes it.
   *
   * Driving it is how a close is simulated the way the real frame reports one — including the paths
   * that never call a close handler — and it is what the plugin's "hold a background connection
   * open" subscription reads.
   */
  publishOpenTabs(tabs: Array<{ kind: string; contentId: string }>): void;
  /** Recorded `registerCloseHandler` callbacks, by kind. */
  closeHandlers: Map<string, (sessionId: string, tab: { id: string; contentId?: unknown }) => void>;
  /** Invoke the close handler for one kind, the way the frame does before removing the tab. */
  closeTab(kind: string, tab: { id: string; contentId?: string }): void;
  /**
   * Run the effect cleanups the shim has collected — i.e. **unmount**.
   *
   * The shim's `render()` never unmounts anything, so a teardown hung off a component's cleanup is
   * invisible to every other assertion in this file. A tab switch is exactly that unmount, which
   * makes this the only way to assert the one thing this change is about.
   */
  unmount(): void;
  /** Listeners the diagnostic trap attached to `window`. */
  windowListeners: Array<{ type: string; listener: (event: unknown) => void }>;
  slotInjects: string[];
  slotRegisters: Array<{ parent: string; options: Record<string, unknown>; component?: unknown }>;
  effects: Array<{ label: string | undefined; dispose: () => void }>;
  rpcCalls: RpcCall[];
  announces: Array<Record<string, unknown>>;
  sockets: SocketStub[];
  styles: Map<string, { textContent: string; removed: boolean }>;
  anchors: Array<{ download: string; href: string; clicked: boolean }>;
  clipboard: string[];
  confirms: string[];
  documentListeners: Array<{ type: string }>;
  setRpcHandler(method: string, handler: (params: Record<string, unknown>) => unknown): void;
  setConfirmAnswer(answer: boolean): void;
  shim: ReturnType<typeof createReactShim>;
}

/**
 * Which registered pane body a harness drives. Two tab kinds, two bodies.
 *
 * Chosen at construction and **not** switchable, because the React shim keeps one flat hook-slot
 * array for whatever it renders: driving the 资产 body and then the 终端 body through the same shim
 * would have them share slots, and the second would read the first's state. A harness that needs the
 * other body makes another harness.
 */
type BodyPage = 'assets' | 'session';

/** The two definition ids the seats are keyed by. Spelled out because they are the contract. */
const ASSETS_KEY = '@at-series/dsh-at-terminal';
const SESSION_KEY = '@at-series/dsh-at-terminal/session';
const MONITOR_KEY = '@at-series/dsh-at-terminal/monitor';

function createHarness(
  options: {
    location?: { protocol: string; host: string; origin: string; href: string };
    body?: BodyPage;
  } = {}
): Harness {
  const shim = createReactShim();
  const source = readFileSync(join(process.cwd(), 'dsh', 'client.js'), 'utf8');

  const rpcHandlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  const rpcCalls: RpcCall[] = [];
  const announces: Array<Record<string, unknown>> = [];
  const sockets: SocketStub[] = [];
  const anchors: Array<{ download: string; href: string; clicked: boolean }> = [];
  const clipboard: string[] = [];
  const confirms: string[] = [];
  let confirmAnswer = true;
  const documentListeners: Array<{ type: string }> = [];

  const stylesById = new Map<string, { textContent: string; removed: boolean }>();
  const appendedStyles: Array<{ textContent: string; removed: boolean }> = [];

  const documentStub = {
    getElementById: (id: string) => {
      const style = stylesById.get(id);
      if (style === undefined || style.removed) return null;
      // A live element stand-in: the disposer ensureStyles returns calls remove()
      // on whatever getElementById handed back, so the copy must carry it.
      return {
        id,
        textContent: style.textContent,
        removed: false,
        remove() {
          style.removed = true;
        }
      };
    },
    createElement: (tag: string) => {
      const element = {
        tag,
        id: '',
        textContent: '',
        download: '',
        href: '',
        removed: false,
        style: {},
        setAttribute() {},
        appendChild() {},
        click() {
          if (tag === 'a') anchors.push({ download: element.download, href: element.href, clicked: true });
        },
        remove() {
          element.removed = true;
          const tracked = stylesById.get(element.id);
          if (tracked !== undefined) tracked.removed = true;
        }
      };
      return element;
    },
    head: {
      appendChild(element: { id: string; textContent: string; removed: boolean }) {
        if (element.id !== '') {
          const tracked = { textContent: element.textContent, removed: false };
          stylesById.set(element.id, tracked);
          appendedStyles.push(tracked);
        }
      }
    },
    documentElement: {},
    body: {
      appendChild() {}
    },
    // No panels are mounted in this document, which is the truth here: the bodies live in a React
    // shim tree, not in the DOM. `panelBodies()` reads this, and a document without it would make
    // the shortcut's "no panel to act on" path throw instead of answering `pass`.
    querySelectorAll: () => [],
    addEventListener(type: string) {
      documentListeners.push({ type });
    },
    removeEventListener() {}
  };

  class WebSocketStub {
    static OPEN = 1;
    url: string;
    sent: Array<Record<string, unknown>> = [];
    readyState = 1;
    closed = false;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as SocketStub);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
    }
    close(): void {
      this.closed = true;
      this.readyState = 3;
    }
    receive(message: Record<string, unknown>): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  const locationStub = options.location ?? {
    protocol: 'http:',
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:19387',
    href: 'http://127.0.0.1:19387/'
  };

  interface RpcBody {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  }

  const fetchStub = (url: string, init?: { body?: string; method?: string }): Promise<unknown> => {
    let body: RpcBody | null = null;
    try {
      body = init?.body === undefined ? null : (JSON.parse(init.body) as RpcBody);
    } catch {
      body = null;
    }
    const method = body?.method;
    if (typeof method !== 'string') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    if (method === 'client.hello') {
      announces.push(body?.params ?? {});
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: body?.id, ok: true, result: { recorded: true } }) });
    }
    rpcCalls.push({ method, params: body?.params ?? {} });
    const handler = rpcHandlers.get(method);
    if (handler === undefined) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ id: body?.id, ok: true, result: {} })
      });
    }
    try {
      const result = handler(body?.params ?? {});
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ id: body?.id, ok: true, result })
      });
    } catch (error) {
      const coded = error as { code?: string; message?: string };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          id: body?.id,
          ok: false,
          error: { code: coded?.code ?? 'error', message: coded?.message ?? String(error) }
        })
      });
    }
  };

  const sandbox: Record<string, unknown> = {
    console,
    navigator: {
      userAgent: 'bundle-test',
      // xterm's platform module reads both at module init; a missing `platform`
      // makes its `s2.indexOf("Linux")` throw during bundle evaluation.
      platform: 'node',
      clipboard: {
        writeText: async (value: string) => void clipboard.push(value)
      }
    },
    location: locationStub,
    document: documentStub,
    fetch: fetchStub,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Blob: class {
      parts: unknown[];
      constructor(parts: unknown[]) {
        this.parts = parts;
      }
    },
    /**
     * A `FileReader` that reads the fake `File`'s own `base64` field.
     *
     * The harness's files are plain objects — the sandbox has no real `File` and no real
     * `Blob` payload — so the base64 an upload would have produced is carried on the object
     * under test. That is the whole of what the upload path reads: `readAsDataURL` and the
     * `data:` prefix it must strip.
     */
    FileReader: class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: { base64?: string }) {
        this.result = `data:application/octet-stream;base64,${blob?.base64 ?? ''}`;
        queueMicrotask(() => this.onload?.());
      }
    },
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => undefined
    }
  };
  sandbox.window = {
    __ModuleLoader__: {
      load(registration: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
        registrations.push(registration);
      }
    },
    WebSocket: WebSocketStub,
    location: locationStub,
    document: documentStub,
    // The body reaches for `window.setTimeout` (the copied-address chip timer).
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    innerWidth: 1280,
    innerHeight: 800,
    confirm(message: string) {
      confirms.push(message);
      return confirmAnswer;
    },
    // The diagnostic trap attaches here during `apply`. Without it the install throws and
    // takes every other registration with it — which is the shape of bug this harness most
    // easily hides, so the listeners are recorded and asserted instead.
    addEventListener(type: string, listener: (event: unknown) => void) {
      windowListeners.push({ type, listener });
    },
    removeEventListener() {
      /* the trap is not disposed; see `installDiagnostics` */
    }
  };
  sandbox.self = sandbox;

  const registrations: Array<{ id: string; factory: (require: (id: string) => unknown) => unknown }> = [];
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'dsh/client.js' });

  /* ---- registration + apply plumbing ---- */

  const localeRegistrations: Harness['localeRegistrations'] = [];
  const tabDefinitions: Array<Record<string, unknown>> = [];
  const slotInjects: string[] = [];
  const slotRegisters: Harness['slotRegisters'] = [];
  const shortcutRegistrations: Array<Record<string, unknown>> = [];
  const openTabCalls: Array<{ kind: string; options?: Record<string, unknown> }> = [];
  /** Listeners the diagnostic trap attached to `window`, so its wiring can be asserted. */
  const windowListeners: Array<{ type: string; listener: (event: unknown) => void }> = [];
  const effects: Harness['effects'] = [];
  const bodies: Harness['bodies'] = [];
  const closeHandlers: Harness['closeHandlers'] = new Map();
  let openTabSnapshot: Array<{ sessionId: string; tabId: string; kind: string; contentId: string }> = [];
  const openTabListeners: Array<() => void> = [];
  const tabControllers = new Map<string, AbortController>();
  /** One navigation handle per tab id, the way the frame keeps one occurrence per record. */
  const navigations = new Map<string, { params: Record<string, unknown>; listeners: Set<() => void> }>();
  const page: BodyPage = options.body ?? 'assets';
  let tabRecord: Record<string, unknown> | null = null;
  let currentTabId = '';
  let currentSlot = '';
  const dictionaries = new Map<string, { zh: Record<string, string>; en: Record<string, string> }>();  const translate = (key: string, args?: Record<string, unknown>): string => {
    const dicts = dictionaries.get('atTerminal');
    const template = dicts?.zh[key] ?? key;
    if (args === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(args[name] ?? ''));
  };

  const ctxStub = {
    effect(setup: () => unknown, label?: string) {
      const dispose = setup();
      effects.push({ label, dispose: typeof dispose === 'function' ? (dispose as () => void) : () => {} });
      return () => {};
    },
    locale: {
      bind: () => translate,
      register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) {
        dictionaries.set(ns, dicts);
        localeRegistrations.push({ ns, dicts });
        return () => {};
      }
    },
    sidebarRightTabs: {
      register(definition: Record<string, unknown>) {
        tabDefinitions.push(definition);
        return () => {};
      }
    },
    shortcuts: {
      register(command: Record<string, unknown>) {
        shortcutRegistrations.push(command);
        return () => {};
      }
    },
    // The frame's navigation face. `openTab` takes the opener's `params` too — the server the
    // new tab should connect to — and that value is what the assertions below read. The other two
    // members are the ones the session lifetime needs: a close hook, and the open-tab inventory
    // that decides whether a background connection is held (see `main.ts`).
    sidebarRight: {
      openTab(kind: string, options?: Record<string, unknown>) {
        openTabCalls.push(options === undefined ? { kind } : { kind, options });
      },
      openTabFromTarget(kind: string) {
        openTabCalls.push({ kind });
      },
      registerCloseHandler(kind: string, handler: (sessionId: string, tab: { id: string }) => void) {
        closeHandlers.set(kind, handler);
        return () => {
          if (closeHandlers.get(kind) === handler) closeHandlers.delete(kind);
        };
      },
      openTabs: {
        getSnapshot: () => openTabSnapshot,
        subscribe(listener: () => void) {
          openTabListeners.push(listener);
          return () => {
            const index = openTabListeners.indexOf(listener);
            if (index >= 0) openTabListeners.splice(index, 1);
          };
        }
      }
    },
    slots: {
      inject(key: string, callback: () => unknown) {
        slotInjects.push(key);
        const previous = currentSlot;
        currentSlot = key;
        try {
          callback();
        } finally {
          currentSlot = previous;
        }
        return () => {};
      },
      register(options: Record<string, unknown>, component: unknown) {
        slotRegisters.push({ parent: currentSlot, options, component });
        return () => {};
      }
    }
  };

  expect(registrations).toHaveLength(1);
  const plugin = registrations[0].factory((id: string) => {
    if (id === 'react') return shim.react;
    throw new Error(`unexpected external require: ${id}`);
  }) as { apply: (ctx: unknown) => void; inject: string[] };

  const harness: Harness = {
    tree: null,
    registrations,
    localeRegistrations,
    tabDefinitions,
    shortcutRegistrations,
    openTabCalls,
    bodies,
    closeHandlers,
    windowListeners,
    slotInjects,
    slotRegisters,
    effects,
    rpcCalls,
    announces,
    sockets,
    styles: stylesById,
    anchors,
    clipboard,
    confirms,
    documentListeners,
    shim,
    setRpcHandler(method, handler) {
      rpcHandlers.set(method, handler);
    },
    setConfirmAnswer(answer) {
      confirmAnswer = answer;
    },
    tabInfo(tabId, params) {
      // A **fresh** record per call, so `setTab` before the first render decides what the tab was
      // opened for.
      //
      // The navigation handle is per tab id and memoised, because that is what the frame's is: the
      // occurrence's snapshot store. Two things rest on it. `getSnapshot()` reads, and `subscribe()`
      // is how a body hears about a write that lands *after* its first render — which is the real
      // order the frame produces (`place()` records `params` from `onCommitted`), and the order the
      // late-params test drives deliberately. Memoising the record itself would freeze the params at
      // their first value and make that case unreachable.
      //
      // The signal is memoised for the same reason: it is the occurrence's identity, and a fresh
      // signal per call would make every render look like a different — closed — tab.
      let controller = tabControllers.get(tabId);
      if (controller === undefined) {
        controller = new AbortController();
        tabControllers.set(tabId, controller);
      }
      let navigation = navigations.get(tabId);
      if (navigation === undefined) {
        navigation = { params, listeners: new Set() };
        navigations.set(tabId, navigation);
      } else {
        navigation.params = params;
      }
      const current = navigation;
      const contentId = `sidebar://at-terminal-session/${tabId}`;
      return {
        id: tabId,
        contentId,
        kind: 'at-terminal-session',
        navigation: {
          getSnapshot: () => ({ address: contentId, params: current.params }),
          subscribe(listener: () => void) {
            current.listeners.add(listener);
            return () => {
              current.listeners.delete(listener);
            };
          }
        },
        signal: controller.signal
      };
    },
    setTabParams(params) {
      // The frame's own write, after the body has already rendered once. Every subscriber hears it,
      // exactly as the occurrence's store delivers it — the case a mount-time read cannot see.
      const entry = navigations.get(currentTabId);
      if (entry === undefined) throw new Error('setTab() has not named the tab under test');
      entry.params = params;
      for (const listener of [...entry.listeners]) listener();
    },
    abortTab(tabId) {
      tabControllers.get(tabId)?.abort();
    },
    navigationListeners() {
      return navigations.get(currentTabId)?.listeners.size ?? 0;
    },
    setTab(record) {
      tabRecord = record;
      currentTabId = typeof record?.id === 'string' ? record.id : '';
    },
    publishOpenTabs(tabs) {
      openTabSnapshot = tabs.map((tab, index) => ({
        sessionId: 'session-1',
        tabId: `tab${index + 1}`,
        kind: tab.kind,
        contentId: tab.contentId
      }));
      for (const listener of [...openTabListeners]) listener();
    },
    closeTab(kind, tab) {
      closeHandlers.get(kind)?.('session-1', tab);
    },
    unmount() {
      shim.runCleanups();
    },
    apply() {
      plugin.apply(ctxStub);
      for (const entry of slotRegisters) {
        if (entry.options?.name !== 'sidebar.right.pane.tab') continue;
        bodies.push({
          key: String(entry.options.key ?? ''),
          component: entry.component as (props: Record<string, unknown>) => unknown
        });
      }
    },
    render() {
      const body = bodies.find((entry) => entry.key === (page === 'session' ? SESSION_KEY : ASSETS_KEY));
      if (body === undefined) {
        throw new Error(`apply() has not run, or no ${page} pane body was registered`);
      }
      harness.tree = shim.instantiate(
        body.component(tabRecord === null ? {} : { useTabInfo: () => ({ tab: tabRecord }) })
      );
      return harness.tree;
    },
    async settle() {
      harness.render();
      for (let round = 0; round < 4; round += 1) {
        shim.drainEffects();
        await flush();
        harness.render();
      }
      return harness.tree;
    }
  };

  return harness;
}

/* ---------------------------------- fixtures ---------------------------------- */

const SERVERS = [
  {
    id: 'srv-prod-1',
    label: 'web-01',
    group: 'prod',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'password',
    hasPassword: true,
    encoding: 'utf-8',
    keepAliveInterval: 30
  },
  {
    id: 'srv-dev-1',
    label: 'dev-box',
    host: '192.168.1.5',
    port: 2222,
    username: 'clkj',
    authType: 'privateKey',
    privateKeyPath: '/keys/id_ed25519',
    encoding: 'utf-8',
    keepAliveInterval: 30
  }
];

function primeHappyPath(harness: Harness): void {
  harness.setRpcHandler('servers.list', () => ({
    servers: SERVERS,
    groups: ['prod'],
    privateKeyDirectory: '/home/u/.dsh/at-terminal/imported-private-keys'
  }));
  harness.setRpcHandler('assets.summary', () => ({
    servers: 2,
    passwords: 1,
    privateKeyFiles: 3,
    privateKeyDirectory: '/home/u/.dsh/at-terminal/imported-private-keys'
  }));
  harness.setRpcHandler('settings.get', () => ({
    terminalFontSize: 15,
    terminalFontFamily: 'Fira Code, monospace',
    scrollback: 5000,
    semanticHighlight: true,
    zebraStripes: false
  }));
  harness.setRpcHandler('channel.info', () => ({
    host: '127.0.0.1',
    port: 19387,
    wsUrl: 'ws://127.0.0.1:19387/dsh-at-terminal/ws'
  }));
}

/* ----------------------------------- tests ------------------------------------ */

describe('client bundle — loader registration', () => {
  it('registers exactly one factory under the package name', () => {
    const harness = createHarness();
    expect(harness.registrations).toHaveLength(1);
    expect(harness.registrations[0].id).toBe('@at-series/dsh-at-terminal');
  });
});

describe('client bundle — apply wiring', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = createHarness();
    harness.apply();
  });

  /**
   * The diagnostic trap is wired **and** reaches the Host.
   *
   * This exists because a blank panel had no evidence at all: the desktop shell buffers
   * renderer console output and flushes it only into a *crash* report, and React tearing down
   * one subtree is not a crash. Asserting the wiring is what stops the instrumentation from
   * rotting into something that silently stops working — the failure mode of every log line
   * ever written.
   */
  it('installs the browser-failure trap and forwards an uncaught error to the Host', async () => {
    expect(harness.windowListeners.map((entry) => entry.type).sort()).toEqual([
      'error',
      'unhandledrejection'
    ]);

    const listener = harness.windowListeners.find((entry) => entry.type === 'error');
    expect(listener).toBeDefined();
    // Driven the way the browser does: an ErrorEvent carrying a real Error.
    listener?.listener({
      message: 'boom',
      lineno: 42,
      error: Object.assign(new Error('render exploded'), { stack: 'stack-line' })
    });
    await flush();

    // `rpcCalls` records every posted method, so this asserts the wire form as well as the
    // content: method name included, because a trap that posts the right text under the wrong
    // method reaches no handler.
    const reports = harness.rpcCalls.filter((entry) => entry.method === 'client.diagnostic');
    const failure = reports.find((entry) => (entry.params as { message?: string }).message === 'Error: render exploded');
    expect(failure).toBeDefined();
    expect(failure?.params).toMatchObject({
      level: 'error',
      stack: 'stack-line',
      line: 42
    });
    // And the activation breadcrumb, so a silent trap is distinguishable from an absent one.
    expect(
      reports.some((entry) => String((entry.params as { message?: string }).message).includes('activating'))
    ).toBe(true);
  });

  it('registers both dictionaries under the atTerminal namespace', () => {
    expect(harness.localeRegistrations).toHaveLength(1);
    const registration = harness.localeRegistrations[0];
    expect(registration.ns).toBe('atTerminal');
    expect(registration.dicts.zh['mode.assets']).toBe('资产');
    expect(registration.dicts.en['mode.assets']).toBe('Assets');
  });

  /**
   * Two tab types, and the asymmetry between them is the whole design.
   *
   * 资产 is the column's manager: **one** instance, and the only guide entry — which is also what
   * makes it the page the column opens with (`defaultSeed` uses the sole entry's kind when there is
   * exactly one). 终端 is **one per connection**, with no guide entry, because an entry there would
   * offer a nameless door onto an empty terminal; it is opened by the gesture that names a server.
   */
  it('registers three tab types: assets manager, per-connection terminal, and monitor', () => {
    expect(harness.tabDefinitions).toHaveLength(3);
    const [assets, session, monitor] = harness.tabDefinitions;

    expect(assets.id).toBe('@at-series/dsh-at-terminal');
    expect(assets.kind).toBe('at-terminal');
    const guide = assets.guide as Array<Record<string, unknown>>;
    expect(guide[0].id).toBe('at-terminal');
    expect(guide[0].order).toBe(50);
    expect((guide[0].title as () => string)()).toBe('AT Terminal');
    expect((assets.title as () => string)()).toBe('AT Terminal');

    expect(session.id).toBe('@at-series/dsh-at-terminal/session');
    expect(session.kind).toBe('at-terminal-session');
    // Absent, not empty: the registry defaults it to `[]`, and not listing a guide entry is what
    // keeps the terminal kind out of the column's guide and out of the default-page contest.
    expect(session.guide).toBeUndefined();
    expect((session.title as () => string)()).toBe('AT 终端');

    expect(monitor.id).toBe(MONITOR_KEY);
    expect(monitor.kind).toBe('at-terminal-monitor');
    expect(monitor.guide).toBeUndefined();
    expect((monitor.title as () => string)()).toBe('监控悬浮窗');
  });

  /**
   * The flags that decide how many instances exist and how long they live.
   *
   * `multiple: true` is what the frame reads to mint a **distinct content address per open**
   * (`definition.multiple === true ? \`${pageAddress(kind)}/${randomUUID()}\` : pageAddress(kind)`),
   * which is the whole difference between "a second 连接 replaces the first" and "a second tab
   * appears beside it". The manager must **not** have it: two copies of one server list in a pane is
   * a defect a user can see, and a fixed address is what makes re-opening it reveal the tab.
   *
   * `keepMounted: true` is absent from all three — asserted rather than assumed, because it is the
   * flag that was tried and made the panel flash once and go blank (the frame moves a retained body
   * into a hidden background subtree). The background instance is kept alive by the *session*
   * registry instead, which is what `keeps the connection when the tab goes to the background` below
   * exercises.
   */
  it('makes the terminal kind multi-instance, the manager and monitor single, and retains no body', () => {
    const [assets, session, monitor] = harness.tabDefinitions;
    expect(assets.multiple).toBe(false);
    expect(session.multiple).toBe(true);
    expect(monitor.multiple).toBe(false);
    expect(assets.keepMounted).toBeUndefined();
    expect(session.keepMounted).toBeUndefined();
    expect(monitor.keepMounted).toBeUndefined();
  });

  /**
   * The keyboard route to the row double-click, and the only remaining way to start a terminal.
   *
   * Opening a second instance is a **frame** operation, which is why `sidebarRight` is injected at
   * all: the registry creates tab *types*, not tab instances. But the command has to name a server,
   * and the body's React state is not reachable from `apply`, so it reads the focused panel's DOM —
   * `fakePanel` stands in for that. Every branch is asserted: each tab's own answer, nothing
   * selected, and no panel at all.
   */
  it('registers a 「在新标签页中连接」 command that names the focused panel’s server', () => {
    const command = harness.shortcutRegistrations.find((entry) => entry.id === 'atTerminal.newTab');
    expect(command).toBeDefined();
    expect((command?.label as () => string)()).toBe('在新标签页中连接');
    expect(command?.regions).toEqual(['page', 'editable', 'terminal']);
    const resolve = command?.resolve as (arg: unknown) => { status: string; run?: () => void; reason?: string };

    // 资产, with a row highlighted: that row. It is what the user just clicked, and it is the same
    // act as the double-click this command stands in for.
    const fromList = resolve(gestureIn(fakePanel('assets', { row: 'srv-prod-1', select: 'srv-dev-1' })));
    expect(fromList.status).toBe('handled');
    (fromList.run as () => void)();
    expect(harness.openTabCalls).toEqual([
      { kind: 'at-terminal-session', options: { params: { serverId: 'srv-prod-1' } } }
    ]);

    // 终端: this tab's own selector — "another shell on the machine I am already on". The session
    // body renders no asset row, so the selector is the only control that can answer here.
    harness.openTabCalls.length = 0;
    const fromTerminal = resolve(gestureIn(fakePanel('terminal', { select: 'srv-dev-1' })));
    expect(fromTerminal.status).toBe('handled');
    (fromTerminal.run as () => void)();
    expect(harness.openTabCalls).toEqual([
      { kind: 'at-terminal-session', options: { params: { serverId: 'srv-dev-1' } } }
    ]);

    // The **row** is read only on 资产. A session page carrying a stale highlight must answer with
    // its own selector, not with a server the user stopped looking at three tabs ago.
    harness.openTabCalls.length = 0;
    const sessionIgnoresRow = resolve(gestureIn(fakePanel('sftp', { row: 'srv-prod-1', select: 'srv-dev-1' })));
    expect(sessionIgnoresRow.status).toBe('handled');
    (sessionIgnoresRow.run as () => void)();
    expect(harness.openTabCalls).toEqual([
      { kind: 'at-terminal-session', options: { params: { serverId: 'srv-dev-1' } } }
    ]);

    // Nothing on either control: `blocked` with a reason, and above all **no tab**. Opening an
    // empty one is the regression this command used to be, so it is asserted as an absence of
    // side effects rather than by its copy alone.
    harness.openTabCalls.length = 0;
    const unselected = resolve(gestureIn(fakePanel('assets', {})));
    expect(unselected.status).toBe('blocked');
    expect(unselected.run).toBeUndefined();
    expect(unselected.reason).toBe('请先在资产列表中选择一台服务器，或在终端标签页选好目标服务器。');
    expect(harness.openTabCalls).toEqual([]);

    // No panel to act on: `pass`, so the browser keeps the gesture instead of this plugin
    // consuming it on behalf of a tab that is not there.
    const noPanel = resolve({ region: 'page', modal: null, target: null });
    expect(noPanel.status).toBe('pass');
    expect(harness.openTabCalls).toEqual([]);

    // Desktop only, and that is load-bearing rather than a preference — see the gate below
    // and `newTabCommand`'s comment. A `web:*` entry bound to one modifier throws inside
    // `register` and takes the whole client down at boot.
    expect(Object.keys(command?.defaults as Record<string, unknown>).sort()).toEqual([
      'desktop:linux',
      'desktop:macos',
      'desktop:windows'
    ]);
  });

  /**
   * The rule that actually governs a declared default, ported from the real registry.
   *
   * `ctx.shortcuts.register` **validates and throws**:
   * ```js
   * if (runtime === "web" && !isWebBindingAllowed(binding, platform)) throw new Error(`Unsupported Web shortcut: ${id}`)
   * if (bindingIssue(binding, runtime, platform) !== null) throw new Error(`Reserved shortcut default: ${id}`)
   * ```
   * This harness's `shortcuts` stub only records the command, so it accepted a binding the
   * product rejects — the tests passed while `dsh` refused to boot:
   * `web boot: 1 entry did not activate / @at-series/dsh-at-terminal: failed`. A permissive
   * double is worse than no double, because it certifies the exact thing that is untrue.
   *
   * `atTerminal.newTab` shipped `web:macos`/`web:windows` on a **single** `primary` and hit
   * exactly that. So the admission rule is asserted here directly, transcribed from
   * `@deepseek-ai/dsh-client-shortcuts` (`isWebBindingAllowed` and the web clause of
   * `bindingIssue`), and applied to every command this plugin registers.
   */
  it('declares only bindings the real shortcut registry would admit', () => {
    // Verbatim from `isWebBindingAllowed`, with `primary` expanded the way `normalizeBinding`
    // expands it (Meta on macOS, Control elsewhere).
    const webAdmitted = (code: string, rawModifiers: string[], platform: string): boolean => {
      const modifiers = rawModifiers.map((value) =>
        value === 'primary' ? (platform === 'macos' ? 'meta' : 'control') : value
      );
      if (platform === 'windows' || platform === 'macos') {
        if (modifiers.length >= 3) return true;
        const primary = platform === 'macos' ? 'meta' : 'control';
        if (
          modifiers.length === 1 &&
          ((['Comma', 'Backslash'].includes(code) && modifiers[0] === primary) ||
            (code === 'Backquote' && modifiers[0] === 'control'))
        ) {
          return true;
        }
        if (
          modifiers.length === 2 &&
          modifiers.includes(primary) &&
          (modifiers.includes('alt') || modifiers.includes('shift'))
        ) {
          return true;
        }
      }
      return [
        { code: 'Slash', modifiers: ['primary'] },
        { code: 'Comma', modifiers: ['primary', 'shift'] },
        { code: 'Period', modifiers: ['primary', 'shift'] }
      ].some((candidate) => {
        const expanded = candidate.modifiers.map((value) =>
          value === 'primary' ? (platform === 'macos' ? 'meta' : 'control') : value
        );
        return candidate.code === code && expanded.join(',') === modifiers.join(',');
      });
    };

    for (const command of harness.shortcutRegistrations) {
      const defaults = (command.defaults ?? {}) as Record<
        string,
        { code: string; modifiers: string[] }
      >;
      for (const [key, binding] of Object.entries(defaults)) {
        const [runtime, platform] = key.split(':');
        // An absent key is the documented way to say "no default": `resolveShortcutDefault`
        // is a plain exact lookup with no fallback, so there is nothing to validate.
        expect(typeof binding.code).toBe('string');
        if (runtime === 'web') {
          expect(
            webAdmitted(binding.code, binding.modifiers, platform),
            `${String(command.id)} declares ${key} = ${binding.code}+[${binding.modifiers.join(',')}], which the registry rejects with "Unsupported Web shortcut"`
          ).toBe(true);
        }
        // The reserved list from `bindingIssue`. Desktop macOS/Windows return null before
        // reaching it, so this only constrains the rest — and the arrow/navigation keys are
        // reserved on every platform when they carry no real modifier.
        if (!(runtime === 'desktop' && (platform === 'macos' || platform === 'windows'))) {
          expect(
            ['Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
          ).not.toContain(binding.code);
          // A binding with no modifier at all is rejected outright ("modifier-required").
          expect(binding.modifiers.length).toBeGreaterThan(0);
        }
      }
    }
  });

  /**
   * The shortcut registry, which **no test exercised** until a rebuild exposed it.
   *
   * The committed `dsh/client.js` predated the `shortcuts` feature, so `ctx.shortcuts.register`
   * was never called by a single test — the suite passed against a stale artifact. The stub
   * was missing from `ctxStub` too, so the moment the bundle was rebuilt honestly, `apply()`
   * threw on `ctx.shortcuts.register` and took all 33 tests with it. This asserts the shape
   * that actually ships: one command per page switch, `defaults` keyed `<runtime>:<platform>`.
   */
  it('registers one shortcut command per page switch on ctx.shortcuts', () => {
    // The three page commands and 「在新标签页中连接」 share one registry, so they are counted apart
    // rather than lumped together: a test that only counted "some commands" would keep
    // passing if one of the four were dropped.
    //
    // All three pages are still listed together even though only two of them are pages of one tab:
    // 资产 is its own tab kind now, and its command **reveals** that tab rather than switching a
    // page — see `assetsCommand`.
    const modeCommands = harness.shortcutRegistrations.filter((command) =>
      String(command.id).startsWith('atTerminal.mode.')
    );
    expect(modeCommands.map((command) => String(command.id)).sort()).toEqual([
      'atTerminal.mode.assets',
      'atTerminal.mode.sftp',
      'atTerminal.mode.terminal'
    ]);
    for (const command of modeCommands) {
      expect(typeof command.id).toBe('string');
      expect(typeof (command.label as () => string)).toBe('function');
      // `regions` decides where the gesture is honoured. `page` alone would make the
      // switch unreachable from the panel's own inputs and the embedded terminal, which
      // is where a user paging between views actually is.
      expect(command.regions).toEqual(['page', 'editable', 'terminal']);
      // There is no top-level `run`: the click belongs inside `resolve`, because the
      // dispatcher skips `run` on key repeat and the menu path calls `resolve` directly.
      expect(command.run).toBeUndefined();
      expect(typeof (command.resolve as (arg: { target: unknown }) => unknown)).toBe('function');
      const defaults = command.defaults as Record<string, unknown>;
      expect(defaults).toBeDefined();
      // The **web** entries are the point. `web:linux` is omitted on purpose (browsers
      // there reserve every combination we would pick), but `web:macos`/`web:windows` are
      // present and carry **two** modifiers, because a single modifier is not admitted in
      // a browser — see `assertWebBindingAdmitted` below, which is the real rule.
      expect(Object.keys(defaults).sort()).toEqual([
        'desktop:linux',
        'desktop:macos',
        'desktop:windows',
        'web:macos',
        'web:windows'
      ]);
      for (const binding of Object.values(defaults)) {
        // A physical `KeyboardEvent.code` plus logical modifiers — there is no "Mod+P"
        // string form, and `primary` expands per platform.
        expect(typeof (binding as { code: unknown }).code).toBe('string');
        expect(Array.isArray((binding as { modifiers: unknown }).modifiers)).toBe(true);
      }
    }
  });

  /**
   * Both kinds' seats, keyed by each definition's **id**.
   *
   * The key is the id and not the kind — `entryKey: definition?.id ?? tab.kind` — so two types need
   * two ids as well as two kinds, and a copy-paste that reused one id would leave one of the two
   * bodies unreachable rather than merely mislabelled.
   */
  it('injects a body and a title seat per kind, keyed by each definition id', () => {
    expect(harness.slotInjects).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
      'shell.overlay',
      'conversation.session.header.corner'
    ]);
    const bodies = harness.slotRegisters
      .filter((entry) => entry.options.name === 'sidebar.right.pane.tab')
      .map((entry) => entry.options.key);
    expect(bodies).toEqual([ASSETS_KEY, SESSION_KEY, MONITOR_KEY]);
    const titles = harness.slotRegisters
      .filter((entry) => entry.options.name === 'sidebar.right.pane.tab.title')
      .map((entry) => entry.options.key);
    expect(titles).toEqual([ASSETS_KEY, SESSION_KEY, MONITOR_KEY]);
    // All bodies declare the locale namespace, because all render copy.
    for (const entry of harness.slotRegisters) {
      if (entry.options.name === 'sidebar.right.pane.tab') {
        expect(entry.options.locale).toBe('atTerminal');
      }
    }
  });

  it('injects the real reused stylesheets once, scoped, and removes them on dispose', () => {
    const style = harness.styles.get('at-terminal-client-styles');
    expect(style).toBeDefined();
    // Real bytes from the three reused sheets, scoped under the panel root.
    expect(style?.textContent).toContain('.att-root .terminal-shell');
    expect(style?.textContent).toContain('.att-root .server-form');
    expect(style?.textContent).toContain('.att-root .xterm');
    expect(style?.textContent).toContain('--vscode-terminal-background: var(--dsw-alias-bg-base');
    expect(style?.textContent).not.toMatch(/(^|\})\s*body\s*\{/);
    // A second activation must not stack a second copy.
    harness.apply();
    expect([...harness.styles.values()]).toHaveLength(1);
    // Disposal takes the CSS with it.
    for (const effect of harness.effects) effect.dispose();
    expect(harness.styles.get('at-terminal-client-styles')?.removed).toBe(true);
  });

  it('announces the arrival to the Host as client.hello', () => {
    // Fire-and-forget by construction: the Host records it so "the tab did not
    // appear" and "the client half never loaded" stay distinguishable.
    expect(harness.announces.length).toBeGreaterThanOrEqual(1);
    expect(harness.announces[0]).toMatchObject({ kind: 'at-terminal' });
  });
});

describe('client bundle — assets page', () => {
  it('renders the list-only assets page with toolbar actions, no inline row buttons', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    const tree = await harness.settle();

    for (const action of ['new-server', 'import', 'export', 'refresh']) {
      expect(findByAction(tree, action), `toolbar action ${action}`).not.toBeNull();
    }
    // **No page nav.** The manager used to sit behind a 资产/文件/终端 switch sharing a body with the
    // terminal; the connection pages are their own tab kind now. Asserted as an absence, because a
    // nav left behind would look like a working control and would put a connection's pages inside
    // the manager's tab — the thing this split removed.
    for (const action of ['mode-assets', 'mode-sftp', 'mode-terminal']) {
      expect(findByAction(tree, action), `page nav ${action} must be gone`).toBeNull();
    }
    // Nor is there a terminal to drive: no selector, no 连接, and no view element at all.
    expect(findByAction(tree, 'term-select')).toBeNull();
    expect(findByAction(tree, 'term-connect')).toBeNull();
    expect(findByFunctionName(tree, 'TerminalView')).toBeNull();
    // And the body says which surface it is, which is what the shortcut command reads.
    expect(findByAttribute(tree, 'data-at-terminal-body')?.props['data-at-terminal-body']).toBe('assets');
    // The rows: identity only — management lives in the toolbar and the context menu.
    const rows = findAllByClass(tree, 'att-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const buttons: ElementLike[] = [];
      walk(row.props.children, (node) => {
        if (node.type === 'button') buttons.push(node);
      });
      expect(buttons).toHaveLength(0);
    }
    // Group heading for the named group, and the grouped server is under it.
    const text = collectText(tree);
    expect(text).toContain('prod');
    expect(text).toContain('未分组');
    expect(text).toContain('root@10.0.0.1:22');
    expect(text).toContain('已存口令');
    // The status bar carries the summary counts.
    expect(text).toContain('服务器：2');
    expect(text).toContain('私钥文件：3');
  });

  it('collapses and expands a server group on click', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    await harness.settle();

    expect(findAllByClass(harness.tree, 'att-row')).toHaveLength(2);
    const prodGroup = findAllByClass(harness.tree, 'att-group-name').find((el) => el.props['data-at-terminal-group'] === 'prod');
    expect(prodGroup).toBeDefined();

    (prodGroup?.props.onClick as () => void)();
    harness.render();

    expect(findAllByClass(harness.tree, 'att-row')).toHaveLength(1);

    (prodGroup?.props.onClick as () => void)();
    harness.render();

    expect(findAllByClass(harness.tree, 'att-row')).toHaveLength(2);
  });

  it('renders a failed read as a failure with its code — never as an empty list', async () => {
    const harness = createHarness();
    harness.apply();
    harness.setRpcHandler('servers.list', () => {
      throw Object.assign(new Error('the services are still starting'), { code: 'services-unavailable' });
    });
    const tree = await harness.settle();

    const banner = findByAttribute(tree, 'data-at-terminal-error');
    expect(banner).not.toBeNull();
    expect(banner?.props['data-at-terminal-error']).toBe('services-unavailable');
    const text = collectText(tree);
    expect(text).toContain('services-unavailable');
    expect(text).not.toContain('还没有服务器');
  });

  it('opens the context menu on a row and deletes through it behind a confirm', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    harness.setRpcHandler('servers.remove', (params) => {
      expect(params).toEqual({ id: 'srv-prod-1' });
      return { removed: true };
    });
    await harness.settle();

    const row = findByAttribute(harness.tree, 'data-at-terminal-row');
    expect(row).not.toBeNull();
    (row?.props.onContextMenu as (event: unknown) => void)({
      preventDefault() {},
      clientX: 40,
      clientY: 60
    });
    harness.render();

    const menu = findAllByClass(harness.tree, 'att-menu');
    expect(menu).toHaveLength(1);
    for (const item of ['menu-connect', 'menu-edit', 'menu-copy', 'menu-remove']) {
      expect(findByAction(harness.tree, item), `menu item ${item}`).not.toBeNull();
    }

    (findByAction(harness.tree, 'menu-remove')?.props.onClick as () => void)();
    await harness.settle();
    expect(harness.confirms).toHaveLength(1);
    expect(harness.confirms[0]).toContain('web-01');
    expect(harness.rpcCalls.some((call) => call.method === 'servers.remove')).toBe(true);
  });

  it('copies the row address through the context menu', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    await harness.settle();
    const row = findByAttribute(harness.tree, 'data-at-terminal-row');
    (row?.props.onContextMenu as (event: unknown) => void)({ preventDefault() {}, clientX: 1, clientY: 1 });
    harness.render();
    (findByAction(harness.tree, 'menu-copy')?.props.onClick as () => void)();
    harness.render();
    expect(harness.clipboard).toEqual(['root@10.0.0.1:22']);
  });

  it('cancels the delete when the confirm is refused', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    harness.setConfirmAnswer(false);
    await harness.settle();
    const row = findByAttribute(harness.tree, 'data-at-terminal-row');
    (row?.props.onContextMenu as (event: unknown) => void)({ preventDefault() {}, clientX: 1, clientY: 1 });
    harness.render();
    (findByAction(harness.tree, 'menu-remove')?.props.onClick as () => void)();
    await harness.settle();
    expect(harness.confirms).toHaveLength(1);
    expect(harness.rpcCalls.some((call) => call.method === 'servers.remove')).toBe(false);
  });
});

describe('client bundle — form page', () => {
  it('opens on 新增, reuses the VS Code form markup, and refuses an incomplete save', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    await harness.settle();

    (findByAction(harness.tree, 'new-server')?.props.onClick as () => void)();
    harness.render();

    // The reused stylesheet's own class vocabulary, from .server-form-shell down.
    expect(findAllByClass(harness.tree, 'server-form-shell')).toHaveLength(1);
    expect(findAllByClass(harness.tree, 'form-section-grid')).toHaveLength(1);
    expect(findAllByClass(harness.tree, 'auth-card')).toHaveLength(3);
    expect(findAllByClass(harness.tree, 'form-footer')).toHaveLength(1);
    expect(findByAction(harness.tree, 'server-form-submit')).not.toBeNull();

    // Submit with everything blank: inline validation, no RPC.
    submitForm(harness);
    harness.render();
    const validation = findByAttribute(harness.tree, 'data-at-terminal-validation');
    expect(validation?.props['data-at-terminal-validation']).toBe('label');
    expect(harness.rpcCalls.some((call) => call.method === 'servers.save')).toBe(false);
  });

  it('saves a filled form as the DshServerInput the Host expects, then returns to the list', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    harness.setRpcHandler('servers.save', (params) => {
      expect(params).toEqual({
        server: {
          label: 'new-box',
          host: '10.1.1.1',
          username: 'ops',
          port: 22,
          authType: 'password',
          encoding: 'utf-8',
          keepAliveInterval: 30,
          agentCommandTrust: 'none',
          group: 'prod',
          password: 'secret'
        }
      });
      return { id: 'srv-new', label: 'new-box' };
    });
    await harness.settle();
    (findByAction(harness.tree, 'new-server')?.props.onClick as () => void)();
    harness.render();

    const fill = (action: string, value: string) => {
      const element = findByAction(harness.tree, action);
      expect(element, action).not.toBeNull();
      (element?.props.onChange as (event: unknown) => void)({ target: { value } });
      harness.render();
    };
    fill('server-form-label', 'new-box');
    fill('server-form-host', '10.1.1.1');
    fill('server-form-username', 'ops');
    fill('server-form-password', 'secret');
    fill('server-form-group', 'prod');

    submitForm(harness);
    await harness.settle();

    expect(harness.rpcCalls.some((call) => call.method === 'servers.save')).toBe(true);
    // Back on the list, with the saved notice.
    expect(findAllByClass(harness.tree, 'server-form-shell')).toHaveLength(0);
    expect(collectText(harness.tree)).toContain('已保存 new-box');
  });

  it('switches auth through the cards and only shows the matching field', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    await harness.settle();
    (findByAction(harness.tree, 'new-server')?.props.onClick as () => void)();
    harness.render();

    const card = findAllByClass(harness.tree, 'auth-card').find(
      (element) => element.props['data-auth-option'] === 'privateKey'
    );
    (card?.props.onClick as () => void)();
    harness.render();

    const form = findAllByClass(harness.tree, 'server-form')[0];
    expect(String(form.props.className)).toContain('auth-private-key');
    expect(findByAction(harness.tree, 'server-form-private-key-path')).not.toBeNull();
    // The password field stays in the tree — the reused stylesheet hides it via
    // the `.auth-private-key .auth-password-field` rule, exactly as in VS Code.
  });
});

describe('client bundle — import/export dialogs', () => {
  it('refuses an export without a package password, then downloads the Host envelope', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    harness.setRpcHandler('assets.export', (params) => {
      expect(params).toEqual({
        includePasswords: false,
        includePrivateKeys: false,
        packagePassword: 'pw'
      });
      return { filename: 'assets.at-terminal-assets', envelope: '{"v":1}', omissions: 2 };
    });
    await harness.settle();
    (findByAction(harness.tree, 'export')?.props.onClick as () => void)();
    harness.render();

    // No password yet: a coded failure inside the dialog, no RPC.
    (findByAction(harness.tree, 'export-submit')?.props.onClick as () => void)();
    harness.render();
    expect(findByAttribute(harness.tree, 'data-at-terminal-error')?.props['data-at-terminal-error']).toBe(
      'bad-params'
    );
    expect(harness.rpcCalls.some((call) => call.method === 'assets.export')).toBe(false);

    const password = findByAction(harness.tree, 'export-password');
    (password?.props.onChange as (event: unknown) => void)({ target: { value: 'pw' } });
    harness.render();
    (findByAction(harness.tree, 'export-submit')?.props.onClick as () => void)();
    await harness.settle();

    expect(harness.rpcCalls.some((call) => call.method === 'assets.export')).toBe(true);
    expect(harness.anchors).toHaveLength(1);
    expect(harness.anchors[0].download).toBe('assets.at-terminal-assets');
    expect(collectText(harness.tree)).toContain('已导出');
  });

  it('sends the picked file bytes to the Host for import and renders the counters', async () => {
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    harness.setRpcHandler('assets.import', (params) => {
      expect(params).toEqual({ envelope: 'PACKAGE', packagePassword: 'pw', strategy: 'rename' });
      return { summary: { imported: 2, skipped: 1, overwritten: 0, renamed: 1, privateKeysWritten: 2 } };
    });
    await harness.settle();
    (findByAction(harness.tree, 'import')?.props.onClick as () => void)();
    harness.render();

    const fileInput = findByAction(harness.tree, 'import-file');
    const file = { name: 'pack.at-terminal-assets', text: async () => 'PACKAGE' };
    (fileInput?.props.onChange as (event: unknown) => void)({ target: { files: [file] } });
    harness.render();
    const password = findByAction(harness.tree, 'import-password');
    (password?.props.onChange as (event: unknown) => void)({ target: { value: 'pw' } });
    harness.render();
    const strategy = findByAction(harness.tree, 'import-strategy');
    (strategy?.props.onChange as (event: unknown) => void)({ target: { value: 'rename' } });
    harness.render();
    (findByAction(harness.tree, 'import-submit')?.props.onClick as () => void)();
    await harness.settle();

    expect(harness.rpcCalls.some((call) => call.method === 'assets.import')).toBe(true);
    const text = collectText(harness.tree);
    expect(text).toContain('导入完成');
    expect(text).toContain('新增 2');
    expect(text).toContain('写入私钥 2');
  });
});

describe('client bundle — terminal over the websocket', () => {
  it('connects in this tab and speaks the terminal.* protocol', async () => {
    const harness = createSessionHarness();
    await connectInThisTab(harness);

    expect(harness.sockets).toHaveLength(1);
    const socket = harness.sockets[0];
    expect(socket.url).toBe('ws://127.0.0.1:19387/dsh-at-terminal/ws');

    // The Host greets first; the panel then asks for the PTY.
    socket.receive({ type: 'hello', seq: 1 });
    harness.render();
    expect(socket.sent[0]).toMatchObject({ type: 'terminal.open', id: 'at-terminal-pane', serverId: 'srv-prod-1' });
    expect(typeof (socket.sent[0] as { rows: number }).rows).toBe('number');

    socket.receive({ type: 'terminal.opened', id: 'at-terminal-pane', seq: 1 });
    harness.render();
    expect(socket.sent.some((frame) => frame.type === 'terminal.resize')).toBe(true);
  });

  /**
   * The other half of the double-click, and the half that decides whether it worked.
   *
   * `openTab(kind, { params })` only *creates* a tab; something has to read the params back and
   * connect, or the user gets the empty panel this change exists to remove. That reader is
   * `useTabParams` — the tab's params, subscribed rather than read once, because the frame's write
   * can land after this body's first render — feeding `adoptSessionTarget` + `maybeAutoConnect`, and
   * this is the only test that reaches the params source at its most favourable order. The row
   * gesture itself can only be asserted as far as "the frame was asked, with a server".
   *
   * Reverse-tested: changing the `params` key (or dropping the connect) fails the `serverId`
   * assertion below while every other test in this file still passes.
   */
  it('connects the tab the frame opened for a server, from the params it carried', async () => {
    const harness = await createSessionHarness();

    await renderTabWith(harness, { serverId: 'srv-prod-1' });

    expect(harness.sockets, 'the new tab opens its own socket').toHaveLength(1);
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    await renderTabWith(harness, { serverId: 'srv-prod-1' });
    expect(socket.sent[0]).toMatchObject({ type: 'terminal.open', serverId: 'srv-prod-1' });

    // The panel is on the terminal page with that server selected, not sitting on the asset list
    // waiting to be told again — which is exactly what the user reported.
    const view = findByFunctionName(harness.tree, 'TerminalView');
    expect(view?.props.selectedServerId).toBe('srv-prod-1');
    expect(view?.props.visible).toBe(true);
  });

  it('holds a terminal tab opened without a server idle, spending no connection', async () => {
    const harness = await createSessionHarness();

    await renderTabWith(harness, {});

    // A terminal tab with no `params` — the shortcut's `blocked` path is supposed to prevent this,
    // and this is what it looks like if one arrives anyway: idle, no socket, waiting for the user to
    // pick a server. Not an empty *asset list*, which is what the pre-split body did and what made a
    // failed open indistinguishable from a successful one.
    expect(harness.sockets).toHaveLength(0);
    const view = findByFunctionName(harness.tree, 'TerminalView');
    expect(view?.props.visible).toBe(true);
    expect(view?.props.selectedServerId).toBe('');
    expect((view?.props.termState as { kind?: string }).kind).toBe('idle');
  });

  /**
   * The order the frame actually produces, which the first render cannot see.
   *
   * `openTab`'s `params` are recorded by the frame in its own `onCommitted` callback
   * (`dsh-client-ui-sidebar-right` → `place()` → `tabDomain.navigate`), while the tab's occurrence
   * can already have been created a moment earlier with `params: undefined` by the seat's
   * reconciliation with the committed layout. `useTabInfo` does not re-render on that write either —
   * its memo lists the navigation *handle*, whose identity is stable for the tab's lifetime — so a
   * body that reads the params once at mount keeps whatever it saw, forever. That is the failure this
   * test pins: a double-clicked asset opening a terminal tab with **nothing selected**, which reads
   * as "the double-click did not connect".
   *
   * The connection therefore may not be a mount-time decision. It hangs off the **target**, and the
   * target is adopted whenever it becomes visible — including one render after the mount, which is
   * what this drives by writing the params the way the frame does.
   *
   * Reverse-tested: reading the params once at mount (and connecting from a mount `useRef`) fails
   * here — no socket is ever opened — while every other test in this file still passes.
   */
  it('connects when the frame writes the params after the first render', async () => {
    const harness = await createSessionHarness();
    await renderTabWith(harness, {});
    expect(harness.sockets, 'nothing to connect to yet').toHaveLength(0);
    // Subscribed, not merely read: on a real frame nothing else would tell this body that the write
    // happened. Asserted before the write so a body that only reads cannot pass on the timing.
    expect(harness.navigationListeners(), 'the body listens to the tab’s navigation').toBeGreaterThan(0);

    // The frame's own write, a moment later. Every subscriber hears it, as the occurrence's store
    // delivers it.
    harness.setTabParams({ serverId: 'srv-prod-1' });
    await harness.settle();

    expect(harness.sockets, 'the late params still start the connection').toHaveLength(1);
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    await harness.settle();
    expect(socket.sent[0]).toMatchObject({ type: 'terminal.open', serverId: 'srv-prod-1' });

    const view = findByFunctionName(harness.tree, 'TerminalView');
    expect(view?.props.selectedServerId, 'and the panel is pointed at it').toBe('srv-prod-1');
  });

  /**
   * The fallback for the frame handing the tab nothing at all.
   *
   * `params` is the documented channel and the one worth relying on; this is the net under it. The
   * opener remembers the gesture (`stashSessionSeed`) and the tab adopts it only if it is new enough
   * to be that gesture's tab, so a stale seed cannot retarget a tab the user has since used. Kept
   * because the requirement is "double-click and you are connecting", and a channel the plugin does
   * not own may not carry it — the diagnostic line the session body logs says which source won.
   */
  it('connects from the opener’s seed when the frame hands the tab no params', async () => {
    // Deliberately not `createSessionHarness`: the seed only belongs to a tab created **after** the
    // gesture, and that helper mounts a tab before the test can make one.
    const harness = createHarness({ body: 'session' });
    harness.apply();
    primeHappyPath(harness);

    // The keyboard half of the row gesture: it resolves a server from the focused panel and asks the
    // frame for a terminal tab — the same `openSessionTab` a double-click reaches.
    const command = harness.shortcutRegistrations.find((entry) => entry.id === 'atTerminal.newTab');
    const resolved = (command?.resolve as (arg: unknown) => { status: string; run?: () => void })(
      gestureIn(fakePanel('terminal', { select: 'srv-dev-1' }))
    );
    expect(resolved.status).toBe('handled');
    (resolved.run as () => void)();
    // The frame was asked, with the server — the request itself is asserted in the manager's own
    // tests; what matters here is only that the gesture left its memory behind.
    expect(harness.openTabCalls).toHaveLength(1);

    // A tab the frame then opened **without** params: the case the net exists for.
    await renderTabWith(harness, {});

    expect(harness.sockets, 'the seed is what the gesture left behind').toHaveLength(1);
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    await harness.settle();
    expect(socket.sent[0]).toMatchObject({ type: 'terminal.open', serverId: 'srv-dev-1' });
  });

  it('pauses the Host when unrendered output crosses the threshold', async () => {
    const harness = await createSessionHarness();
    await connectInThisTab(harness);
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    socket.receive({ type: 'terminal.opened', id: 'at-terminal-pane', seq: 1 });
    harness.render();

    // The engine is not attached in this harness (no real DOM), so output buffers —
    // exactly the slow-renderer case the pause frame exists for.
    const chunk = Buffer.alloc(64 * 1024, 0x61).toString('base64');
    for (let index = 0; index < 5; index += 1) {
      socket.receive({ type: 'terminal.output', id: 'at-terminal-pane', data: chunk });
    }
    harness.render();
    const pauses = socket.sent.filter((frame) => frame.type === 'terminal.pause');
    expect(pauses).toEqual([{ type: 'terminal.pause', id: 'at-terminal-pane', paused: true }]);
  });

  it('surfaces a host-key refusal with its fingerprint and an explicit trust action', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('terminal.trustHost', (params) => {
      expect(params).toEqual({ serverId: 'srv-prod-1', fingerprint: 'SHA256:abc' });
      return { trusted: true, host: '10.0.0.1', port: 22 };
    });
    await connectInThisTab(harness);
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    socket.receive({
      type: 'terminal.error',
      id: 'at-terminal-pane',
      code: 'host-key-unknown',
      message: '10.0.0.1:22 is not a known host.',
      fingerprint: 'SHA256:abc'
    });
    harness.render();

    const banner = findByAttribute(harness.tree, 'data-at-terminal-error');
    expect(banner?.props['data-at-terminal-error']).toBe('host-key-unknown');
    expect(collectText(harness.tree)).toContain('SHA256:abc');
    // The attempt is over: sitting on "connecting" while a banner asks the user to
    // decide about the key is the state that hides the action.
    expect(
      (findByFunctionName(harness.tree, 'TerminalView')?.props.termState as { kind?: string }).kind
    ).toBe('disconnected');

    (findByAction(harness.tree, 'term-trust')?.props.onClick as () => void)();
    await harness.settle();
    expect(harness.rpcCalls.some((call) => call.method === 'terminal.trustHost')).toBe(true);
    expect(collectText(harness.tree)).toContain('已信任');
  });

  /**
   * Bug #1: accepting a key must finish the job.
   *
   * The user clicked 信任该主机 to get a terminal; making them navigate back to the server
   * list and click 连接 again turns one decision into three steps, and the refusal is gone
   * by then so there is nothing telling them what to redo. Reverse-tested: dropping the
   * `doConnect` call in `doTrust` fails this.
   */
  it('reconnects by itself after the user accepts the host key', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('terminal.trustHost', () => ({ trusted: true, host: '10.0.0.1', port: 22 }));
    await connectInThisTab(harness);
    harness.sockets[0].receive({ type: 'hello', seq: 1 });
    harness.sockets[0].receive({
      type: 'terminal.error',
      id: 'at-terminal-pane',
      code: 'host-key-unknown',
      message: '10.0.0.1:22 is not a known host.',
      fingerprint: 'SHA256:abc'
    });
    harness.render();
    expect(harness.sockets).toHaveLength(1);

    (findByAction(harness.tree, 'term-trust')?.props.onClick as () => void)();
    await harness.settle();
    harness.render();

    // A fresh socket, not the refused one: the retry is a real connect attempt.
    expect(harness.sockets.length).toBeGreaterThan(1);
    expect(
      (findByFunctionName(harness.tree, 'TerminalView')?.props.termState as { kind?: string }).kind
    ).toBe('connecting');
    // The refusal is cleared, otherwise it would sit on top of the attempt that is fixing it.
    expect(findByAttribute(harness.tree, 'data-at-terminal-error')).toBeNull();
    // …and the outcome is still reported, because a silent retry looks like nothing happened.
    expect(collectText(harness.tree)).toContain('已信任 10.0.0.1:22');
  });

  /**
   * Bug #2, from the panel's side: the trust request must name the host that refused.
   *
   * With a jump host the refused host is the bastion, so sending only `serverId` makes the
   * Host record the bastion's key under the target's address — and the retry is refused
   * again. Reverse-tested: dropping `host`/`port` from this call fails the assertion.
   */
  it('sends the refused jump host with the trust request, not just the selected server', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('terminal.trustHost', (params) => {
      expect(params).toEqual({
        serverId: 'srv-prod-1',
        fingerprint: 'SHA256:bastion',
        host: '18.199.246.45',
        port: 22
      });
      return { trusted: true, host: '18.199.246.45', port: 22 };
    });
    await connectInThisTab(harness);
    harness.sockets[0].receive({ type: 'hello', seq: 1 });
    harness.sockets[0].receive({
      type: 'terminal.error',
      id: 'at-terminal-pane',
      code: 'host-key-unknown',
      message: '18.199.246.45:22 is not a known host.',
      fingerprint: 'SHA256:bastion',
      host: '18.199.246.45',
      port: 22
    });
    harness.render();

    (findByAction(harness.tree, 'term-trust')?.props.onClick as () => void)();
    await harness.settle();
    const call = harness.rpcCalls.find((entry) => entry.method === 'terminal.trustHost');
    expect(call?.params).toMatchObject({ host: '18.199.246.45', port: 22 });
    // The banner names what was trusted, so the user can see it was the bastion and not
    // the machine they picked from the list.
    expect(collectText(harness.tree)).toContain('已信任 18.199.246.45:22');
  });

  /**
   * The escape hatch for a poisoned entry, offered only where it is honest.
   *
   * `host-key-changed` means the stored key disagrees with the host — either a real key
   * change worth stopping for, or an entry some earlier build filed under the wrong
   * address. Either way "clear it and ask again" is the option that does not require the
   * user to accept a fingerprint they cannot check. It is deliberately **not** offered on
   * `host-key-unknown`, where there is nothing stored to clear.
   */
  /**
   * The row gesture is the way a second terminal starts, and it is the **only** one on the panel.
   *
   * It used to be a 「新建终端」 toolbar button calling a nameless `openTab`, and it did not work:
   * the tab opened, but with no server in it, so the user landed back on the asset list choosing a
   * connection — which reads as "the button did nothing" (the diagnostics log of 2026-10-08 shows
   * exactly that: a new chip appearing, its body rendering `mode=assets`, and the older tab's chip
   * losing its host).
   *
   * Three things are asserted, and they are the whole contract of the gesture: the frame is asked
   * for a **terminal** tab, that tab **names the server**, and this page grows no terminal of its
   * own — no view, no socket, no toolbar it could have been connected from.
   *
   * Reverse-tested both ways — dropping `params` fails the option assertion, and restoring the
   * button fails the absence assertion.
   */
  it('opens a terminal tab naming the server on a row double-click, and grows no terminal of its own', async () => {
    // The **assets** body, because that is where the rows are: this test is about the gesture a user
    // makes on the manager, and about what the manager does *not* do with it.
    const harness = createHarness();
    harness.apply();
    primeHappyPath(harness);
    await harness.settle();

    const row = findByAttribute(harness.tree, 'data-at-terminal-row');
    expect(row, 'a server row').not.toBeNull();
    (row?.props.onDoubleClick as () => void)();
    harness.render();

    // The whole request: a tab of the **terminal** kind, and the server it is for. Without `params`
    // the new body has nothing to connect to and the user is back where the report started.
    expect(harness.openTabCalls).toEqual([
      { kind: 'at-terminal-session', options: { params: { serverId: 'srv-prod-1' } } }
    ]);
    // No socket here: the connect belongs to the tab the frame is about to mint, and only that tab's
    // body can make it. A socket *here* would mean the manager had a connection of its own — which is
    // exactly what the tab split removed, and what made a double-click replace the current terminal
    // instead of opening a second one.
    expect(harness.sockets).toHaveLength(0);
    expect(findByFunctionName(harness.tree, 'TerminalView')).toBeNull();
    expect(findByAction(harness.tree, 'term-new-tab')).toBeNull();
  });

  /**
   * The thing this whole change is about: **an SSH connection does not end when its tab is not on
   * screen.**
   *
   * The frame unmounts a background tab's body — this plugin deliberately does not set
   * `keepMounted` — so before the session registry existed, every tab switch tore the socket down
   * and every switch back opened a new one. The evidence is in `~/.dsh/at-terminal/client-diagnostics.log`
   * for 2026-10-08: a chip going `connected` → `connecting` again as the user moved between two
   * terminals.
   *
   * Driving it needs `unmount()`, because the shim's `render()` never runs a cleanup: that is the
   * one thing no other assertion in this file can see. The reverse change — putting the teardown back
   * on the body's unmount — fails here and nowhere else.
   */
  it('keeps its SSH connection when its tab goes to the background', async () => {
    const harness = await createSessionHarness();
    await renderTabWith(harness, { serverId: 'srv-prod-1' });

    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    socket.receive({ type: 'terminal.opened', id: 'at-terminal-pane', terminalId: 'host-term-1' });
    await renderTabWith(harness, { serverId: 'srv-prod-1' });
    expect((findByFunctionName(harness.tree, 'TerminalView')?.props.termState as { kind?: string }).kind).toBe(
      'connected'
    );

    // Another tab comes to the front, which for the frame means **unmounting this body**. Rendered
    // nothing in its place on purpose: the shim keeps one flat hook-slot array for whatever it
    // renders, so driving a second component through it would mix the two bodies' state and prove
    // nothing. The unmount is the whole of the event being modelled.
    harness.unmount();

    // The connection is untouched — the socket is open and the host was never asked to close the PTY.
    expect(socket.closed).toBe(false);
    expect(socket.sent.some((frame) => frame.type === 'terminal.close')).toBe(false);

    // And coming back is a **re-attach**, not a reconnect: the same socket, still connected.
    await renderTabWith(harness, { serverId: 'srv-prod-1' });
    expect(harness.sockets, 'no second connection was opened').toHaveLength(1);
    const view = findByFunctionName(harness.tree, 'TerminalView');
    expect((view?.props.termState as { kind?: string }).kind).toBe('connected');
    expect(view?.props.selectedServerId).toBe('srv-prod-1');
  });

  /**
   * …and it does end when the tab is closed — but only on evidence that the tab really is closed.
   *
   * Holding a connection open for a tab is only correct if closing the tab releases it, or two
   * things follow and both are bad: the remote host keeps an `sshd` session per tab ever opened, and
   * the plugin's own registry grows without bound. The two close paths exist because neither covers
   * the other: the frame's own removal calls a registered handler (asserted below), and a pane that
   * collapses, or a session that is cleared, leaves only two derived signals behind — the open-tab
   * **inventory** losing the tab, and the occurrence **signal** aborting.
   *
   * Those two are checked *together* here, on purpose. Either one alone is weaker than it looks: the
   * inventory is assembled per session store and a re-adopted store publishes an empty membership
   * for the moment before its layout lands, and killing a background terminal on that moment is
   * indistinguishable, from the user's side, from a connection that just drops when the tab is not on
   * screen. So the assertion order is the contract: a listed tab is held, a tab that falls out of a
   * snapshot while its occurrence is still live is **still held**, and only when the occurrence also
   * aborts is the session released.
   *
   * Reverse-tested: restoring the eager "not listed ⇒ dispose" reaper fails the second assertion.
   */
  it('holds a listed tab, and releases one only when the occurrence agrees it is gone', async () => {
    const harness = await createSessionHarness();
    await renderTabWith(harness, { serverId: 'srv-prod-1' });
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    socket.receive({ type: 'terminal.opened', id: 'at-terminal-pane', terminalId: 'host-term-1' });
    const contentId = 'sidebar://at-terminal-session/tab-under-test';

    // Listing it confirms the tab is open, which is what arms the reaper: it only removes a session
    // it has seen listed, because a snapshot taken before this window's layout is adopted would
    // otherwise read as "every tab closed" and kill a connection the user just made.
    harness.publishOpenTabs([{ kind: 'at-terminal-session', contentId }]);
    expect(socket.closed).toBe(false);
    expect(harness.sockets).toHaveLength(1);

    // The tab is gone from the snapshot (an unrelated kind is all that is left) but its occurrence
    // never aborted — the state a re-adoption produces. The connection is the user's; it stays.
    harness.publishOpenTabs([{ kind: 'at-terminal', contentId: 'sidebar://at-terminal' }]);
    expect(socket.closed, 'a live occurrence outranks a snapshot that lost the tab').toBe(false);
    expect(harness.sockets).toHaveLength(1);

    // Now the frame says the record left the layout. Both witnesses agree, and the session is
    // released — `teardown` closes the socket, and the Host reaps the PTY when it drops.
    harness.abortTab('tab-under-test');
    expect(socket.closed).toBe(true);
    expect(socket.sent.some((frame) => frame.type === 'terminal.close')).toBe(false);
  });

  /**
   * …and an abort that contradicts the inventory is not believed.
   *
   * The other direction of the same cross-check, and the one a user feels most: a signal that
   * aborts while the frame still lists the tab did not mean "the tab was closed", so acting on it
   * would kill a session the frame itself says is still open. Asserted as an absence of side effects
   * — no socket close, no `terminal.close` — because that is what "the SSH connection survived the
   * tab switch" looks like from here.
   */
  it('ignores an occurrence abort whose tab the inventory still lists', async () => {
    const harness = await createSessionHarness();
    await renderTabWith(harness, { serverId: 'srv-prod-1' });
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    socket.receive({ type: 'terminal.opened', id: 'at-terminal-pane', terminalId: 'host-term-1' });
    const contentId = 'sidebar://at-terminal-session/tab-under-test';

    harness.publishOpenTabs([{ kind: 'at-terminal-session', contentId }]);
    harness.abortTab('tab-under-test');

    expect(socket.closed).toBe(false);
    expect(socket.sent.some((frame) => frame.type === 'terminal.close')).toBe(false);
  });

  /** The frame's own removal, which hands the tab over before dropping the record. */
  it('closes the PTY when the frame closes the tab', async () => {
    const harness = await createSessionHarness();
    await renderTabWith(harness, { serverId: 'srv-prod-1' });
    const socket = harness.sockets[0];
    socket.receive({ type: 'hello', seq: 1 });
    socket.receive({ type: 'terminal.opened', id: 'at-terminal-pane', terminalId: 'host-term-1' });

    harness.closeTab('at-terminal-session', {
      id: 'tab-under-test',
      contentId: 'sidebar://at-terminal-session/tab-under-test'
    });
    expect(socket.closed).toBe(true);
    expect(socket.sent).toContainEqual({ type: 'terminal.close', id: 'at-terminal-pane' });
  });

  it('offers to clear the stored key on a changed-key refusal, and not on an unknown one', async () => {    const harness = await createSessionHarness();
    harness.setRpcHandler('terminal.forgetHost', (params) => {
      expect(params).toEqual({ serverId: 'srv-prod-1', host: '10.0.0.1', port: 22 });
      return { forgot: true, host: '10.0.0.1', port: 22 };
    });
    await connectInThisTab(harness);
    harness.sockets[0].receive({ type: 'hello', seq: 1 });

    harness.sockets[0].receive({
      type: 'terminal.error',
      id: 'at-terminal-pane',
      code: 'host-key-unknown',
      message: '10.0.0.1:22 is not a known host.',
      fingerprint: 'SHA256:aaa',
      host: '10.0.0.1',
      port: 22
    });
    harness.render();
    // Nothing is stored for an unknown host, so there is nothing to clear.
    expect(findByAction(harness.tree, 'term-forget')).toBeNull();

    harness.sockets[0].receive({
      type: 'terminal.error',
      id: 'at-terminal-pane',
      code: 'host-key-changed',
      message: 'differs',
      fingerprint: 'SHA256:bbb',
      host: '10.0.0.1',
      port: 22
    });
    harness.render();
    const forget = findByAction(harness.tree, 'term-forget');
    expect(forget).toBeDefined();
    // Trusting stays available: forgetting is the honest option, not the only one.
    expect(findByAction(harness.tree, 'term-trust')).toBeDefined();

    const before = harness.sockets.length;
    (forget?.props.onClick as () => void)();
    await harness.settle();
    harness.render();

    const call = harness.rpcCalls.find((entry) => entry.method === 'terminal.forgetHost');
    expect(call?.params).toMatchObject({ host: '10.0.0.1', port: 22 });
    // Clearing is only useful if the connect is retried, so the retry is not optional here.
    expect(harness.sockets.length).toBeGreaterThan(before);
  });

  /**
   * The toolbar carries no way to start another terminal.
   *
   * It used to, and the button could only ever open an **empty** tab: a body has no route to `ctx`,
   * so the capability reached it as a prop (`onNewTab`), and the tab it asked for named no server.
   * Starting a terminal now belongs to the gesture that names one — a row double-click on 资产, or
   * `atTerminal.newTab` — so both halves are asserted: the prop is gone, and the control is gone from
   * the rendered toolbar.
   *
   * Reached by instantiating the view element, because `TerminalView` cannot be imported here —
   * `react` is external and absent from `node_modules`, which is the whole reason this file drives
   * the built bundle in a vm. Safe to do **last** in the test: the shim keeps one hook-slot array for
   * everything it renders, so a second component mid-test would mix state with the body's.
   */
  it('leaves no 「新建终端」 affordance on the terminal toolbar', async () => {
    const harness = createSessionHarness();
    await harness.settle();

    const view = findByFunctionName(harness.tree, 'TerminalView');
    expect(view).not.toBeNull();
    expect(view?.props.onNewTab).toBeUndefined();

    const rendered = harness.shim.instantiate(view);
    // Non-vacuity: the walk finds the toolbar's **other** controls, so a bare `null` below means the
    // button is absent rather than the search being blind to this element.
    expect(findByAction(rendered as Tree, 'term-select')).not.toBeNull();
    expect(findByAction(rendered as Tree, 'term-connect')).not.toBeNull();
    expect(findByAction(rendered as Tree, 'term-new-tab')).toBeNull();
  });

  it('passes the Host terminal settings to the terminal view', async () => {
    const harness = createSessionHarness();
    await harness.settle();
    const terminalElement = findByFunctionName(harness.tree, 'TerminalView');
    expect(terminalElement).not.toBeNull();
    expect(terminalElement?.props.settings).toEqual({
      fontSize: 15,
      fontFamily: 'Fira Code, monospace',
      scrollback: 5000,
      semanticHighlight: true,
      zebraStripes: false
    });
    // A terminal tab opens on 终端 — the connection is what the tab is *for*, and the settings are
    // read once for the engine that page will host.
    expect(terminalElement?.props.visible).toBe(true);
  });

  it('connects over the Host-reported endpoint on a dsh-app:// page, never ws://app', async () => {
    // This is the exact defect the user hit: the Desktop shell serves the panel
    // from `dsh-app://app`, so a location-derived URL is `ws://app/...` — a name
    // nothing resolves. The client must ask the Host (rpc channel.info) and use
    // the loopback endpoint it reports.
    const harness = await createSessionHarness({
      location: { protocol: 'dsh-app:', host: 'app', origin: 'dsh-app://app', href: 'dsh-app://app/' }
    });

    await connectInThisTab(harness);
    // `connectSession` awaits channel.info before opening the socket on a non-http page.
    await flush();
    harness.render();

    expect(harness.rpcCalls.some((call) => call.method === 'channel.info')).toBe(true);
    expect(harness.sockets).toHaveLength(1);
    expect(harness.sockets[0].url).toBe('ws://127.0.0.1:19387/dsh-at-terminal/ws');
    expect(harness.sockets[0].url).not.toContain('ws://app');

    // And the terminal handshake still runs over the Host-provided socket.
    harness.sockets[0].receive({ type: 'hello', seq: 1 });
    harness.render();
    expect(harness.sockets[0].sent[0]).toMatchObject({ type: 'terminal.open', serverId: 'srv-prod-1' });
  });

  it('refuses to connect with a coded error when a dsh-app page gets no endpoint', async () => {
    const harness = await createSessionHarness({
      location: { protocol: 'dsh-app:', host: 'app', origin: 'dsh-app://app', href: 'dsh-app://app/' }
    });
    // channel.info answers with no wsUrl (e.g. the server has not bound a port yet).
    harness.setRpcHandler('channel.info', () => ({ host: '127.0.0.1', port: null, wsUrl: null }));

    await connectInThisTab(harness);
    await flush();
    harness.render();

    expect(harness.sockets).toHaveLength(0);
    const banner = findByAttribute(harness.tree, 'data-at-terminal-validation');
    expect(banner).not.toBeNull();
    // The coded refusal copy, not a ws://app URL and not a silent no-op.
    expect(collectText(harness.tree)).toContain('无法连接');
    expect(collectText(harness.tree)).not.toContain('ws://app');
  });
});

describe('client bundle — the file tree (DSH-23)', () => {
  /** Switch to the 文件 page the way a user does, through the nav button. */
  function openFilesPage(harness: Harness): void {
    const button = findByAction(harness.tree, 'mode-sftp');
    expect(button, 'the 文件 nav button').not.toBeNull();
    (button?.props.onClick as () => void)();
    harness.render();
  }

  /** Every disclosure button the page rendered, in tree order. */
  function disclosures(tree: Tree): ElementLike[] {
    const found: ElementLike[] = [];
    walk(tree, (node) => {
      if (node.props['data-at-terminal-action'] === 'sftp-toggle') found.push(node);
    });
    return found;
  }

  function toggle(harness: Harness, path: string): void {
    const button = disclosures(harness.tree).find((node) => node.props['data-at-terminal-path'] === path);
    expect(button, `a disclosure for ${path}`).not.toBeNull();
    (button?.props.onClick as () => void)();
  }

  /** The element carrying `data-at-terminal-sftp="<value>"`, if any. */
  function sftpNode(tree: Tree, value: string): ElementLike | null {
    let found: ElementLike | null = null;
    walk(tree, (node) => {
      if (found === null && node.props['data-at-terminal-sftp'] === value) found = node;
    });
    return found;
  }

  function rowsFor(tree: Tree, value: string): ElementLike[] {
    const found: ElementLike[] = [];
    walk(tree, (node) => {
      if (node.props['data-at-terminal-entry'] === value) found.push(node);
    });
    return found;
  }

  it('does not read the Host until the page is opened', async () => {
    // The read is the one Host call that can open an SSH connection. Doing it because the
    // *panel* mounted — while the user is looking at the server list — would be a side
    // effect nobody asked for, so the page latches its first read on being visited.
    //
    // Only "none before, some after" is asserted: the React shim re-runs every effect on
    // every render (it ignores dependency arrays), so a count after the page opens measures
    // the harness's render passes rather than the component's behaviour.
    const harness = await createSessionHarness();
    await harness.settle();

    const reads = () => harness.rpcCalls.filter((call) => call.method === 'sftp.list');
    expect(reads()).toHaveLength(0);

    openFilesPage(harness);
    await harness.settle();
    expect(reads().length).toBeGreaterThan(0);
  });

  it('renders "no active SSH terminal" rather than an empty directory', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('sftp.list', () => ({ kind: 'none', rootPath: null, path: null, entries: [] }));
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    expect(sftpNode(harness.tree, 'none')).not.toBeNull();
    const text = collectText(harness.tree);
    // The distinction that matters: "there is nothing connected" is not "this directory is
    // empty", and the page says which one it is.
    expect(text).toContain('没有活动的 SSH 终端');
    expect(text).not.toContain('该目录为空');
  });

  it('renders a live listing with `..`, directories and file sizes', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('sftp.list', () => ({
      kind: 'active',
      rootPath: '/home/root',
      path: '/home/root',
      serverId: 'srv-prod-1',
      serverLabel: 'web-01',
      entries: [
        { name: 'sub', path: '/home/root/sub', type: 'directory' },
        { name: 'app.log', path: '/home/root/app.log', type: 'file', size: 2048 }
      ]
    }));
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    expect(sftpNode(harness.tree, 'active')).toBeNull();
    // `..` is the first row, then the root's entries, in the Host's order.
    const rowNames = findAllByClass(harness.tree, 'att-tree-name').map((node) => collectText(node.props.children));
    expect(rowNames).toEqual(['..', 'sub', 'app.log']);
    expect(rowsFor(harness.tree, 'directory')).toHaveLength(1);
    expect(rowsFor(harness.tree, 'file')).toHaveLength(1);
    // Only the directory offers a disclosure; a file has nothing to open.
    expect(disclosures(harness.tree)).toHaveLength(1);
    expect(collectText(harness.tree)).toContain('2 KB');
  });

  it('expands a directory with one read, and reuses that read when reopened', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('sftp.list', (params) => {
      if (params.path === '/home/root/sub') {
        return { kind: 'active', rootPath: '/home/root', path: '/home/root/sub', entries: [{ name: 'deep.txt', path: '/home/root/sub/deep.txt', type: 'file' }] };
      }
      return {
        kind: 'active',
        rootPath: '/home/root',
        path: '/home/root',
        serverLabel: 'web-01',
        entries: [{ name: 'sub', path: '/home/root/sub', type: 'directory' }]
      };
    });
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    toggle(harness, '/home/root/sub');
    await harness.settle();
    expect(findAllByClass(harness.tree, 'att-tree-name').map((node) => collectText(node.props.children))).toEqual([
      '..',
      'sub',
      'deep.txt'
    ]);
    const childReads = () => harness.rpcCalls.filter((call) => call.method === 'sftp.list' && call.params.path === '/home/root/sub');
    expect(childReads()).toHaveLength(1);

    // Collapse and reopen: the tree keeps what it read, so the second open costs nothing.
    toggle(harness, '/home/root/sub');
    harness.render();
    expect(findAllByClass(harness.tree, 'att-tree-name').map((node) => collectText(node.props.children))).toEqual([
      '..',
      'sub'
    ]);
    toggle(harness, '/home/root/sub');
    harness.render();
    expect(childReads()).toHaveLength(1);
  });

  it('renders a failed child read under that directory, keeping the siblings', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('sftp.list', (params) => {
      if (params.path === '/home/root/private') {
        throw Object.assign(new Error('Permission denied reading /home/root/private.'), {
          code: 'sftp-permission-denied'
        });
      }
      return {
        kind: 'active',
        rootPath: '/home/root',
        path: '/home/root',
        serverLabel: 'web-01',
        entries: [
          { name: 'private', path: '/home/root/private', type: 'directory' },
          { name: 'app.log', path: '/home/root/app.log', type: 'file', size: 10 }
        ]
      };
    });
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    toggle(harness, '/home/root/private');
    await harness.settle();

    // The unreadable level is a **row in the tree**, not the page's failure banner: it sits
    // between two levels that read fine, so it carries `data-at-terminal-sftp-code` rather
    // than `data-at-terminal-error` and deliberately has no banner. A banner here would
    // report "something went wrong" about the whole panel when one directory is the problem.
    const failed = findByAttribute(harness.tree, 'data-at-terminal-sftp-code');
    expect(failed?.props['data-at-terminal-sftp-code']).toBe('sftp-permission-denied');
    // The code is the only part of the Host's failure that reaches the UI: its message
    // names a path on someone else's machine and would read as noise.
    expect(collectText(failed?.props.children)).not.toContain('/home/root/private/secret');
    // The failed level is a `treeitem` at its directory's level, and it does not claim to
    // expand: a read that produced no entries has nothing to disclose. It is also not a tab
    // stop — `sftpRowFocusable` excludes a read's state, and the retry button inside it is
    // what makes asking again reachable from the keyboard.
    expect(failed?.props.role).toBe('treeitem');
    expect(failed?.props['aria-expanded']).toBeUndefined();
    expect(failed?.props.tabIndex).toBeUndefined();
    // The siblings that read fine are still on screen — one unreadable directory must not
    // take the whole tree with it — and the failure sits **between** them, under the
    // directory it belongs to, carrying the copy its own code selected.
    expect(findAllByClass(harness.tree, 'att-tree-name').map((node) => collectText(node.props.children))).toEqual([
      '..',
      'private',
      '这一层没有读到：当前登录账号没有读取它的权限。',
      'app.log'
    ]);
  });

  it('renders a failed root read as a failure with its code, never as an empty tree', async () => {
    const harness = await createSessionHarness();
    harness.setRpcHandler('sftp.list', () => {
      throw Object.assign(new Error('the SFTP services were not assembled'), { code: 'services-unavailable' });
    });
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    const banner = findByAttribute(harness.tree, 'data-at-terminal-error');
    expect(banner?.props['data-at-terminal-error']).toBe('services-unavailable');
    expect(collectText(harness.tree)).not.toContain('该目录为空');
  });

  it('renders the last listing as explicitly disconnected', async () => {
    const harness = await createSessionHarness();
    let call = 0;
    harness.setRpcHandler('sftp.list', () => {
      call += 1;
      return call === 1
        ? {
            kind: 'active',
            rootPath: '/home/root',
            path: '/home/root',
            serverLabel: 'web-01',
            entries: [{ name: 'sub', path: '/home/root/sub', type: 'directory' }]
          }
        : {
            kind: 'disconnected',
            rootPath: '/home/root',
            path: '/home/root',
            serverLabel: 'web-01',
            entries: [{ name: 'sub', path: '/home/root/sub', type: 'directory' }]
          };
    });
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    // Refresh forces a second read; the terminal has since dropped.
    (findByAction(harness.tree, 'sftp-refresh')?.props.onClick as () => void)();
    await harness.settle();

    const banner = sftpNode(harness.tree, 'disconnected');
    expect(banner).not.toBeNull();
    expect(collectText(harness.tree)).toContain('终端已断开');
    // The stale level is still readable, but nothing offers to expand under it.
    expect(rowsFor(harness.tree, 'directory')).toHaveLength(1);
    expect(disclosures(harness.tree)).toHaveLength(0);
    // And no `..`: moving the root needs a live connection.
    expect(findAllByClass(harness.tree, 'att-tree-name').map((node) => collectText(node.props.children))).toEqual([
      'sub'
    ]);
  });

  it('offers 上一级 on a live tree and reaches `sftp.goUp` through it', async () => {
    const harness = await createSessionHarness();
    let root = '/home/root';
    harness.setRpcHandler('sftp.list', (params) => ({
      kind: 'active',
      rootPath: root,
      path: root,
      serverLabel: 'web-01',
      entries: params.path === undefined ? [{ name: 'sub', path: `${root}/sub`, type: 'directory' }] : []
    }));
    harness.setRpcHandler('sftp.goUp', () => {
      root = '/home';
      return { refreshed: true };
    });
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    (findByAction(harness.tree, 'sftp-up')?.props.onClick as () => void)();
    await harness.settle();

    expect(harness.rpcCalls.filter((call) => call.method === 'sftp.goUp')).toHaveLength(1);
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-path')?.props['data-at-terminal-sftp-path']).toBe('/home');
  });

  it('sends `sftp.refresh` before re-reading, so 刷新 is not a no-op inside the 20s cache', async () => {
    const harness = await createSessionHarness();
    const order: string[] = [];
    harness.setRpcHandler('sftp.refresh', () => {
      order.push('refresh');
      return { refreshed: true };
    });
    harness.setRpcHandler('sftp.list', () => {
      order.push('list');
      return { kind: 'active', rootPath: '/home/root', path: '/home/root', serverLabel: 'web-01', entries: [] };
    });
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();

    order.length = 0;
    (findByAction(harness.tree, 'sftp-refresh')?.props.onClick as () => void)();
    await harness.settle();

    expect(order).toContain('refresh');
    expect(order.indexOf('refresh')).toBeLessThan(order.indexOf('list'));
  });

  /* --------------------------- the file operations --------------------------- */

  /** A live tree holding one file and one directory, which every case below starts from. */
  async function liveTree(): Promise<Harness> {
    const harness = await createSessionHarness();
    harness.setRpcHandler('sftp.list', () => ({
      kind: 'active',
      rootPath: '/home/root',
      path: '/home/root',
      serverLabel: 'web-01',
      entries: [
        { name: 'app.js', path: '/home/root/app.js', type: 'file', size: 4 },
        { name: 'sub', path: '/home/root/sub', type: 'directory' }
      ]
    }));
    await harness.settle();
    openFilesPage(harness);
    await harness.settle();
    return harness;
  }

  /** The row for one entry, found by the path it carries as its `title`. */
  function rowFor(tree: Tree, path: string): ElementLike | null {
    let found: ElementLike | null = null;
    walk(tree, (node) => {
      if (found === null && node.props.title === path && node.props['data-at-terminal-entry'] !== undefined) {
        found = node;
      }
    });
    return found;
  }

  it('keeps 查看/编辑/下载 disabled until a **file** is selected', async () => {
    const harness = await liveTree();

    // Nothing selected: three controls that would have nothing to act on stay disabled
    // rather than being offered and then refusing.
    for (const action of ['sftp-file-view', 'sftp-file-edit', 'sftp-download']) {
      expect(findByAction(harness.tree, action)?.props.disabled, action).toBe(true);
    }

    // A directory row is not selectable at all: the three actions mean nothing for one.
    (rowFor(harness.tree, '/home/root/sub')?.props.onClick as (() => void) | undefined)?.();
    harness.render();
    expect(findByAction(harness.tree, 'sftp-file-view')?.props.disabled).toBe(true);

    // A file row is.
    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    for (const action of ['sftp-file-view', 'sftp-file-edit', 'sftp-download']) {
      expect(findByAction(harness.tree, action)?.props.disabled, action).toBe(false);
    }
    expect(rowFor(harness.tree, '/home/root/app.js')?.props['aria-selected']).toBe(true);
  });

  it('opens the viewer on 查看, with the read text and the line ending it reported', async () => {
    const harness = await liveTree();
    harness.setRpcHandler('sftp.readFile', () => ({
      path: '/home/root/app.js',
      text: 'const a = 1;\n',
      eol: 'crlf',
      size: 13,
      modifiedAt: 5,
      truncated: false
    }));

    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    (findByAction(harness.tree, 'sftp-file-view')?.props.onClick as () => void)();
    await harness.settle();

    const read = harness.rpcCalls.find((call) => call.method === 'sftp.readFile');
    expect(read?.params.path).toBe('/home/root/app.js');

    // The viewer is a `<pre>`, i.e. read-only by construction — no editable control exists
    // in view mode at all.
    const viewer = findByAttribute(harness.tree, 'data-at-terminal-sftp-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer?.props.children).toBe('const a = 1;\n');
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-editor')).toBeNull();
    // CRLF is shown, because the pane is *preserving* it — a silent convention is
    // indistinguishable from a silently changed one.
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-file-eol')?.props['data-at-terminal-sftp-file-eol'])
      .toBe('crlf');
  });

  it('edits in place and saves with the stat the read reported, so a conflict is detectable', async () => {
    const harness = await liveTree();
    harness.setRpcHandler('sftp.readFile', () => ({
      path: '/home/root/app.js',
      text: 'const a = 1;\n',
      eol: 'lf',
      size: 13,
      modifiedAt: 5,
      truncated: false
    }));
    const writes: Record<string, unknown>[] = [];
    harness.setRpcHandler('sftp.writeFile', (params) => {
      writes.push(params);
      return { path: params.path, size: 20, modifiedAt: 9 };
    });

    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    (findByAction(harness.tree, 'sftp-file-edit')?.props.onClick as () => void)();
    await harness.settle();

    // 编辑 offers an editor *without* a second read: the buffer is the file already fetched.
    expect(harness.rpcCalls.filter((call) => call.method === 'sftp.readFile')).toHaveLength(1);
    const editor = findByAttribute(harness.tree, 'data-at-terminal-sftp-editor');
    expect(editor).not.toBeNull();
    expect(editor?.props.value).toBe('const a = 1;\n');

    (editor?.props.onChange as (event: unknown) => void)({ target: { value: 'const a = 2;\n' } });
    harness.render();
    (findByAction(harness.tree, 'sftp-file-save')?.props.onClick as () => void)();
    await harness.settle();

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/home/root/app.js');
    expect(writes[0].text).toBe('const a = 2;\n');
    // The baseline the Host checks against, carried from the read. Without it the Host has
    // nothing to compare and a save would clobber whatever landed in the meantime.
    expect(writes[0].expectedSize).toBe(13);
    expect(writes[0].expectedModifiedAt).toBe(5);
    // The convention the read reported, sent back so the save undoes the textarea's
    // normalisation instead of rewriting every line ending.
    expect(writes[0].eol).toBe('lf');
    expect(writes[0].overwrite).toBe(false);
  });

  it('asks about a conflict and retries with `overwrite` only when the user says so', async () => {
    const harness = await liveTree();
    harness.setRpcHandler('sftp.readFile', () => ({
      path: '/home/root/app.js',
      text: 'x\n',
      eol: 'lf',
      size: 2,
      modifiedAt: 1,
      truncated: false
    }));
    let attempt = 0;
    const writes: Record<string, unknown>[] = [];
    harness.setRpcHandler('sftp.writeFile', (params) => {
      writes.push(params);
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('already changed') as Error & { code: string };
        error.code = 'sftp-conflict';
        throw error;
      }
      return { path: params.path, size: 3, modifiedAt: 2 };
    });

    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    (findByAction(harness.tree, 'sftp-file-edit')?.props.onClick as () => void)();
    await harness.settle();
    (findByAction(harness.tree, 'sftp-file-save')?.props.onClick as () => void)();
    await harness.settle();

    // The refusal is a **question**, not a failure banner: the user is the only one who can
    // say whose version to keep, and nothing has gone wrong yet — so the copy is the
    // conflict sentence and there is no `操作失败` heading anywhere on the page.
    expect(collectText(harness.tree)).toContain('已经改过');
    expect(collectText(harness.tree)).not.toContain('操作失败');
    const conflict = findByAction(harness.tree, 'sftp-file-overwrite');
    expect(conflict).not.toBeNull();
    // And the first attempt did *not* silently overwrite.
    expect(writes).toHaveLength(1);
    expect(writes[0].overwrite).toBe(false);

    (conflict?.props.onClick as () => void)();
    await harness.settle();
    expect(writes).toHaveLength(2);
    expect(writes[1].overwrite).toBe(true);
  });

  it('downloads the selected file through `sftp.download` and saves what came back', async () => {
    const harness = await liveTree();
    harness.setRpcHandler('sftp.download', () => ({
      path: '/home/root/app.js',
      name: 'app.js',
      size: 5,
      modifiedAt: 1,
      base64: 'aGVsbG8='
    }));

    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    (findByAction(harness.tree, 'sftp-download')?.props.onClick as () => void)();
    await harness.settle();

    const call = harness.rpcCalls.find((entry) => entry.method === 'sftp.download');
    expect(call?.params.path).toBe('/home/root/app.js');
    // The bytes reach the anchor's download attribute — the name the **Host** chose, not one
    // reassembled here from the path (a remote name the local filesystem could not hold is
    // sanitised on the Host, so a second opinion here would disagree with it).
    expect(harness.anchors[0].download).toBe('app.js');
  });

  it('uploads to the directory the tree is showing, and re-reads so the new row is visible', async () => {
    const harness = await liveTree();
    const uploads: Record<string, unknown>[] = [];
    harness.setRpcHandler('sftp.upload', (params) => {
      uploads.push(params);
      return { path: params.path, size: 5, modifiedAt: 1 };
    });
    const listsBefore = harness.rpcCalls.filter((call) => call.method === 'sftp.list').length;

    const input = findByAction(harness.tree, 'sftp-upload-input');
    expect(input).not.toBeNull();
    (input?.props.onChange as (event: unknown) => void)({
      // The harness's fake file carries its bytes as base64 (see the sandbox's FileReader).
      target: { files: [{ name: 'notes.txt', base64: 'aGVsbG8=' }], value: 'C:\\fakepath\\notes.txt' }
    });
    await harness.settle();

    expect(uploads).toHaveLength(1);
    // Joined onto the tree's root by the domain's own path rules, and named by the local
    // file — the two facts an upload cannot get wrong.
    expect(uploads[0].path).toBe('/home/root/notes.txt');
    expect(uploads[0].base64).toBe('aGVsbG8=');
    expect(uploads[0].overwrite).toBe(false);

    // The tree is re-read, because the 20-second listing cache would not contain the file
    // that was just written — the user would see their upload "fail" by not appearing.
    expect(harness.rpcCalls.filter((call) => call.method === 'sftp.list').length).toBeGreaterThan(listsBefore);
  });

  it('refuses to edit a truncated file, rather than writing back only its first page', async () => {
    const harness = await liveTree();
    harness.setRpcHandler('sftp.readFile', () => ({
      path: '/home/root/app.js',
      text: 'first page only',
      eol: 'lf',
      size: 5_000_000,
      modifiedAt: 1,
      truncated: true
    }));
    const writes: Record<string, unknown>[] = [];
    harness.setRpcHandler('sftp.writeFile', (params) => {
      writes.push(params);
      return { path: params.path, size: 1, modifiedAt: 1 };
    });

    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    (findByAction(harness.tree, 'sftp-file-edit')?.props.onClick as () => void)();
    await harness.settle();

    // No editor at all: saving the buffer would delete every line past the cap, which is the
    // one thing an editor must not do quietly. The truncated banner explains why, so the
    // user is not left guessing at a control that did nothing.
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-editor')).toBeNull();
    expect(findByAction(harness.tree, 'sftp-file-save')?.props.disabled).toBe(true);
    expect(writes).toHaveLength(0);
    expect(collectText(harness.tree)).toContain('只读');
  });

  it('leaves the pane when the page is switched, so no buffer hides behind 终端', async () => {
    const harness = await liveTree();
    harness.setRpcHandler('sftp.readFile', () => ({
      path: '/home/root/app.js',
      text: 'x',
      eol: 'lf',
      size: 1,
      modifiedAt: 1,
      truncated: false
    }));

    (rowFor(harness.tree, '/home/root/app.js')?.props.onClick as () => void)();
    harness.render();
    (findByAction(harness.tree, 'sftp-file-view')?.props.onClick as () => void)();
    await harness.settle();
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-viewer')).not.toBeNull();

    (findByAction(harness.tree, 'mode-terminal')?.props.onClick as () => void)();
    harness.render();
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-viewer')).toBeNull();
  });

  it('opens context menu on file right click and exposes view, edit, download, new-file, copy, delete', async () => {
    const harness = await liveTree();
    const row = rowFor(harness.tree, '/home/root/app.js');
    expect(row).not.toBeNull();
    (row?.props.onContextMenu as (event: unknown) => void)({ preventDefault() {}, clientX: 20, clientY: 30 });
    harness.render();

    const menu = findByAttribute(harness.tree, 'data-at-terminal-sftp-menu');
    expect(menu).not.toBeNull();
    for (const item of [
      'sftp-menu-view',
      'sftp-menu-edit',
      'sftp-menu-download',
      'sftp-menu-new-file',
      'sftp-menu-copy-path',
      'sftp-menu-delete'
    ]) {
      expect(findByAction(harness.tree, item), `context menu item ${item}`).not.toBeNull();
    }

    (findByAction(harness.tree, 'sftp-menu-copy-path')?.props.onClick as () => void)();
    harness.render();
    expect(harness.clipboard).toEqual(['/home/root/app.js']);
  });

  it('deletes a file through the context menu after confirmation', async () => {
    const harness = await liveTree();
    let deletedPath: string | null = null;
    harness.setRpcHandler('sftp.delete', (params) => {
      deletedPath = params.path as string;
      return { path: params.path, deleted: true };
    });

    const row = rowFor(harness.tree, '/home/root/app.js');
    (row?.props.onContextMenu as (event: unknown) => void)({ preventDefault() {}, clientX: 10, clientY: 20 });
    harness.render();

    (findByAction(harness.tree, 'sftp-menu-delete')?.props.onClick as () => void)();
    await harness.settle();

    expect(harness.confirms).toHaveLength(1);
    expect(harness.confirms[0]).toContain('app.js');
    expect(deletedPath).toBe('/home/root/app.js');
  });

  it('cancels sftp delete when the confirm is refused', async () => {
    const harness = await liveTree();
    let deleteCalled = false;
    harness.setRpcHandler('sftp.delete', () => {
      deleteCalled = true;
      return { deleted: true };
    });
    harness.setConfirmAnswer(false);

    const row = rowFor(harness.tree, '/home/root/app.js');
    (row?.props.onContextMenu as (event: unknown) => void)({ preventDefault() {}, clientX: 10, clientY: 20 });
    harness.render();

    (findByAction(harness.tree, 'sftp-menu-delete')?.props.onClick as () => void)();
    await harness.settle();

    expect(harness.confirms).toHaveLength(1);
    expect(deleteCalled).toBe(false);
  });

  it('opens context menu on directory and supports creating a new file via modal dialog', async () => {
    const harness = await liveTree();
    let createdPath: string | null = null;
    harness.setRpcHandler('sftp.createFile', (params) => {
      createdPath = params.path as string;
      return { path: params.path, size: 0, modifiedAt: 1 };
    });
    harness.setRpcHandler('sftp.readFile', (params) => ({
      path: params.path,
      text: '',
      eol: 'lf',
      size: 0,
      modifiedAt: 1,
      truncated: false
    }));

    const dirRow = rowFor(harness.tree, '/home/root/sub');
    (dirRow?.props.onContextMenu as (event: unknown) => void)({ preventDefault() {}, clientX: 15, clientY: 25 });
    harness.render();

    expect(findByAction(harness.tree, 'sftp-menu-upload')).not.toBeNull();
    expect(findByAction(harness.tree, 'sftp-menu-new-file')).not.toBeNull();

    (findByAction(harness.tree, 'sftp-menu-new-file')?.props.onClick as () => void)();
    harness.render();

    const dialog = findByAttribute(harness.tree, 'data-at-terminal-dialog');
    expect(dialog?.props['data-at-terminal-dialog']).toBe('sftp-new-file');

    const input = findByAction(harness.tree, 'sftp-new-file-input');
    expect(input).not.toBeNull();
    (input?.props.onChange as (e: unknown) => void)({ target: { value: 'script.py' } });
    harness.render();

    (findByAction(harness.tree, 'sftp-new-file-submit')?.props.onClick as () => void)();
    await harness.settle();

    expect(createdPath).toBe('/home/root/sub/script.py');
    // Newly created file is automatically opened in edit mode
    expect(findByAttribute(harness.tree, 'data-at-terminal-sftp-editor')).not.toBeNull();
  });
});

/** The TerminalView element, found by its component's name (the shim does not render it). */
function findByFunctionName(tree: Tree, name: string): ElementLike | null {
  let found: ElementLike | null = null;
  walk(tree, (node) => {
    if (found === null && typeof node.type === 'function' && (node.type as { name?: string }).name === name) {
      found = node;
    }
  });
  return found;
}