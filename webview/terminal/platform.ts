/**
 * Which modifier the operating system uses for copy/paste and application shortcuts.
 *
 * The terminal embeds the platform's own clipboard conventions rather than imposing one:
 * macOS copies with Command and leaves Control to the shell (Ctrl+C is SIGINT), while
 * Windows and Linux use Control for both. The check is a pure function over the
 * navigator-like object so the tests can exercise both platforms on one machine.
 */

export interface PlatformNavigator {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** True on macOS (including iPadOS, which reports a Macintosh user agent in desktop mode). */
export function isMacPlatform(nav?: PlatformNavigator): boolean {
  const source =
    nav ?? (typeof navigator === 'undefined' ? undefined : (navigator as unknown as PlatformNavigator));
  if (source === undefined) {
    return false;
  }
  // `userAgentData.platform` is the modern replacement for the deprecated `platform` field;
  // both are checked because the WebView2/Electron hosts this runs in are not uniform.
  const platform = (source.userAgentData?.platform ?? source.platform ?? '').toLowerCase();
  if (platform !== '') {
    return /mac|iphone|ipad|ipod/.test(platform);
  }
  return /mac os x|macintosh|iphone|ipad|ipod/.test((source.userAgent ?? '').toLowerCase());
}

/** The label for the copy/paste modifier in shortcut hints: `⌘` or `Ctrl`. */
export function primaryModifierLabel(nav?: PlatformNavigator): string {
  return isMacPlatform(nav) ? '⌘' : 'Ctrl';
}
