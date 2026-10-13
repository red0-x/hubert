/**
 * Pure keyboard-navigation logic for the Hubert shell.
 *
 * Kept free of the DOM so it can be unit tested: `resolveKey` maps a key event
 * to an intent, and the shell decides what to do with it. `isTypingElement`
 * guards against stealing keys from text fields and from shortcut capture.
 */

export type KeyLike = {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
};

export type KeyContext = {
  /** Focus is inside a text field or the shortcut-capture input. */
  typing?: boolean;
  /** The settings dialog is open (it owns the keyboard, e.g. while capturing a shortcut). */
  recording?: boolean;
  /** The shortcuts overlay is open, so Escape should close it. */
  overlayOpen?: boolean;
  /** The voice shortcut code (KeyboardEvent.code), never treated as a panel key. */
  shortcut?: string | null;
};

export type KeyAction =
  | { type: "panel"; index: number }
  | { type: "move"; delta: 1 | -1 }
  | { type: "open" }
  | { type: "filter" }
  | { type: "help" }
  | { type: "dismiss" };

/** Number keys 1-5: the four panels, then settings. */
export const PANEL_KEYS = ["1", "2", "3", "4", "5"] as const;
export const MAX_PANELS = PANEL_KEYS.length;

/** Rows explicitly marked as navigable, with a fallback for plain list markup. */
export const NAV_ITEM_SELECTOR = "[data-nav-item]";
export const NAV_FALLBACK_SELECTOR = "li button:not([disabled]), li a[href]";

/** Minimal element shape, so the check is testable without a real DOM. */
export type TypingElement = { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown };

export function isTypingElement(el: TypingElement | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return typeof el.closest === "function" && !!el.closest("input,textarea,select,[contenteditable]");
}

/** True when a modifier that implies a browser/OS shortcut is held. */
function modified(k: KeyLike): boolean {
  return !!(k.ctrlKey || k.metaKey || k.altKey);
}

export function resolveKey(k: KeyLike, ctx: KeyContext = {}): KeyAction | null {
  // Escape closes the overlay even from a field; otherwise leave it to the field/recorder.
  if (k.key === "Escape") return ctx.overlayOpen ? { type: "dismiss" } : null;

  // Never steal keys while typing, capturing a shortcut, or matching the voice shortcut.
  if (ctx.typing || ctx.recording) return null;
  if (ctx.shortcut && k.code && k.code === ctx.shortcut) return null;

  if (modified(k)) return null;

  const panel = PANEL_KEYS.indexOf(k.key as (typeof PANEL_KEYS)[number]);
  if (panel >= 0) return { type: "panel", index: panel };

  switch (k.key) {
    case "j":
    case "J":
      return { type: "move", delta: 1 };
    case "k":
    case "K":
      return { type: "move", delta: -1 };
    case "Enter":
      return { type: "open" };
    case "/":
      return { type: "filter" };
    case "?":
      return { type: "help" };
    default:
      return null;
  }
}
