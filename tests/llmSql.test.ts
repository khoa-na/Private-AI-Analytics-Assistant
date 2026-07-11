import assert from "node:assert/strict";
import { executeDatasetGuideTool, selectDatasetGuideCall } from "../lib/llmSql";

assert.match(
  executeDatasetGuideTool({
    id: "call-1",
    type: "function",
    function: {
      name: "get_dataset_guide",
      arguments: '{"dataset":"olist"}',
    },
  }),
  /Data model contract/,
);
assert.throws(
  () =>
    executeDatasetGuideTool({
      id: "call-2",
      type: "function",
      function: {
        name: "get_dataset_guide",
        arguments: { dataset: "../../.env.local" },
      },
    }),
  /unknown dataset/,
);
assert.deepEqual(selectDatasetGuideCall([]).function.arguments, {
  dataset: "olist",
});

console.log("llmSql tests passed");
