/** Commands of the currently open page, used by the menu bar and drops. */
export interface PageCommands {
  path: string
  save(): Promise<void>
  undo(): boolean
  redo(): boolean
  editorContains(el: Element | null): boolean
  insertFiles(paths: string[], at?: { x: number; y: number }): Promise<void>
  copyMarkdown(): Promise<void>
}

export const pageCommands: { current: PageCommands | null } = { current: null }
