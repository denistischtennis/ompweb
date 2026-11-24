import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const {
  LastAdminError,
  UserInputError,
  UserStore,
  UsernameTakenError,
  normalizeUsername,
} = await import("./store.ts");
const { hashPassword } = await import("../web-password-hash.ts");

const PASSWORD = "correct horse battery staple";
// N = 2^12 for the suite: same code path as production, a fraction of the cost.
const make = () => new UserStore(join(mkdtempSync(join(tmpdir(), "ompweb-users-")), "users.db"));
const adminInput = { username: "root", role: "admin", password: PASSWORD, options: { logN: 12 } };

test("normalizeUsername lowercases, trims and validates", () => {
  assert.equal(normalizeUsername(" Bob.Smith "), "bob.smith");
  for (const invalid of ["", "a", "-lead", "sp ace", "up!per", "ä"]) {
    assert.throws(() => normalizeUsername(invalid), UserInputError, invalid);
  }
});

test("createUser stores the account without ever handing out the hash", () => {
  const store = make();
  assert.equal(store.hasAnyUser(), false);
  const user = store.createUser(adminInput);
  assert.equal(user.username, "root");
  assert.equal(user.role, "admin");
  assert.equal(user.status, "active");
  assert.equal(user.tokenEpoch, 0);
  assert.ok(user.id > 0);
  assert.equal("passwordHash" in user, false);
  assert.deepEqual(store.listUsers(), [user]);
  assert.deepEqual(store.findUserById(user.id), user);
  assert.deepEqual(store.findUserByUsername("ROOT"), user);
});

test("usernames are unique regardless of case", () => {
  const store = make();
  store.createUser(adminInput);
  assert.throws(() => store.createUser({ username: "Root", role: "user", password: PASSWORD, options: { logN: 12 } }), UsernameTakenError);
});

test("password input is validated", () => {
  const store = make();
  assert.throws(() => store.createUser({ username: "shorty", role: "user", password: "tiny", options: { logN: 12 } }), UserInputError);
  // A hash in the plaintext field would store the credential twice over.
  const hashed = hashPassword(PASSWORD, { logN: 12 });
  assert.throws(() => store.createUser({ username: "hasher", role: "user", password: hashed }), UserInputError);
  assert.throws(() => store.createUser({ username: "both", role: "user", password: PASSWORD, passwordHash: hashed, options: { logN: 12 } }), UserInputError);
  assert.throws(() => store.createUser({ username: "nope", role: "wizard", password: PASSWORD, options: { logN: 12 } }), UserInputError);
  assert.throws(() => store.createUser({ username: "nobody", role: "user" }), UserInputError);
  // An arbitrary string in passwordHash must not pass as a credential either.
  assert.throws(() => store.createUser({ username: "junk", role: "user", passwordHash: "not-a-hash" }), UserInputError);
});

test("verifyLogin accepts only active accounts with the right password", () => {
  const store = make();
  const user = store.createUser({ username: "root", role: "user", password: PASSWORD, options: { logN: 12 } });
  assert.deepEqual(store.verifyLogin("root", PASSWORD), user);
  assert.equal(store.verifyLogin("root", "wrong password"), null);
  store.setStatus(user.id, "banned");
  assert.equal(store.verifyLogin("root", PASSWORD), null);
  store.setStatus(user.id, "active");
  assert.deepEqual(store.verifyLogin("root", PASSWORD), store.findUserById(user.id));
});

test("ban and password reset bump the token epoch; a no-op status change does not", () => {
  const store = make();
  const user = store.createUser({ username: "bob", role: "user", password: PASSWORD, options: { logN: 12 } });
  assert.equal(user.tokenEpoch, 0);
  store.setStatus(user.id, "active");
  assert.equal(store.findUserById(user.id).tokenEpoch, 0);
  const banned = store.setStatus(user.id, "banned");
  assert.equal(banned.tokenEpoch, 1);
  store.setStatus(user.id, "active");
  assert.equal(store.findUserById(user.id).tokenEpoch, 2);
  const reset = store.resetPassword(user.id, { password: "a-brand-new-secret", options: { logN: 12 } });
  assert.equal(reset.tokenEpoch, 3);
  assert.equal(store.verifyLogin("bob", PASSWORD), null);
  assert.ok(store.verifyLogin("bob", "a-brand-new-secret"));
});

test("the last active admin cannot be demoted, banned or deleted", () => {
  const store = make();
  const root = store.createUser(adminInput);
  const second = store.createUser({ username: "second", role: "user", password: PASSWORD, options: { logN: 12 } });
  assert.throws(() => store.setRole(root.id, "user"), LastAdminError);
  assert.throws(() => store.setStatus(root.id, "banned"), LastAdminError);
  assert.throws(() => store.deleteUser(root.id), LastAdminError);
  // With two admins every move on one of them is fine.
  store.setRole(second.id, "admin");
  store.deleteUser(second.id);
  const third = store.createUser({ username: "third", role: "admin", password: PASSWORD, options: { logN: 12 } });
  store.setStatus(third.id, "banned");
  assert.equal(store.activeAdminCount(), 1);
  store.setRole(third.id, "user");
  assert.equal(store.activeAdminCount(), 1);
});

test("mutations return the fresh row and missing users are rejected", () => {
  const store = make();
  const user = store.createUser({ username: "carol", role: "user", password: PASSWORD, options: { logN: 12 } });
  const promoted = store.setRole(user.id, "admin");
  assert.equal(promoted.role, "admin");
  assert.ok(promoted.updatedAt >= user.createdAt);
  assert.throws(() => store.setRole(9999, "admin"), UserInputError);
  assert.throws(() => store.setStatus(9999, "active"), UserInputError);
  assert.throws(() => store.resetPassword(9999, { password: PASSWORD, options: { logN: 12 } }), UserInputError);
  assert.throws(() => store.deleteUser(9999), UserInputError);
  assert.equal(store.findUserById(9999), undefined);
});
