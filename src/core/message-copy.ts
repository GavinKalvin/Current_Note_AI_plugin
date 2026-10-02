/** Copy the original message, never DOM text that may duplicate MathML or omit Markdown. */
export async function copyMessageText(source: string, clipboard?: Pick<Clipboard, "writeText">): Promise<void> {
  if (!clipboard) throw new Error("Clipboard access is unavailable. Select the message text and copy it manually.");
  try {
    await clipboard.writeText(source);
  } catch {
    throw new Error("Could not copy the message. Select the message text and copy it manually.");
  }
}
