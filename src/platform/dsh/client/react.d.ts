/**
 * Minimal React surface used by the dsh Client half.
 *
 * The browser module table provides React (the client bundle declares it
 * `external`, and the ModuleLoader factory's `require('react')` resolves it),
 * but the repository has no `@types/react` dependency and must not gain one
 * just for this corner: the client uses eight APIs, and declaring exactly those
 * keeps `tsc` honest about what the bundle actually touches. If a component
 * ever needs more of React, the missing member fails typecheck here rather
 * than silently depending on an undeclared shape.
 */
declare module 'react' {
  export interface ReactElement {
    type: unknown;
    props: Record<string, unknown>;
  }

  export interface Context<T> {
    Provider: (props: { value: T; children?: unknown }) => ReactElement;
    defaultValue: T;
    /** Test-shim field: the vitest stand-in reads the value back from here. */
    current?: T;
  }

  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): ReactElement;

  export function createContext<T>(defaultValue: T): Context<T>;

  export function useContext<T>(context: Context<T>): T;

  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];

  export function useEffect(run: () => unknown, deps?: unknown[]): void;

  export function useRef<T>(initial: T): { current: T };

  /**
   * Present for the tab badge, which has to re-render when a *different* component
   * publishes to it — the body owns the connection state, the chip title reads it, and no
   * common ancestor re-renders when either changes. `useState` cannot express that (the
   * value lives in a module-level map, not in this component's state) and `useReducer`
   * gives the required "re-render with the same props" for free.
   *
   * `A` carries a `void` member so a dispatch may be called with **no** argument, the way
   * the badge's bump reducer does — that is React's own `Dispatch<A>` behaviour, and
   * declaring it as required here would make the correct call site a type error.
   */
  export function useReducer<S, A extends void | unknown>(
    reducer: (state: S, action: A) => S,
    initial: S
  ): [S, (action?: A) => void];

  /** `useMemo` for the SFTP read's parameter object, which must be referentially stable. */
  export function useMemo<T>(compute: () => T, deps: unknown[]): T;

  const React: {
    useReducer: typeof useReducer;
    useMemo: typeof useMemo;
    createElement: typeof createElement;
    createContext: typeof createContext;
    useContext: typeof useContext;
    useState: typeof useState;
    useEffect: typeof useEffect;
    useRef: typeof useRef;
  };

  export default React;
}

/**
 * CSS imported as text (esbuild `loader: { '.css': 'text' }`), so the client
 * bundle can scope and inject the reused stylesheets itself. Only applies to
 * non-relative specifiers such as `@xterm/xterm/css/xterm.css`; the two
 * webview stylesheets are relative imports and carry sibling `.d.ts` files.
 */
declare module '*.css' {
  const content: string;
  export default content;
}