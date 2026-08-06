import { useEffect, useState } from "react";

/**
 * A value that stops changing while you are still typing.
 *
 * Used by the meeting form's clash check: `startAt` and `duration` change on every keystroke, and
 * each distinct value is a separate request. Waiting for a pause turns a burst into one call —
 * which matters against the app's global rate limit, and stops the warning flickering through
 * nonsense intermediate slots ("9 minutes") on the way to a real one.
 */
export function useDebounced<T>(value: T, delayMs = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
