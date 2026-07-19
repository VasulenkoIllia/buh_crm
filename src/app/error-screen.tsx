import { useRouteError } from "react-router-dom";
import { Button } from "@/shared/ui/button";

/** Friendly boundary for unexpected render/loader errors — replaces a blank screen. */
export function ErrorScreen() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Something went wrong.";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-[20px] font-semibold">Something went wrong</h1>
      <p className="max-w-md text-[13px] text-muted">{message}</p>
      <Button onClick={() => window.location.reload()}>Reload the page</Button>
    </div>
  );
}
