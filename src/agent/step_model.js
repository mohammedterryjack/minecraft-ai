import { selectAPI, createModel } from '../models/_model_map.js';

// The step model must answer with one JSON object. This is the only statement of that
// requirement; each api maps it, and an api with no mapping throws.
// ollama: chat `format: "json"` (https://github.com/ollama/ollama/blob/main/docs/api.md).
// openai-compatible (llama.cpp POST /v1/chat/completions, tools/server/README.md):
//   response_format {"type":"json_object"} or json_schema. Voyager's required keys differ
//   per call (curriculum, decompose, critic), so there is no single schema.
// The file lives outside src/models/ so _model_map's directory scan does not import it.
export const JSON_OBJECT = 'json_object';

const JSON_MODE = Object.freeze({
    ollama() {
        return { format: 'json' };
    },
    openai() {
        return { response_format: { type: JSON_OBJECT } };
    },
});

export function jsonModeParams(api, requirement) {
    if (requirement !== JSON_OBJECT) {
        throw new Error(`[voyager] JSON requirement must be ${JSON_OBJECT}, got ${JSON.stringify(requirement)}`);
    }
    const map = JSON_MODE[api];
    if (typeof map !== 'function') {
        throw new Error(`[voyager] no JSON-mode mapping for api ${JSON.stringify(api)}`);
    }
    return map();
}

function copyParams(params) {
    if (params === undefined) return undefined;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('[voyager] profile.model.params is malformed');
    }
    return { ...params };
}

// Build the voyager step model from profile.model through selectAPI/createModel.
// Generation options are whatever profile.model.params already names. Nothing here
// supplies a model, url, context size, or prediction cap.
export function createStepModel(profileModel) {
    if (profileModel === undefined || profileModel === null) {
        throw new Error('[voyager] profile.model is missing');
    }
    if (typeof profileModel !== 'object' || Array.isArray(profileModel)) {
        throw new Error(`[voyager] profile.model is malformed (${JSON.stringify(profileModel)})`);
    }
    if (typeof profileModel.api !== 'string' || profileModel.api.length === 0) {
        throw new Error('[voyager] profile.model.api is missing');
    }
    if (typeof profileModel.model !== 'string' || profileModel.model.length === 0) {
        throw new Error('[voyager] profile.model.model is missing');
    }
    if (typeof profileModel.url !== 'string' || profileModel.url.length === 0) {
        throw new Error('[voyager] profile.model.url is missing');
    }
    const selected = selectAPI({
        api: profileModel.api,
        model: profileModel.model,
        url: profileModel.url,
        params: copyParams(profileModel.params),
    });
    if (selected.api !== 'ollama' && selected.params !== undefined && Object.hasOwn(selected.params, 'keep_alive')) {
        throw new Error(`[voyager] keep_alive is only sent for api ollama, not ${selected.api}`);
    }
    const jsonParams = jsonModeParams(selected.api, JSON_OBJECT);
    const merged = selected.params === undefined ? {} : { ...selected.params };
    for (const [key, value] of Object.entries(jsonParams)) {
        if (Object.hasOwn(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
            throw new Error(`[voyager] profile.model.params.${key} conflicts with JSON mode ${JSON.stringify(value)}`);
        }
        merged[key] = value;
    }
    selected.params = merged;
    return createModel(selected);
}
