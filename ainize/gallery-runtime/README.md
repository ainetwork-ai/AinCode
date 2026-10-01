# AINSpace-compatible Builder runtime

The intent classifier, form-intent classifier, skill selector, prompt builder, reasoning engine and executor originate from ainetwork-ai/a2a-agent-builder. The compiled modules retain their original algorithm; bridge.mjs maps model calls to Ainize and stores state in the per-agent /state mount. index.mjs adapts A2A parts and restores conversation history. manage.mjs exposes owner/admin memory operations through the node's authenticated management hook.

Editing source.json changes the agent definition without discarding its durable memories, image-send record or conversation history. Existing migration provenance remains in rawState._migration. A false fullSourceStateImported flag means the old service's complete private memory archive has not been imported.

AinCode serves /code/gallery and an ordinary Code session for AI authoring. New agents always have visibility=org and orgId=uncommon-gallery. Configure AINCODE_GALLERY_MODEL with an available long-context model; the deployed organization uses the same qualified Qwen3.8 peer as its migrated Builder agents. Files, model selection and organization are generated server-side; caller input cannot override execution code, credentials or publishing scope.
