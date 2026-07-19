export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  formData?: FormData;
}

/** Same-origin JSON API client (Vite proxies /api in dev). */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, formData } = options;
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: formData ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: "same-origin",
  });

  const json = res.status === 204 ? null : await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "error",
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  if (json === undefined) {
    // a 2xx with an unparseable body must not silently become null
    throw new ApiError(res.status, "invalid_response", "Unexpected non-JSON response");
  }
  return json as T;
}
