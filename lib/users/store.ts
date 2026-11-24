import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "../omp/paths";
import { hashPassword, isPasswordHash, PASSWORD_HASH_MIN_LOG_N, verifyPassword, type PasswordHashOptions } from "../web-password-hash";
import { asNumber, asString, isRecord } from "../type-guards";

/**
 * The multi-user account store (fork: isolated spaces). One SQLite database at
 * `<agent dir>/omp-web/users.db`, the same location class as `web-auth-secret.json`.
 * An empty or missing database means the server runs in its original single-password
 * mode; the first row switches it to multi-user mode. `usersDatabaseExists()` is a
 * pure check: the gate calls it on every request and must not create anything.
 */

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "banned";

/** A user as callers outside the store see it: never the password hash. */
export interface UserAccount {
  id: number;
  username: string;
  role: UserRole;
  status: UserStatus;
  /** Bumped by a password reset or a ban; sessions signed for an older epoch die with it. */
  tokenEpoch: number;
  createdAt: number;
  updatedAt: number;
  /** The user's OpenVPN client config (phase 5); its presence means their space routes through the VPN. */
  vpnProfile: string | null;
}

interface UserRow extends UserAccount {
  passwordHash: string;
}

export class UserInputError extends Error {}
export class UsernameTakenError extends UserInputError {}
/** Refused when a change would leave the installation without any active admin. */
export class LastAdminError extends UserInputError {}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const MIN_PASSWORD_LENGTH = 8;

/** Usernames are stored lower-case so `Bob` and `bob` cannot be two accounts. */
export function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") throw new UserInputError("username must be a string");
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new UserInputError("username must be 2-64 characters of [a-z0-9._-], starting with a letter or digit");
  }
  return username;
}

/** SQLite rows come back as `Record<string, SQLOutputValue> | null`; normalize once instead of casting per call site. */
function rowFrom(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function resolvePassword({ password, passwordHash, options }: { password?: string; passwordHash?: string; options?: PasswordHashOptions }): string {
  if (password !== undefined && passwordHash !== undefined) throw new UserInputError("give either password or passwordHash, not both");
  if (passwordHash !== undefined) {
    if (!isPasswordHash(passwordHash)) throw new UserInputError("passwordHash is not a valid scrypt password hash");
    return passwordHash;
  }
  if (typeof password !== "string") throw new UserInputError("password or passwordHash is required");
  if (password.length < MIN_PASSWORD_LENGTH) throw new UserInputError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  // A hash handed over as the plaintext would store the credential twice over and let its holder sign sessions.
  if (isPasswordHash(password)) throw new UserInputError("password looks like a hash; pass it as passwordHash");
  return hashPassword(password, options);
}

export function isRole(value: unknown): value is UserRole {
  return value === "admin" || value === "user";
}
export function isStatus(value: unknown): value is UserStatus {
  return value === "active" || value === "banned";
}

export class UserStore {
  private readonly db: DatabaseSync;
  private static timingDummyHash: string | undefined;

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // The database holds password hashes and VPN keys: owner-only, like every other credential file on disk.
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Windows has no POSIX mode bits; the file is still user-scoped by ACL.
    }
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        status TEXT NOT NULL CHECK (status IN ('active', 'banned')),
        password_hash TEXT NOT NULL,
        token_epoch INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        vpn_profile TEXT
      )
    `);
    // Databases created before phase 5 gain the column in place.
    const userColumns = this.db.prepare("PRAGMA table_info(users)").all().map((column) => asString(rowFrom(column)?.name));
    if (!userColumns.includes("vpn_profile")) this.db.exec("ALTER TABLE users ADD COLUMN vpn_profile TEXT");
    // Ownership tables (phase 3): which account created each session/project.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_owners (
        session_id TEXT NOT NULL PRIMARY KEY,
        user_id INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_owners (
        project_key TEXT NOT NULL PRIMARY KEY,
        user_id INTEGER NOT NULL
      )
    `);
  }

  private static map(row: Record<string, unknown> | undefined): UserRow | undefined {
    if (!row) return undefined;
    const { id, username, role, status, password_hash: passwordHash, token_epoch: tokenEpoch, created_at: createdAt, updated_at: updatedAt, vpn_profile: vpnProfile } = row;
    if (typeof id !== "number" || typeof username !== "string" || !isRole(role) || !isStatus(status) || typeof passwordHash !== "string" || typeof tokenEpoch !== "number" || typeof createdAt !== "number" || typeof updatedAt !== "number") {
      throw new Error(`users.db contains an invalid row (id ${String(id)})`);
    }
    if (vpnProfile !== null && typeof vpnProfile !== "string") throw new Error(`users.db row ${String(id)} has a non-string vpn_profile`);
    return { id, username, role, status, passwordHash, tokenEpoch, createdAt, updatedAt, vpnProfile: vpnProfile ?? null };
  }

  private static account(row: UserRow): UserAccount {
    const { id, username, role, status, tokenEpoch, createdAt, updatedAt, vpnProfile } = row;
    return { id, username, role, status, tokenEpoch, createdAt, updatedAt, vpnProfile };
  }

  countUsers(): number {
    return asNumber(rowFrom(this.db.prepare("SELECT COUNT(*) AS n FROM users").get())?.n) ?? 0;
  }

  hasAnyUser(): boolean {
    return this.countUsers() > 0;
  }

  listUsers(): UserAccount[] {
    return this.db
      .prepare("SELECT * FROM users ORDER BY username")
      .all()
      .flatMap((row) => {
        const user = UserStore.map(rowFrom(row));
        return user ? [UserStore.account(user)] : [];
      });
  }

  findUserById(id: number): UserAccount | undefined {
    const row = UserStore.map(rowFrom(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id)));
    return row && UserStore.account(row);
  }

  findUserByUsername(username: string): UserAccount | undefined {
    const row = UserStore.map(rowFrom(this.db.prepare("SELECT * FROM users WHERE username = ?").get(normalizeUsername(username))));
    return row && UserStore.account(row);
  }

  /** The full row including the hash; login and session checks need it. */
  lookupForAuth(username: string): UserRow | undefined {
    return UserStore.map(rowFrom(this.db.prepare("SELECT * FROM users WHERE username = ?").get(normalizeUsername(username))));
  }

  lookupForAuthById(id: number): UserRow | undefined {
    return UserStore.map(rowFrom(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id)));
  }

  activeAdminCount(excludeId?: number): number {
    const ids = this.db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").all().flatMap((row) => {
      const id = asNumber(rowFrom(row)?.id);
      return id === undefined ? [] : [id];
    });
    return excludeId === undefined ? ids.length : ids.filter((id) => id !== excludeId).length;
  }

  createUser(input: { username: unknown; role: unknown; password?: string; passwordHash?: string; options?: PasswordHashOptions }): UserAccount {
    const username = normalizeUsername(input.username);
    if (!isRole(input.role)) throw new UserInputError("role must be \"admin\" or \"user\"");
    const passwordHash = resolvePassword(input);
    const now = Date.now();
    try {
      this.db.prepare("INSERT INTO users (username, role, status, password_hash, token_epoch, created_at, updated_at) VALUES (?, ?, 'active', ?, 0, ?, ?)").run(username, input.role, passwordHash, now, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE")) throw new UsernameTakenError(`username "${username}" is taken`);
      throw error;
    }
    return this.findUserByUsername(username)!;
  }

  setRole(id: number, role: UserRole): UserAccount {
    if (!isRole(role)) throw new UserInputError("role must be \"admin\" or \"user\"");
    const user = this.findUserById(id);
    if (!user) throw new UserInputError(`no user ${id}`);
    // Demoting must not leave the installation without anyone who can administer it.
    if (user.role === "admin" && role === "user" && this.activeAdminCount(id) === 0) throw new LastAdminError("this is the last active admin");
    this.db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, Date.now(), id);
    return this.findUserById(id)!;
  }

  setStatus(id: number, status: UserStatus): UserAccount {
    if (!isStatus(status)) throw new UserInputError("status must be \"active\" or \"banned\"");
    const user = this.findUserById(id);
    if (!user) throw new UserInputError(`no user ${id}`);
    if (user.status === status) return user;
    if (user.role === "admin" && status === "banned" && this.activeAdminCount(id) === 0) throw new LastAdminError("this is the last active admin");
    // A ban ends every live session immediately; an unban starts a fresh epoch too.
    this.db.prepare("UPDATE users SET status = ?, token_epoch = token_epoch + 1, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    return this.findUserById(id)!;
  }

  resetPassword(id: number, input: { password?: string; passwordHash?: string; options?: PasswordHashOptions }): UserAccount {
    const user = this.findUserById(id);
    if (!user) throw new UserInputError(`no user ${id}`);
    const passwordHash = resolvePassword(input);
    this.db.prepare("UPDATE users SET password_hash = ?, token_epoch = token_epoch + 1, updated_at = ? WHERE id = ?").run(passwordHash, Date.now(), id);
    return this.findUserById(id)!;
  }

  /** Store (or clear, with null) the account's OpenVPN client config; setting it routes their space through the VPN. */
  setVpnProfile(id: number, profile: string | null): UserAccount {
    const user = this.findUserById(id);
    if (!user) throw new UserInputError(`no user ${id}`);
    let stored: string | null = null;
    if (profile !== null) {
      if (typeof profile !== "string") throw new UserInputError("vpnProfile must be a string or null");
      const trimmed = profile.trim();
      if (trimmed.length > 0) {
        if (!/^\s*client\b/m.test(trimmed) || !/^\s*remote\s+\S+/m.test(trimmed)) {
          throw new UserInputError("vpnProfile must be an OpenVPN client config (needs \"client\" and \"remote <host> <port>\" lines)");
        }
        stored = trimmed;
      }
    }
    this.db.prepare("UPDATE users SET vpn_profile = ?, updated_at = ? WHERE id = ?").run(stored, Date.now(), id);
    return this.findUserById(id)!;
  }

  deleteUser(id: number): void {
    const user = this.findUserById(id);
    if (!user) throw new UserInputError(`no user ${id}`);
    if (user.role === "admin" && this.activeAdminCount(id) === 0) throw new LastAdminError("this is the last active admin");
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  /** The account whose password matches, or null. Banned users cannot sign in; unknown and banned
   * accounts still pay a scrypt verification, so login timing cannot enumerate usernames. */
  verifyLogin(username: string, password: string): UserAccount | null {
    const row = this.lookupForAuth(username);
    if (!row || row.status !== "active") {
      verifyPassword(password, (UserStore.timingDummyHash ??= hashPassword("omp-web-timing-dummy", { logN: PASSWORD_HASH_MIN_LOG_N })));
      return null;
    }
    return verifyPassword(password, row.passwordHash) ? UserStore.account(row) : null;
  }

  /* ── Ownership tables (phase 3): scoping sessions/projects to accounts ─── */

  /** Write one ownership row and read back its owner; `replace: false` keeps any existing owner (claim semantics). */
  private setOwner(table: "session_owners" | "project_owners", column: string, key: string, userId: number, replace: boolean): number {
    if (!key) throw new UserInputError(`${column} is required`);
    if (!this.findUserById(userId)) throw new UserInputError(`no user ${userId}`);
    const conflict = replace ? "DO UPDATE SET user_id = excluded.user_id" : "DO NOTHING";
    this.db.prepare(`INSERT INTO ${table} (${column}, user_id) VALUES (?, ?) ON CONFLICT(${column}) ${conflict}`).run(key, userId);
    return asNumber(rowFrom(this.db.prepare(`SELECT user_id FROM ${table} WHERE ${column} = ?`).get(key))?.user_id) ?? userId;
  }

  /** Records (or moves) the owner of a session. The user must exist. */
  setSessionOwner(sessionId: string, userId: number): void {
    this.setOwner("session_owners", "session_id", sessionId.trim(), userId, true);
  }

  sessionOwner(sessionId: string): number | null {
    return asNumber(rowFrom(this.db.prepare("SELECT user_id FROM session_owners WHERE session_id = ?").get(sessionId))?.user_id) ?? null;
  }

  ownedSessionIds(userId: number): string[] {
    return this.db.prepare("SELECT session_id FROM session_owners WHERE user_id = ? ORDER BY session_id").all(userId)
      .flatMap((row) => {
        const id = rowFrom(row)?.session_id;
        return typeof id === "string" ? [id] : [];
      });
  }

  /** Records the owner of a project keyed by the routes' project identity. The user must exist.
   * Without `force` an existing row is never overwritten — ownership cannot be stolen — and the current
   * owner id is returned either way; `force: true` replaces it (admins may reassign). */
  setProjectOwner(projectKey: string, userId: number, options?: { force?: boolean }): number {
    return this.setOwner("project_owners", "project_key", projectKey.trim(), userId, options?.force === true);
  }

  projectOwner(projectKey: string): number | null {
    return asNumber(rowFrom(this.db.prepare("SELECT user_id FROM project_owners WHERE project_key = ?").get(projectKey))?.user_id) ?? null;
  }

  ownedProjectIds(userId: number): string[] {
    return this.db.prepare("SELECT project_key FROM project_owners WHERE user_id = ? ORDER BY project_key").all(userId)
      .flatMap((row) => {
        const key = rowFrom(row)?.project_key;
        return typeof key === "string" ? [key] : [];
      });
  }
}

export function usersDbPath(): string {
  return resolve(getAgentDir(), "omp-web", "users.db");
}

/** True when the users database file is present. Pure: never creates it. */
export function usersDatabaseExists(): boolean {
  return existsSync(usersDbPath());
}

/** Multi-user mode: the database exists and holds at least one account. */
export function isMultiUserMode(): boolean {
  return usersDatabaseExists() && getUserStore().hasAnyUser();
}

let cached: { path: string; store: UserStore } | null = null;

/** Open (or reuse) the store; one connection per path for the process lifetime — external writers are visible through it. */
export function getUserStore(): UserStore {
  const path = usersDbPath();
  if (cached && cached.path === path) return cached.store;
  const store = new UserStore(path);
  cached = { path, store };
  return store;
}

/** Test seam: forget the memoized store so the next call reads the current agent directory. */
export function resetUserStoreCache(): void {
  cached = null;
}
