import assert from "node:assert/strict";
import { parseLastJsonObject } from "../lib/jsonOutput";

assert.deepEqual(
  parseLastJsonObject(
    'draft {"intent":"analysis"}<｜end▁of▁thinking｜>{"intent":"refusal","message":"No."}',
  ),
  { intent: "refusal", message: "No." },
);
assert.deepEqual(
  parseLastJsonObject('reasoning with {broken}\nObject{"outer":{"text":"a } brace"}}'),
  { outer: { text: "a } brace" } },
);
assert.throws(() => parseLastJsonObject("no object"), /no valid JSON object/);

console.log("jsonOutput tests passed");
