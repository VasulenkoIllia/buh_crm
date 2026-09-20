import { useState } from "react";
import { Modal } from "@/shared/ui/modal";
import { askForNotifications, chatSettings, setChatSettings } from "./notify-settings";

/**
 * **Chat settings, on this computer** (chat.md §17): the sound, and browser notifications. Turning
 * notifications on is what asks the browser for permission; nothing asks unprompted.
 */
export function NotifySettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState(chatSettings());
  const [refused, setRefused] = useState(false);

  const save = (next: typeof settings) => {
    setSettings(next);
    setChatSettings(next);
  };

  return (
    <Modal open onClose={onClose} title="Chat on this computer">
      <label className="flex items-start gap-2 py-1.5 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={settings.sound}
          onChange={(e) => save({ ...settings, sound: e.target.checked })}
        />
        <span>
          Sound for a new message
          <span className="block text-[12px] text-muted">
            In a chat you are not looking at, and not in a muted one.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 py-1.5 text-[13px]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={settings.browser}
          onChange={async (e) => {
            if (!e.target.checked) {
              save({ ...settings, browser: false });
              return;
            }
            const answer = await askForNotifications();
            setRefused(answer !== "granted");
            save({ ...settings, browser: answer === "granted" });
          }}
        />
        <span>
          Browser notifications
          <span className="block text-[12px] text-muted">
            Who wrote and where, never the text: a notification can stay on a shared screen.
          </span>
        </span>
      </label>

      {refused && (
        <p className="mt-1 text-[12px] text-danger-text">
          The browser refused. Allow notifications for this site in its settings, then try
          again.
        </p>
      )}
    </Modal>
  );
}
