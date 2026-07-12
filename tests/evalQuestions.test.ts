import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const questions = JSON.parse(
  readFileSync("evals/questions.json", "utf8"),
) as Array<{ id: string; question: string }>;

assert.equal(questions.length, 61);
assert.equal(new Set(questions.map(({ id }) => id)).size, questions.length);
assert.ok(questions.every(({ question }) => question.trim().length > 0));

console.log("eval question tests passed");
