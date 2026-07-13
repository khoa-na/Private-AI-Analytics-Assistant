import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { getDatasetGuide } from "../lib/datasetGuide";

assert.match(getDatasetGuide(), /No dataset-specific semantics|./);
process.env.ACTIVE_DATASET_GUIDE_PATHS = ["docs/datasets/olist.semantic.json"].join(delimiter);
assert.match(getDatasetGuide(), /"forecasting": "unsupported/);

console.log("datasetGuide tests passed");
