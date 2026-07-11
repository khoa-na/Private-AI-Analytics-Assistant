import assert from "node:assert/strict";
import { getDatasetGuide } from "../lib/datasetGuide";

const guide = getDatasetGuide("olist");
assert.match(guide, /customers\.customer_id -> orders\.customer_id/);
assert.match(guide, /Do not invent product names/);
assert.match(guide, /Every cross-table `JOIN \.\.\. ON` must/);
assert.match(guide, /Path selection procedure/);
assert.match(guide, /Common traversal patterns/);
assert.match(guide, /Product rating[\s\S]*AVG\(CAST\(review_score AS REAL\)\)/);
assert.throws(() => getDatasetGuide("../../.env.local"), /Unknown dataset/);

console.log("datasetGuide tests passed");
