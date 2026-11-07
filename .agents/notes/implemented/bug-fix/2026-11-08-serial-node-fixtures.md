# Node fixture test isolation

The Node integration tests run with one test-file worker at a time. Several update and installer fixtures temporarily replace built-in subprocess or filesystem exports; the Node test runner can otherwise execute those files concurrently and let one fixture observe another file's mock. The update installer calls the default `node:child_process` object so its test replacement is observed consistently on every supported platform. Individual tests remain asynchronous within their file.

## Verification

`node --test --test-concurrency=1 tests/*.test.mjs` passes with the complete Node suite.
