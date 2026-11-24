"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

/** One account row as `GET /api/admin/users` returns it (the hash never reaches the browser). */
interface AdminUser {
  id: number;
  username: string;
  role: "admin" | "user";
  status: "active" | "banned";
  tokenEpoch: number;
  createdAt: number;
  updatedAt: number;
  /** The stored OpenVPN profile; its presence routes the account's space through the VPN. */
  vpnProfile?: string | null;
}

const fieldStyle = { minWidth: 140, minHeight: 36, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text)", fontSize: 13 } as const;
const buttonStyle = { minHeight: 32, padding: "4px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, cursor: "pointer" } as const;
const accentButtonStyle = { ...buttonStyle, background: "var(--accent-strong)", color: "var(--on-accent)", border: "0px" } as const;

/** The admin user panel (fork): create accounts, change roles, reset passwords, ban, unban, delete, set VPN. */
export function UsersAdmin() {
  const { t } = useI18n();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/admin/users");
    if (response.status === 403) {
      setError(t("usersAdmin.readonly"));
      setReadOnly(true);
      return;
    }
    if (!response.ok) {
      setError(t("usersAdmin.loadFailed"));
      return;
    }
    setError(null);
    setReadOnly(false);
    const body = (await response.json()) as { users?: unknown };
    setUsers(Array.isArray(body.users) ? (body.users as AdminUser[]) : []);
  }, [t]);

  useEffect(() => {
    void refresh().catch(() => setError(t("usersAdmin.loadFailed")));
  }, [refresh, t]);

  async function run(action: () => Promise<Response>) {
    setBusy(true);
    try {
      const response = await action();
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof payload?.error === "string" ? payload.error : t("usersAdmin.loadFailed"));
      } else {
        setError(null);
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(() =>
      fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      }),
    ).then(() => {
      setUsername("");
      setPassword("");
    });
  }

  function patchUser(user: AdminUser, body: Record<string, unknown>) {
    void run(() =>
      fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  function resetPassword(user: AdminUser) {
    const next = window.prompt(t("usersAdmin.newPasswordPrompt", { username: user.username }));
    if (!next) return;
    patchUser(user, { password: next });
  }

  /** Prompt for the OpenVPN profile; an empty answer removes it and takes the space off the VPN. */
  function setVpn(user: AdminUser) {
    const next = window.prompt(t("usersAdmin.vpnPrompt", { username: user.username }), "");
    if (next === null) return;
    patchUser(user, { vpnProfile: next.trim() === "" ? null : next });
  }

  function deleteUser(user: AdminUser) {
    if (!window.confirm(`${t("usersAdmin.delete")}: ${user.username}?`)) return;
    void run(() => fetch(`/api/admin/users/${user.id}`, { method: "DELETE" }));
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && <p role="alert" style={{ margin: 0, color: "var(--status-error)", fontSize: 12 }}>{error}</p>}
      {!readOnly && (
      <form onSubmit={createUser} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
        <input aria-label={t("usersAdmin.username")} style={fieldStyle} value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("usersAdmin.username")} required minLength={2} />
        <input aria-label={t("usersAdmin.password")} style={fieldStyle} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("usersAdmin.password")} required minLength={8} />
        <select aria-label={t("usersAdmin.role")} style={fieldStyle} value={role} onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}>
          <option value="user">{t("usersAdmin.role.user")}</option>
          <option value="admin">{t("usersAdmin.role.admin")}</option>
        </select>
        <button type="submit" className="ui-focus-ring" disabled={busy} style={accentButtonStyle}>{t("usersAdmin.add")}</button>
      </form>
      )}
      {!readOnly && (
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, color: "var(--text)" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 12 }}>
            <th style={{ padding: "6px 10px" }}>{t("usersAdmin.username")}</th>
            <th style={{ padding: "6px 10px" }}>{t("usersAdmin.role")}</th>
            <th style={{ padding: "6px 10px" }}>{t("usersAdmin.status")}</th>
            <th style={{ padding: "6px 10px" }}>{t("usersAdmin.created")}</th>
            <th style={{ padding: "6px 10px" }}>{t("usersAdmin.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {(users ?? []).map((user) => (
            <tr key={user.id} style={{ borderTop: "1px solid var(--border)" }}>
              <td style={{ padding: "6px 10px" }}>{user.username}</td>
              <td style={{ padding: "6px 10px" }}>{t(`usersAdmin.role.${user.role}`)}</td>
              <td style={{ padding: "6px 10px" }}>{t(`usersAdmin.status.${user.status}`)}</td>
              <td style={{ padding: "6px 10px" }}>{new Date(user.createdAt).toLocaleDateString()}</td>
              <td style={{ padding: "6px 10px" }}>
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => patchUser(user, { role: user.role === "admin" ? "user" : "admin" })}>
                    {user.role === "admin" ? t("usersAdmin.demote") : t("usersAdmin.promote")}
                  </button>
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => patchUser(user, { status: user.status === "banned" ? "active" : "banned" })}>
                    {user.status === "banned" ? t("usersAdmin.unban") : t("usersAdmin.ban")}
                  </button>
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => resetPassword(user)}>{t("usersAdmin.resetPassword")}</button>
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => setVpn(user)}>{user.vpnProfile ? t("usersAdmin.editVpn") : t("usersAdmin.setVpn")}</button>
                  <button type="button" disabled={busy} style={buttonStyle} onClick={() => deleteUser(user)}>{t("usersAdmin.delete")}</button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      )}
    </div>
  );
}
