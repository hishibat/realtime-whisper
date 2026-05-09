const STORAGE_KEY = "app_password";
export const PASSWORD_REJECTED_EVENT = "app-password-rejected";

export function getAppPassword(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAppPassword(pw: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, pw);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function clearAppPassword(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const pw = getAppPassword();
  const headers = new Headers(init?.headers);
  if (pw) headers.set("x-app-password", pw);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    clearAppPassword();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PASSWORD_REJECTED_EVENT));
    }
  }
  return res;
}
