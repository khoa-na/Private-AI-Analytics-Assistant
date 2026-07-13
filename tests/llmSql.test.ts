import assert from "node:assert/strict";
import { getSqlContext } from "../lib/llmSql";

const context = getSqlContext();
assert.match(context, /Schema:/);
assert.match(context, /Dataset semantics:/);
assert.match(context, /orders\(/);

console.log("llmSql tests passed");
