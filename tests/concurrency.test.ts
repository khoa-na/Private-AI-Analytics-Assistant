import assert from "node:assert/strict";
import { forEachConcurrent } from "../lib/concurrency";

let active = 0;
let maxActive = 0;
const completed: number[] = [];

await forEachConcurrent([0, 1, 2, 3], 2, async (item) => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise<void>((resolve) => setImmediate(resolve));
  completed.push(item);
  active -= 1;
});

assert.equal(maxActive, 2);
assert.deepEqual(completed.sort(), [0, 1, 2, 3]);
await assert.rejects(() => forEachConcurrent([1], 0, async () => {}), /positive integer/);

console.log("concurrency tests passed");
