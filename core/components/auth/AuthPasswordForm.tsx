"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button, Input } from "@/components/ui";
import type { ApiErrorBody } from "@/lib/api-error";

/**
 * The one credentials form both auth pages render: `/login` posts to the
 * login endpoint, `/setup` to the first-run setup endpoint (which creates
 * the first admin). On success the session cookie is already set by the
 * response; a hard navigation reloads the server-rendered tree as an
 * authenticated visitor.
 */
export function AuthPasswordForm({
  endpoint,
  submitLabel,
  autoComplete,
}: {
  endpoint: string;
  submitLabel: string;
  autoComplete: "current-password" | "new-password";
}) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        aria-label="Username"
        placeholder="Username"
        autoFocus
      />
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete={autoComplete}
        aria-label="Password"
        placeholder="Password"
      />
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button
        type="submit"
        disabled={busy || username.length === 0 || password.length === 0}
        className="w-full"
      >
        {busy ? "Working…" : submitLabel}
      </Button>
    </form>
  );
}
