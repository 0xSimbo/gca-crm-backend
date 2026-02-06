export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

