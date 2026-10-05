import "./runtime.css";

// The plugin-runtime bundle is the ONLY module the sandboxed import map
// exposes: bare "react", "react/jsx-runtime", "react-dom/client" and
// "@interview-os/ui" all resolve here, so plugin UI shares this React
// instance and this design system. (React's types use `export =`, so the
// re-export is spelled out explicitly.)
import * as React from "react";
export default React;
export const {
  Children,
  Component,
  StrictMode,
  Suspense,
  act,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;
export { jsx, jsxs, Fragment } from "react/jsx-runtime";
export { createRoot } from "react-dom/client";
export * from "../index.js";
export * from "../frame.js";
/* curated, antd-free plugin surface — also served as @interview-os/plugin-ui */
export * from "../plugin.js";
export { createPluginSDK } from "./sdk.js";
export { boot } from "./boot.js";
export type { BootOptions } from "./boot.js";
