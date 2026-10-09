/**
 * The `react` stand-in for node-side tests of the Client half.
 *
 * The browser module table provides React — the client bundle declares it `external` and the
 * ModuleLoader factory's `require('react')` resolves it — and this repository deliberately has no
 * `@types/react` dependency, with `src/platform/dsh/client/react.d.ts` declaring the eight members
 * the client actually touches. That leaves a **runtime** gap: a test which imports a client module
 * directly, instead of driving the built bundle in a VM, has nothing for `import React from 'react'`
 * to resolve to. `vitest.config.ts` closes it by aliasing `react` here, the same way `vscode` has
 * been aliased to a fixture all along.
 *
 * It exists for the modules that only need React to *be there* — the ones holding state outside a
 * component. `src/platform/dsh/client/sessions.ts` is that case: it is the registry a tab switch
 * depends on, and it was untestable until this file existed.
 *
 * Every member **throws**. A hook returning something plausible would let a test believe it had
 * rendered a component, when the component lifecycle — effect ordering, cleanup on unmount,
 * double-invoked renders — is the entire subject. Components are exercised by
 * `test/dsh/client-bundle.test.ts` instead, through the bundle's own slot-registering harness, which
 * is the only place the framework's real behaviour can be reproduced.
 */

/** Quoted in the error so a surprising failure names the right file to look at. */
const ADVICE =
  'this module imports a Client module for its module-level state, not to render a component; ' +
  'rendering is covered by test/dsh/client-bundle.test.ts, which drives the built bundle';

function unavailable(member: string): never {
  throw new Error(`react.${member} is not available in node-side tests — ${ADVICE}`);
}

export const createElement = (): never => unavailable('createElement');
export const createContext = (): never => unavailable('createContext');
export const useContext = (): never => unavailable('useContext');
export const useState = (): never => unavailable('useState');
export const useEffect = (): never => unavailable('useEffect');
export const useRef = (): never => unavailable('useRef');
export const useReducer = (): never => unavailable('useReducer');
export const useMemo = (): never => unavailable('useMemo');

const React = {
  createElement,
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useReducer,
  useMemo
};

export default React;
