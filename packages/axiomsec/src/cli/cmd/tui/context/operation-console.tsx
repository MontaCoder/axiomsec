import { createContext, useContext, type JSX } from "solid-js"
import {
  createOperationConsoleLoader,
  type OperationConsoleLoader,
} from "@tui/component/operation-lens/loader"

const Context = createContext<OperationConsoleLoader>()

export function OperationConsoleProvider(props: { children: JSX.Element }) {
  const loader = createOperationConsoleLoader()
  return <Context.Provider value={loader}>{props.children}</Context.Provider>
}

export function useOperationConsoleLoader() {
  const loader = useContext(Context)
  if (!loader) throw new Error("OperationConsoleProvider is missing")
  return loader
}
