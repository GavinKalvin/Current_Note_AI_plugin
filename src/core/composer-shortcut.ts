export interface ComposerKeyEvent {
  key: string;
  code?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function shouldSubmitComposer(event: ComposerKeyEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey) return false;
  return event.key === "Enter"
    || event.code === "Enter"
    || event.code === "NumpadEnter"
    || event.keyCode === 13;
}
