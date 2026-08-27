import { createContext, type ReactNode, useContext } from 'react'

const AddTaskLayoutContext = createContext<
  ((expanded: boolean) => void) | undefined
>(undefined)

export function AddTaskLayoutProvider({
  children,
  onAdvancedOpenChange,
}: {
  children: ReactNode
  onAdvancedOpenChange?: (expanded: boolean) => void
}) {
  return (
    <AddTaskLayoutContext.Provider value={onAdvancedOpenChange}>
      {children}
    </AddTaskLayoutContext.Provider>
  )
}

export function useAddTaskLayoutChange():
  | ((expanded: boolean) => void)
  | undefined {
  return useContext(AddTaskLayoutContext)
}
