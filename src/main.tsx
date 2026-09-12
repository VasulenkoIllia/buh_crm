import React from "react";
import ReactDOM from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { ME_QUERY_KEY } from "./app/auth";
import { router } from "./app/router";
import { ApiError } from "./shared/lib/api";
import "./styles/globals.css";

// Any 401 mid-session (expired/revoked cookie) drops the cached user, so the
// RequireAuth route guard bounces to /sign-in instead of leaving broken pages.
// A 403 `two_factor_required` means the firm's two-factor rule now holds this person back
// (two-factor.md §6.4): refetch who they are, and RequireAuth sends them to their profile.
function onApiError(error: unknown) {
  if (!(error instanceof ApiError)) return;
  if (error.status === 401) {
    queryClient.setQueryData(ME_QUERY_KEY, null);
  } else if (error.code === "two_factor_required") {
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
