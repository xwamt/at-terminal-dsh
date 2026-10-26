import { useEffect, useRef, useState } from 'react';
import type { AgentAuditSummary, AgentExecutionSnapshot, HardwareMetrics, Translate } from '../models';
import { formatThroughput } from '../models';
import { formatFileSize } from '../../../../sftp/FileSize';
import { chevronDownRegular, chevronUpRegular, closeRegular, gaugeRegular, gripRegular, serverRegular } from '../icons';
import { HardwareMonitorView } from './monitorHardware';
import { AgentMonitorView } from './monitorAgent';
import { h, type El } from './shared';
import { postDiagnostic } from '../channel';

const STORAGE_KEY = 'dsh.at-terminal.monitor.hud.pos';

/**
 * Keep the HUD inside the viewport.
 *
 * `width`/`height` are the box the caller *believes* it is about to show (400x520 expanded,
 * 280x40 collapsed). The stylesheet already caps the real box with `min(400px, 100vw - 16px)`,
 * so at 360px the caller's 400 is a lie and clamping against it pushed the window off the
 * right edge: `maxX` became a number below `margin`, and the header — the only drag handle —
 * went with it. Shrinking the assumed box to what actually fits is what makes the clamp
 * correct at every viewport instead of only at the ones the fixed size happened to suit.
 */
export function clampPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const margin = 8;
  const winW = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800;
  const boxW = Math.min(width, Math.max(0, winW - margin * 2));
  const boxH = Math.min(height, Math.max(0, winH - margin * 2));
  const maxX = Math.max(margin, winW - boxW - margin);
  const maxY = Math.max(margin, winH - boxH - margin);
  return {
    x: Math.max(margin, Math.min(maxX, Math.round(x))),
    y: Math.max(margin, Math.min(maxY, Math.round(y)))
  };
}

export function loadSavedPosition(): { x: number; y: number } {
  const storage =
    typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!storage) return { x: 800, y: 56 };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return clampPosition(parsed.x, parsed.y, 280, 40);
      }
    }
  } catch {}
  const fallbackX = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth - 320 : 800;
  return clampPosition(fallbackX, 56, 280, 40);
}

export function savePosition(pos: { x: number; y: number }): void {
  const storage =
    typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pos));
  } catch {}
}

export interface MonitorHudWidgetProps {
  t: Translate;
  metrics: HardwareMetrics | null;
  snapshot: AgentExecutionSnapshot | null;
  onCloseHud?: () => void;
  /**
   * The form the container wants. `true` opens the window, `false` the capsule, `undefined` says
   * nothing (the connection transition and the widget's own chevron are the two other owners).
   */
  forceExpanded?: boolean;
  /**
   * Changes on every "open as the capsule" request.
   *
   * A boolean cannot carry that instruction twice: collapsing by hand changes `expanded` inside
   * this component, so the next request would pass the *same* `false` and React would not re-run
   * the effect. The counter makes each request a new value, which is what re-collapses the window.
   */
  capsuleRequest?: number;
  initialSubtab?: 'overview' | 'hardware' | 'agent';
  activeServerId?: string | null;
  activeLabel?: string | null;
  /** Audits accumulated for the current connection; the agent tab's history view reads this. */
  auditHistory?: AgentAuditSummary[];
}

export function MonitorHudWidget(props: MonitorHudWidgetProps): El {
  const { t, metrics, snapshot, onCloseHud, forceExpanded, capsuleRequest, initialSubtab, activeServerId, activeLabel, auditHistory } = props;
  const [expanded, setExpanded] = useState(Boolean(forceExpanded));
  const [activeTab, setActiveTab] = useState<'overview' | 'hardware' | 'agent'>(initialSubtab ?? 'overview');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadSavedPosition());
  const [isDragging, setIsDragging] = useState(false);
  /** Armed by a press, disarmed on release. Drives the window-level listeners below. */
  const [armed, setArmed] = useState(false);

  /** Set when a gesture turned out to be a drag; cleared by the click it has to swallow. */
  const suppressClickRef = useRef(false);
  /** Latest position, so the drag effect does not have to re-subscribe on every move. */
  const posRef = useRef(pos);
  posRef.current = pos;
  /**
   * The press is registered once per mounted overlay, not per render.
   *
   * The gesture outlives re-renders (the position changes on every move), so the listener must be
   * bound once and read the live state through refs. Rebinding it inside a `[pos.x, pos.y]` effect
   * — the previous shape — tore the listener down and rebuilt it on every pointermove.
   */
  const overlayRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    hasMoved: boolean;
    width: number;
    height: number;
    isPill: boolean;
  } | null>(null);

  /**
   * Listen on `window` for the duration of a drag, not on the element.
   *
   * Element-level `pointermove` does not arrive once the pointer leaves a 40px-tall pill — in this
   * renderer it barely arrives even before that, so the 3px threshold never crossed — and that is
   * what made an armed drag stand still. Moving is listened for on `window`; the release on
   * `document` in the **capture** phase, so a chip under the pointer — or the host, which installs
   * capture-phase handlers of its own — cannot swallow it.
   *
   * The *press* deliberately comes from a **native capture-phase listener** (see
   * `gripPointerDown` below) rather than from React's delegated one. React's delegation listens at
   * the renderer's own root container, which sits **inside** the host page, so every host-level
   * `pointerdown` listener runs *before* the plugin can react. Capturing at `window` is the only
   * place guaranteed to see the press first, which is the one property this gesture needs.
   *
   * A press that never moves is a tap on the handle and does nothing: expanding is the chevron's.
   */
  useEffect(() => {
    if (!armed) return;
    /*
     * The gesture's pointer id is captured here, once.
     *
     * It used to be re-read from `dragStateRef` on every event, which is the same object every
     * press overwrites — so anything that replaced it (a second pointer, a re-arm) turned the
     * running gesture's own events into mismatches, and `releasePointerCapture()` (which also
     * reads the ref) then refused to let go. The id belongs to the closure that listens for it.
     */
    const gesturePointerId = dragStateRef.current?.pointerId ?? -1;
    const finish = (moved: boolean): void => {
      setIsDragging(false);
      releasePointerCapture(gesturePointerId);
      if (moved) {
        savePosition(posRef.current);
        suppressClickRef.current = true;
      }
      dragStateRef.current = null;
      setArmed(false);
    };
    const onMove = (e: PointerEvent): void => {
      const state = dragStateRef.current;
      if (state === null || e.pointerId !== gesturePointerId) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      if (!state.hasMoved) {
        if (Math.hypot(dx, dy) < 3) return;
        state.hasMoved = true;
        setIsDragging(true);
      }
      // Keep the gesture even if something under the pointer captured it (an iframe's own
      // document, a media element, a focus trap) — a capture here is what lets `window`
      // `pointermove` keep arriving for this pointerId.
      capturePointer(e.pointerId);
      setPos(clampPosition(state.initialX + dx, state.initialY + dy, state.width, state.height));
    };
    const onUp = (e: PointerEvent): void => {
      const state = dragStateRef.current;
      if (state === null || e.pointerId !== gesturePointerId) return;
      finish(state.hasMoved);
    };
    window.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
    };
  }, [armed]);

  /**
   * One line per mount: where the floating window actually is.
   *
   * The position lives in localStorage and is clamped to the viewport, so "the HUD is missing" can
   * mean three different things — it is behind something, it is off the edge, or nobody asked for
   * it — and no screenshot distinguishes them. One line makes it diagnosable from the log.
   */
  useEffect(() => {
    requestAnimationFrame(() => {
      const element = typeof document !== 'undefined' ? document.querySelector('.att-hud-overlay') : null;
      const box = element ? element.getBoundingClientRect() : null;
      const rect = box ? `${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)},${Math.round(box.height)}` : 'none';
      postDiagnostic('info', `hud shown pos=${JSON.stringify(pos)} vw=${window.innerWidth} rect=${rect}`, 'hud', null, null);
    });
    // Mount-only on purpose: a line per render would fire on every metrics poll.
  }, []);

  /**
   * Sync `forceExpanded`, **once per instruction**.
   *
   * The props are a command, not a mode: the container holds the last one it issued for the life of
   * the page, and `MonitorHudContainer` returns `null` (not a hidden widget) whenever the HUD is
   * off screen — so the widget is remounted on every hide/show, and a naive effect re-applied the
   * stale command on each of those mounts. The visible effect of that was a window the user had
   * expanded by hand snapping back to the capsule the next time the HUD was shown, plus a jump
   * through the 280×40 clamp.
   *
   * The latch is a ref, so a *new* instruction (the container bumps `capsuleRequest` for every
   * "open as capsule" request precisely because `forceExpanded` alone cannot encode a repeat) still
   * runs on a fresh mount, while the same one is consumed exactly once.
   *
   * - `true` opens the window and clamps it at the expanded size, because a 280px-wide clamp can
   *   leave a 400px window hanging off the right edge.
   * - `false` — and the first render with no instruction at all — is the capsule, which is the
   *   default form now: the toolbar button, the context menu and the shortcut all ask for
   *   "the monitor", and a monitor that lands fully open over the conversation is the bug this
   *   change is about. Collapsing is also why the clamp runs against the capsule's box.
   */
  const appliedFormRef = useRef<string | null>(null);
  useEffect(() => {
    const instruction =
      forceExpanded === true
        ? 'expanded'
        : forceExpanded === false
          ? 'capsule'
          : capsuleRequest !== undefined
            ? 'capsule'
            : 'initial';
    const stamp = `${instruction}:${capsuleRequest ?? 0}`;
    if (appliedFormRef.current === stamp) return;
    // The very first render already seeded `expanded` from `forceExpanded`; re-applying it there
    // would undo a collapse the user has made between the mount and this effect.
    const firstRun = appliedFormRef.current === null;
    appliedFormRef.current = stamp;
    if (instruction === 'expanded') {
      setExpanded(true);
      setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
    } else if (instruction === 'capsule' && !(firstRun && forceExpanded === undefined)) {
      setExpanded(false);
      setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
    }
  }, [forceExpanded, capsuleRequest]);

  // Sync initialSubtab prop
  useEffect(() => {
    if (initialSubtab) {
      setActiveTab(initialSubtab);
    }
  }, [initialSubtab]);

  // Viewport resize boundary adjustment
  useEffect(() => {
    const onResize = () => {
      const width = expanded ? 400 : 280;
      const height = expanded ? 520 : 40;
      setPos((prev) => clampPosition(prev.x, prev.y, width, height));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  /**
   * Pointer capture on the overlay, with both halves of the contract.
   *
   * Capturing keeps this element the target of the whole gesture, so a host handler cannot retarget
   * it away and `window` listeners keep seeing the moves. Releasing it matters just as much: a
   * capture left behind swallows the next press on the chips, so every path that ends a gesture
   * calls this — including "the press never moved".
   *
   * `try` because a `pointerId` the browser no longer tracks throws `NotFoundError`, which is
   * information, not a failure: the gesture is simply over.
   */
  const capturePointer = (pointerId: number): void => {
    const node = overlayRef.current;
    if (node === null || typeof node.setPointerCapture !== 'function') return;
    try {
      node.setPointerCapture(pointerId);
    } catch {}
  };

  const releasePointerCapture = (pointerId: number): void => {
    const node = overlayRef.current;
    if (node === null || pointerId < 0 || typeof node.releasePointerCapture !== 'function') return;
    try {
      if (node.hasPointerCapture?.(pointerId) === true) node.releasePointerCapture(pointerId);
    } catch {}
  };

  /**
   * Arm a drag from the six-dot handle. That handle is the **only** place a capsule drag starts.
   *
   * Three attempts got this wrong before, and the user's report is the design brief: the capsule
   * has a grip for exactly this, so dragging was never supposed to work from anywhere.
   *
   * - Dropping the container's drag outright is what produced the "the handle cannot drag, the
   *   rest can" report: `closest('button')` refused every chip, so the only place left was the
   *   pill's own padding — and the grip was not wired to anything at all.
   * - So the grip arms the drag and the pill deliberately does not. A press on the pill's padding
   *   starts nothing, which is the point: the chips keep their clicks and the capsule moves only by
   *   its handle.
   */
  const handlePointerDown = (e: { button: number; pointerId: number; clientX: number; clientY: number }, isPill: boolean) => {
    if (e.button !== 0) return;
    /*
     * One gesture at a time.
     *
     * A second pointer — a second finger, a pen plus a palm — used to overwrite `dragStateRef`
     * while the arm effect still held the FIRST pointer's listeners. Every later move and the
     * release then failed the `pointerId` check, so the gesture silently froze with its pointer
     * capture still held: the window sticks to the cursor until the other finger lifts. Ignoring
     * the newcomer leaves the running gesture intact, which is what a drag surface should do.
     */
    if (dragStateRef.current !== null) return;
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      initialX: posRef.current.x,
      initialY: posRef.current.y,
      hasMoved: false,
      width: isPill ? 280 : 400,
      height: isPill ? 40 : 520,
      isPill
    };
    suppressClickRef.current = false;
    // Capture **from the press**, not from the first move: a host handler that calls
    // `setPointerCapture` on the pressed element (the DOM does not scope that to a subtree, so a
    // capture-phase listener anywhere may do it) would retarget every later event and the gesture
    // would never report a move. Capturing here makes this element the target instead, which is
    // what every drag implementation does for exactly this reason.
    capturePointer(e.pointerId);
    setArmed(true);
  };

  /**
   * The drag handle is resolved from the document, never from a ref set during render.
   *
   * Only one overlay is ever on screen, so a `querySelector` on the press names the element the
   * press actually landed on. A ref does not: React attaches `ref` **after** the first render, and
   * the effect that bound this listener ran before that, saw `null`, and returned — so the handle
   * silently had no press handler at all until something re-rendered the window. That is the
   * "clicking the six dots does nothing" report, and pinning it to a document lookup removes the
   * ordering question entirely.
   *
   * Two facts make `[data-hud-drag]` the right test rather than "the grip element itself":
   *
   * - `touch-action: none` on the grip makes the browser deliver the whole gesture to it, so on a
   *   touch display a slight miss still reaches the handle — the forgiving hit area the stylesheet
   *   already draws.
   * - The element is found by walking up from the event target, so a marker placed inside the grip
   *   keeps working if the glyph's DOM changes.
   */
  const gripPointerDown = (event: PointerEvent): boolean => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-hud-drag]') === null) return false;
    if (event.button !== 0) return true;
    // A press is a selection start and a native drag start (the glyph is an `<svg>`); without this
    // the browser drags the image or the text and the window stands still.
    event.preventDefault();
    event.stopPropagation();
    handlePointerDown(event, true);
    return true;
  };

  /**
   * Bind the press once per mounted overlay.
   *
   * `capture: true` on `window` — not React's delegated listener and not a node listener. React's
   * delegation runs at the renderer's root container, which is *inside* the host page, so a
   * host-level capture listener has already run by then; and the host installs exactly such a
   * listener (`window.addEventListener('pointerdown', …, true)`) to track input modality. Seeing
   * the press before anything else in the page does is the whole reason this is native and
   * window-level.
   *
   * The handler reads `expanded` through a ref because the binding is mount-scoped: a closure over
   * the first render's value would keep treating an expanded window as a capsule.
   */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      const overlay = overlayRef.current;
      if (overlay === null || !(event.target instanceof Node) || !overlay.contains(event.target)) return;
      if (gripPointerDown(event)) return;
      // The expanded window keeps its header as the drag surface — with its own buttons exempt,
      // or pressing ✕ would move the window. The capsule has no second surface: everything that is
      // not the six-dot handle is a control or padding, and a press there must do nothing.
      if (expandedRef.current) {
        const target = event.target as HTMLElement;
        if (!target?.closest || target.closest('button') === null) {
          if (event.button === 0) event.preventDefault();
          handlePointerDown(event, false);
        }
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
    // Mount-scoped on purpose: see the note above.
  }, []);

  const handleHeaderDoubleClick = (e: any) => {
    const target = e.target as HTMLElement;
    if (target?.closest && target.closest('button')) return;
    setExpanded(false);
    setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
  };
  const cpuPercent = metrics?.cpu.usagePercent ?? 0;
  const cpuLevel = cpuPercent > 85 ? 'error' : cpuPercent > 70 ? 'warn' : 'normal';
  const memUsedBytes = metrics?.memory.usedBytes ?? 0;
  const memTotalBytes = metrics?.memory.totalBytes || 1;
  const memPercent = Math.min(100, Math.round((memUsedBytes / memTotalBytes) * 100));
  const memLevel = memPercent > 85 ? 'error' : memPercent > 70 ? 'warn' : 'normal';
  const primaryDisk = metrics?.disk.mounts?.[0];

  const diskLevel = (primaryDisk?.usePercent ?? 0) > 85 ? 'error' : (primaryDisk?.usePercent ?? 0) > 70 ? 'warn' : 'normal';
  const rxStr = formatThroughput(metrics?.network?.rxBytesPerSec ?? 0);
  const txStr = formatThroughput(metrics?.network?.txBytesPerSec ?? 0);
  const isAgentActive = Boolean(snapshot?.currentAction);
  const agentStatus = snapshot?.currentAction?.status;

  /** Expand into a named sub-tab. Every pill control routes through this one transition. */
  const openExpanded = (tab: 'overview' | 'hardware' | 'agent') => {
    setExpanded(true);
    setActiveTab(tab);
    setPos((prev) => clampPosition(prev.x, prev.y, 400, 520));
  };
  const collapse = () => {
    setExpanded(false);
    setPos((prev) => clampPosition(prev.x, prev.y, 280, 40));
  };
  const agentShort = isAgentActive
    ? agentStatus === 'confirmation_waiting'
      ? t('monitor.status.waitingShort')
      : t('monitor.status.runningShort')
    : '';

  return h(
    'div',
    {
      className: `att-hud-overlay ${isDragging ? 'is-dragging' : ''}`,
      /**
       * The root is the press's scope and the pointer-capture target.
       *
       * A callback ref rather than `useRef` + `ref: overlayRef`, because a callback is assigned
       * with the node at attach time on every mount — no second render is needed before the
       * listeners can see it.
       */
      ref: (node: HTMLElement | null) => {
        overlayRef.current = node;
      },
      style: {
        left: `${pos.x}px`,
        top: `${pos.y}px`
      }
    },
    // Mini Draggable Pill
    !expanded &&
      h(
        'div',
        {
          /*
           * `role="group"`, not `role="button"`.
           *
           * It used to be one button whose children were `<span onClick>` — an interactive
           * element nested inside an interactive element, which both ARIA and every screen
           * reader reject: the outer role swallows the children, so "CPU 12%" announced as
           * part of one long button label with no way to reach the third of it that does
           * something. The container is a group; each chip that acts is its own button.
           */
          className: `att-hud-pill ${isDragging ? 'is-dragging' : ''}`,
          role: 'group',
          'aria-label': t('monitor.hud.pillLabel'),
          /**
           * No `title` on the pill.
           *
           * It used to carry the drag hint, which advertised the whole capsule as a drag target —
           * the opposite of the design, where the six dots are the only handle (the grip and the
           * expand chevron carry `monitor.hud.gripTip` / `monitor.hud.expand` instead).
           */
          /**
           * Swallow the one click a drag leaves behind.
           *
           * Capture phase, so it runs before the chip's own handler: releasing a drag over a chip
           * must not also fire that chip. The flag is cleared **unconditionally** — a stale `true`
           * can outlive its gesture (a release the browser retargeted, a click that never arrived),
           * and the next genuine click was then swallowed, which reads exactly as "the buttons
           * stopped working". Every fresh press clears it as well, so the guard can never lock in.
           */
          onClickCapture: (e: any) => {
            if (!suppressClickRef.current) return;
            suppressClickRef.current = false;
            e.stopPropagation();
            e.preventDefault();
          }
        },
        /**
         * The six-dot handle — the one and only place the capsule drags from.
         *
         * `data-hud-drag` is the marker the window-level press handler looks for (see
         * `gripPointerDown`). It is on the box *and* on the glyph so a press that lands on the SVG
         * — which is `pointer-events: none` but is still the target while the browser routes a
         * touch gesture — resolves to the same handle.
         */
        h(
          'span',
          {
            className: 'att-floating-drag-grip',
            'data-hud-drag': 'pill',
            'aria-hidden': true,
            title: t('monitor.hud.gripTip')
          },
          gripRegular({ size: 14 })
        ),
        h('span', { 'aria-hidden': true }, gaugeRegular({ size: 14 })),
        (activeLabel || activeServerId) &&
          h(
            'span',
            {
              className: 'att-hud-pill-chip',
              title: `${t('monitor.server')}${activeLabel || activeServerId}`,
              style: { maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            },
            serverRegular({ size: 12 }),
            ` ${activeLabel || activeServerId}`
          ),
        h(
          'button',
          {
            type: 'button',
            className: 'att-hud-pill-chip',
            title: t('monitor.tab.hardware'),
            'aria-label': t('monitor.hud.cpuChip', { percent: `${cpuPercent}%` }),
            onClick: () => openExpanded('hardware')
          },
          `CPU ${cpuPercent}%`
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'att-hud-pill-chip',
            title: t('monitor.tab.hardware'),
            'aria-label': t('monitor.hud.memChip', { percent: `${memPercent}%` }),
            onClick: () => openExpanded('hardware')
          },
          `MEM ${memPercent}%`
        ),
        isAgentActive
          ? h(
              'button',
              {
                type: 'button',
                className: `att-monitor-badge ${agentStatus === 'confirmation_waiting' ? 'att-monitor-badge-waiting' : 'att-monitor-badge-running'}`,
                style: { padding: '1px 6px', fontSize: '11px', cursor: 'pointer' },
                title: `${t('monitor.tab.agent')}: ${agentShort}`,
                'aria-label': t('monitor.hud.agentChip', { status: agentShort }),
                onClick: () => openExpanded('agent')
              },
              h('span', { className: 'att-monitor-badge-pulse-dot', 'aria-hidden': true }),
              agentShort
            )
          : h('span', {
              className: 'att-monitor-badge-pulse-dot',
              'aria-hidden': true,
              style: { color: 'var(--dsw-alias-state-success-primary)' }
            }),
        h(
          'button',
          {
            type: 'button',
            className: 'att-hud-pill-expand',
            title: t('monitor.hud.expand'),
            'aria-label': t('monitor.hud.expand'),
            onClick: () => openExpanded(activeTab)
          },
          // Pointing **up**: the action opens the window out of the capsule, the same way the
          // expanded window's own collapse button points **down**. This chevron was the down one,
          // which reads as "fold this away" — the opposite of what the button does.
          chevronUpRegular({ size: 14 })
        ),
        onCloseHud &&
          h(
            'button',
            {
              type: 'button',
              className: 'att-nav-btn att-icon-btn',
              style: { marginLeft: '2px', opacity: 0.7 },
              title: t('monitor.hud.close'),
              'aria-label': t('monitor.hud.close'),
              onClick: (e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                onCloseHud();
              }
            },
            closeRegular({ size: 14 })
          )
      ),

    // Expanded Draggable Floating Window
    expanded &&
      h(
        'div',
        {
          className: `att-floating-window ${isDragging ? 'is-dragging' : ''}`,
          role: 'dialog',
          'aria-label': t('monitor.hud.title'),
          tabIndex: -1,
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Escape') {
              collapse();
            }
          }
        },
        // Header / Drag Handle
        h(
          'div',
          {
            className: `att-floating-window-header ${isDragging ? 'is-dragging' : ''}`,
            title: t('monitor.hud.dragTip'),
            /**
             * No `onPointerDown` here any more.
             *
             * The drag is armed by the window-level press listener (see the mount effect below), which runs
             * *before* React's delegated handlers and already exempts the header's own buttons. A
             * second React handler on the same element was the "collapse and ✕ do nothing" report:
             * it called `setPointerCapture` on the overlay for the press that started on a button,
             * and a captured press retargets the release too — so the `click` never reached the
             * button. One owner per gesture is the rule; this is the second one going away.
             */
            onDoubleClick: handleHeaderDoubleClick
          },
          h(
            'div',
            { className: 'att-floating-header-left' },
            h(
              'span',
              { className: 'att-floating-drag-grip', 'data-hud-drag': 'window', 'aria-hidden': true },
              gripRegular({ size: 14 })
            ),
            h('span', { 'aria-hidden': true }, gaugeRegular({ size: 14 })),
            h('span', { style: { fontWeight: 600, fontSize: '12px' } }, t('monitor.hud.title'))
          ),
          h(
            'div',
            { className: 'att-floating-header-actions' },
            h(
              'button',
              {
                className: 'att-nav-btn att-icon-btn',
                title: t('monitor.hud.minimize'),
                'aria-label': t('monitor.hud.minimize'),
                onClick: (e: { stopPropagation: () => void }) => {
                  e.stopPropagation();
                  collapse();
                }
              },
              // A chevron rather than the `—` it used to draw: the action **collapses the window
              // into the pill**, which is what a downward chevron means, while an em dash is the
              // typographic mark for a range and says nothing about the result.
              chevronDownRegular({ size: 14 })
            ),
            onCloseHud &&
              h(
                'button',
                {
                  className: 'att-nav-btn att-icon-btn',
                  title: t('monitor.hud.close'),
                  'aria-label': t('monitor.hud.close'),
                  onClick: (e: { stopPropagation: () => void }) => {
                    e.stopPropagation();
                    onCloseHud();
                  }
                },
                closeRegular({ size: 14 })
              )
          )
        ),

        // Server Sub-bar
        h(
          'div',
          {
            style: {
              padding: '4px 12px',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)'
            }
          },
          h('span', { 'aria-hidden': true }, serverRegular({ size: 14 })),
          h('span', null, t('monitor.server')),
          h(
            'span',
            {
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }
            },
            activeLabel || activeServerId || metrics?.serverId || t('monitor.hud.noServer')
          )
        ),

        // Subtabs Navigation Bar
        h(
          'div',
          { className: 'att-floating-subtabs', role: 'tablist', 'aria-label': t('monitor.hud.title') },
          ...(
            [
              ['overview', t('monitor.tab.overview')],
              ['hardware', t('monitor.tab.hardware')],
              ['agent', t('monitor.tab.agent')]
            ] as const
          ).map(([key, label]) =>
            h(
              'button',
              {
                key,
                id: `att-hud-tab-${key}`,
                type: 'button',
                role: 'tab',
                className: `att-floating-tab-btn ${activeTab === key ? 'is-active' : ''}`,
                'aria-selected': activeTab === key,
                'aria-controls': 'att-hud-tabpanel',
                // Roving tabindex: one stop for the whole strip, arrows move within it. Three
                // tabs in a floating window should not cost three Tab presses on the way to
                // the content behind them.
                tabIndex: activeTab === key ? 0 : -1,
                onClick: () => setActiveTab(key),
                onKeyDown: (e: { key: string; preventDefault: () => void }) => {
                  const order = ['overview', 'hardware', 'agent'] as const;
                  const at = order.indexOf(activeTab);
                  const next =
                    e.key === 'ArrowRight'
                      ? order[(at + 1) % order.length]
                      : e.key === 'ArrowLeft'
                        ? order[(at + order.length - 1) % order.length]
                        : e.key === 'Home'
                          ? order[0]
                          : e.key === 'End'
                            ? order[order.length - 1]
                            : null;
                  if (next === null) return;
                  e.preventDefault();
                  setActiveTab(next);
                  /*
                   * Selection and focus have to move together.
                   *
                   * The tabindex is roving — the strip is meant to be a single Tab stop — so the
                   * newly selected tab becomes tabIndex 0 while the one the user's focus is
                   * physically on becomes -1. Without this line the two disagree: the panel
                   * switches, the focus ring stays behind on a button that is no longer a stop, and
                   * the next Tab press leaves the strip entirely from a tab that looks unselected.
                   */
                  const el = document.getElementById(`att-hud-tab-${next}`);
                  if (el !== null) el.focus();
                }
              },
              label
            )
          )
        ),

        // Body Content
        h(
          'div',
          {
            className: 'att-floating-window-body',
            id: 'att-hud-tabpanel',
            role: 'tabpanel',
            'aria-labelledby': `att-hud-tab-${activeTab}`
          },
          activeTab === 'overview' &&
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              // Overview 2x2 Grid
              h(
                'div',
                { className: 'att-overview-grid' },
                // CPU Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.cpu.title')),
                    h('span', { className: 'att-overview-metric-value' }, `${cpuPercent}%`)
                  ),
                  h(
                    'div',
                    { className: 'att-monitor-gauge' },
                    h('div', {
                      className: 'att-monitor-gauge-fill',
                      'data-level': cpuLevel,
                      style: { width: `${cpuPercent}%` }
                    })
                  ),
                  h(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                    t('monitor.cpu.load', {
                      l1: (metrics?.cpu.loadAvg?.[0] ?? 0).toFixed(2),
                      l5: (metrics?.cpu.loadAvg?.[1] ?? 0).toFixed(2),
                      l15: (metrics?.cpu.loadAvg?.[2] ?? 0).toFixed(2)
                    })
                  )
                ),
                // Memory Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.mem.title')),
                    h('span', { className: 'att-overview-metric-value' }, `${memPercent}%`)
                  ),
                  h(
                    'div',
                    { className: 'att-monitor-gauge' },
                    h('div', {
                      className: 'att-monitor-gauge-fill',
                      'data-level': memLevel,
                      style: { width: `${memPercent}%` }
                    })
                  ),
                  h(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                    t('monitor.mem.detail', {
                      used: formatFileSize(memUsedBytes),
                      total: formatFileSize(memTotalBytes)
                    })
                  )
                ),
                // Disk Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.disk.title')),
                    h('span', { className: 'att-overview-metric-value' }, primaryDisk ? `${primaryDisk.usePercent}%` : '-')
                  ),
                  h(
                    'div',
                    { className: 'att-monitor-gauge' },
                    h('div', {
                      className: 'att-monitor-gauge-fill',
                      'data-level': diskLevel,
                      style: { width: `${primaryDisk?.usePercent ?? 0}%` }
                    })
                  ),
                  h(
                    'div',
                    { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                    primaryDisk ? `${primaryDisk.mount} (${formatFileSize(primaryDisk.usedBytes)})` : '-'
                  )
                ),
                // Network Metric Card
                h(
                  'div',
                  { className: 'att-overview-metric-card' },
                  h(
                    'div',
                    { className: 'att-overview-metric-title' },
                    h('span', null, t('monitor.net.title'))
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '2px' } },
                    h('span', null, t('monitor.net.rx', { speed: rxStr })),
                    h('span', null, t('monitor.net.tx', { speed: txStr }))
                  )
                )
              ),

              // Agent Execution Status Card
              h(
                'div',
                { className: 'att-overview-agent-card' },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: { fontWeight: 600, fontSize: '12px' } }, t('monitor.agent.actionTitle')),
                  isAgentActive
                    ? h(
                        'span',
                        {
                          className: `att-monitor-badge ${agentStatus === 'confirmation_waiting' ? 'att-monitor-badge-waiting' : 'att-monitor-badge-running'}`,
                          style: { fontSize: '11px' }
                        },
                        agentStatus === 'confirmation_waiting' ? t('monitor.status.waiting') : t('monitor.status.running')
                      )
                    : h(
                        'span',
                        { style: { fontSize: '11px', color: 'var(--dsw-alias-state-success-primary)' } },
                        h('span', { className: 'att-monitor-badge-pulse-dot', 'aria-hidden': true, style: { marginRight: '4px' } }),
                        t('monitor.agent.ready')
                      )
                ),
                isAgentActive
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                      h(
                        'div',
                        { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } },
                        t('monitor.agent.elapsed', { time: snapshot?.currentAction?.runningTimeMs ?? 0 })
                      ),
                      h('div', { className: 'att-code-preview', style: { maxHeight: '70px' } }, snapshot?.currentAction?.command),
                      snapshot && snapshot.activeTransfers.length > 0 &&
                        h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-brand-primary)' } }, `${t('monitor.agent.transfersTitle')}: ${snapshot.activeTransfers.length}`)
                    )
                  : h(
                      'div',
                      { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', padding: '4px 0' } },
                      t('monitor.agent.idle')
                    )
              )
            ),

          activeTab === 'hardware' &&
            h(HardwareMonitorView, {
              t,
              metrics,
              loading: false,
              onRefresh: () => {}
            }),

          activeTab === 'agent' &&
            h(AgentMonitorView, {
              t,
              snapshot,
              loading: false,
              onRefresh: () => {},
              history: auditHistory
            })
        ),

        // Footer status bar
        h(
          'div',
          { className: 'att-floating-window-footer' },
          h('span', null, t('monitor.hud.dragTip')),
          h('span', { style: { opacity: 0.8 } }, 'AT Terminal')
        )
      )
  );
}
