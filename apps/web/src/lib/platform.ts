/**
 * Platform-correct keyboard shortcut hints.
 *
 * The handler accepts either modifier; the *label* must match the platform or
 * Windows/Linux users are told to press a key they do not have.
 */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = uaData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** "⌘K" on Apple platforms, "Ctrl+K" elsewhere. */
export function commandKeyLabel(): string {
  return isMac() ? "⌘K" : "Ctrl+K";
}

/** "⌘↵" on Apple platforms, "Ctrl+↵" elsewhere. */
export function commandEnterLabel(): string {
  return isMac() ? "⌘↵" : "Ctrl+↵";
}
