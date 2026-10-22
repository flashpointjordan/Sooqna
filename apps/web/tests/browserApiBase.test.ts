import assert from "node:assert/strict";
import { resolveBrowserApiBase } from "../src/services/browserApiBase";

assert.equal(resolveBrowserApiBase("https://un.flashpointjordan.com/api", true), "/api");
assert.equal(resolveBrowserApiBase("https://sooqna.shop/api", true), "/api");
assert.equal(resolveBrowserApiBase(undefined, true), "/api");
assert.equal(resolveBrowserApiBase("http://localhost:5000/api/", false), "http://localhost:5000/api");
assert.equal(resolveBrowserApiBase(undefined, false), "http://localhost:5000/api");
console.log("browser API origin tests passed");
