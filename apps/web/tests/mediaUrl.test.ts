import assert from "node:assert/strict";
import { resolvePublicMediaUrl } from "../src/lib/mediaUrl";

process.env.NEXT_PUBLIC_UPLOADS_PUBLIC_BASE_URL = "https://sooqna.shop/uploads";
assert.equal(resolvePublicMediaUrl("https://un.flashpointjordan.com/uploads/listings/old.jpg?v=1"), "https://sooqna.shop/uploads/listings/old.jpg?v=1");
assert.equal(resolvePublicMediaUrl("http://localhost:5000/uploads/listings/old.jpg"), "https://sooqna.shop/uploads/listings/old.jpg");
assert.equal(resolvePublicMediaUrl("https://images.example.org/photo.jpg"), "https://images.example.org/photo.jpg");
assert.equal(resolvePublicMediaUrl("/uploads/listings/local.jpg"), "/uploads/listings/local.jpg");
assert.equal(resolvePublicMediaUrl(null), undefined);
console.log("media URL origin tests passed");
