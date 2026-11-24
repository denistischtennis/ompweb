import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsersAdmin } from "./UsersAdmin";

test("the users panel renders its create form and table shell before data arrives", () => {
  const html = renderToStaticMarkup(createElement(UsersAdmin));
  // Default English render: the account form plus every column header, with an empty body until the fetch resolves.
  assert.match(html, /Add user/);
  assert.match(html, /aria-label="Username"/);
  assert.match(html, /type="password"/);
  assert.match(html, /<thead>.*<th[^>]*>Username<\/th><th[^>]*>Role<\/th><th[^>]*>Status<\/th><th[^>]*>Created<\/th><th[^>]*>Actions<\/th>.*<\/thead>/s);
  assert.match(html, /<tbody>\s*<\/tbody>/, "no rows may exist before the list loads");
});
