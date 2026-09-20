/**
 * **What this computer does when a message arrives** (chat.md §10.1, §17): a sound, and a browser
 * notification. Kept per browser, because that is what they are about: the same person on another
 * computer decides again.
 *
 * The browser asks for permission once, when the person turns notifications on here.
 */

const KEY = "chat.notify";

export interface ChatNotifySettings {
  browser: boolean;
  sound: boolean;
}

const DEFAULTS: ChatNotifySettings = { browser: false, sound: true };

export function chatSettings(): ChatNotifySettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw
      ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ChatNotifySettings>) }
      : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function setChatSettings(next: ChatNotifySettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage switched off: the choice holds for this visit only
  }
  window.dispatchEvent(new CustomEvent("chat-notify-settings"));
}

/** Turning notifications on is what asks the browser; it is never asked unprompted. */
export async function askForNotifications(): Promise<NotificationPermission> {
  if (typeof Notification === "undefined") return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  return Notification.requestPermission();
}
