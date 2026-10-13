import celWasmModule from "./cel_engine.wasm";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_EXPRESSION_BYTES = 4 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type WorkerEnv = Env & {
	API_TOKEN?: string;
};

export type CelExports = WebAssembly.Exports & {
	memory: WebAssembly.Memory;
	cel_alloc: (length: number) => number;
	cel_free: (pointer: number, length: number) => void;
	cel_eval_json: (pointer: number, length: number) => number;
	cel_batch_eval_json: (pointer: number, length: number) => number;
	cel_precompile: (pointer: number, length: number) => number;
	cel_batch_precompile: (pointer: number, length: number) => number;
	cel_list_programs: () => number;
	cel_free_cstring: (pointer: number) => void;
	cel_free_output: (pointer: number) => void;
};

export interface CelEvaluationResult {
	success: boolean;
	value: unknown;
	value_type: string;
	program_id?: string;
	error_code?: string;
	error?: string;
	execution_time_us?: number;
}

export interface CelPrecompileResult {
	valid: boolean;
	error_code?: string;
	error?: string;
	program_id?: string;
	complexity?: number;
	variables?: string[];
	functions?: string[];
}

export interface PrecompileScript {
	source: string;
	id?: string;
}

export interface CelBatchPrecompileResult {
	success: boolean;
	total_compiled: number;
	total_failed: number;
	results: CelPrecompileResult[];
	execution_time_us?: number;
}

export interface ProgramInfo {
	id: string;
	source: string;
	complexity: number;
	variables: string[];
	functions: string[];
}

export interface ProgramListResult {
	count: number;
	programs: ProgramInfo[];
}

export interface BatchRule {
	id: string;
	source?: string;
	program_id?: string;
}

export interface BatchRuleResult {
	id: string;
	success: boolean;
	value: unknown;
	value_type: string;
	program_id?: string;
	error_code?: string;
	error?: string;
}

export interface CelBatchEvaluationResult {
	success: boolean;
	results: BatchRuleResult[];
	total_evaluated: number;
	total_failed: number;
	execution_time_us?: number;
}

let compiledModule: WebAssembly.Module | null = null;
function getWasmModule(): WebAssembly.Module {
	if (!compiledModule) {
		if (typeof WebAssembly !== "undefined" && celWasmModule instanceof WebAssembly.Module) {
			compiledModule = celWasmModule;
		} else if (typeof celWasmModule === "string") {
			// Running in Bun or Node where .wasm import yields a filesystem path
			const fs = require("node:fs");
			compiledModule = new WebAssembly.Module(fs.readFileSync(celWasmModule));
		} else {
			compiledModule = new WebAssembly.Module(celWasmModule as unknown as BufferSource);
		}
	}
	return compiledModule;
}

let isolateInstance: CelExports | null = null;

export function getOrCreateIsolateInstance(): CelExports {
	if (!isolateInstance) {
		const instance = new WebAssembly.Instance(getWasmModule(), {});
		isolateInstance = instance.exports as CelExports;
	}
	return isolateInstance;
}

export function createCelInstance(): CelExports {
	return getOrCreateIsolateInstance();
}

const programSourceCache = new Map<string, string>();

export function evaluateCel(
	source?: string,
	context: Record<string, unknown> = {},
	programId?: string,
): CelEvaluationResult {
	const start = performance.now();
	const wasm = getOrCreateIsolateInstance();
	let resolvedSource = source && source.trim().length > 0 ? source : undefined;
	if (!resolvedSource && programId) {
		resolvedSource = programSourceCache.get(programId);
	}

	const payloadBytes = encoder.encode(
		JSON.stringify({
			source: resolvedSource,
			program_id: programId,
			context,
		}),
	);
	const inputPtr = wasm.cel_alloc(payloadBytes.byteLength);
	if (!inputPtr) {
		throw new Error("Unable to allocate CEL request memory");
	}

	let outputPtr = 0;
	let outputLen = 0;
	try {
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).set(payloadBytes);
		outputPtr = wasm.cel_eval_json(inputPtr, payloadBytes.byteLength);
		if (!outputPtr) {
			throw new Error("CEL runtime returned no response");
		}
		const dv = new DataView(wasm.memory.buffer);
		outputLen = dv.getUint32(outputPtr - 4, true);
		const memory = new Uint8Array(wasm.memory.buffer);
		const output = decoder.decode(memory.subarray(outputPtr, outputPtr + outputLen));
		const delimiter = output.indexOf("\n");
		const jsonStr = output.slice(delimiter + 1);
		const parsed = JSON.parse(jsonStr) as CelEvaluationResult;
		const latencyUs = Math.round((performance.now() - start) * 1000);
		parsed.execution_time_us = latencyUs;
		if (parsed.success && parsed.program_id && resolvedSource) {
			programSourceCache.set(parsed.program_id, resolvedSource);
		}
		return parsed;
	} finally {
		if (outputPtr) {
			new Uint8Array(wasm.memory.buffer, outputPtr, outputLen).fill(0);
			wasm.cel_free_cstring(outputPtr);
		}
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).fill(0);
		wasm.cel_free(inputPtr, payloadBytes.byteLength);
	}
}

export function precompileCel(source: string, id?: string): CelPrecompileResult {
	const wasm = getOrCreateIsolateInstance();
	const payloadBytes = encoder.encode(JSON.stringify({ source, id }));
	const inputPtr = wasm.cel_alloc(payloadBytes.byteLength);
	if (!inputPtr) {
		throw new Error("Unable to allocate CEL request memory");
	}

	let outputPtr = 0;
	let outputLen = 0;
	try {
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).set(payloadBytes);
		outputPtr = wasm.cel_precompile(inputPtr, payloadBytes.byteLength);
		if (!outputPtr) {
			throw new Error("CEL precompiler returned no response");
		}
		const dv = new DataView(wasm.memory.buffer);
		outputLen = dv.getUint32(outputPtr - 4, true);
		const memory = new Uint8Array(wasm.memory.buffer);
		const output = decoder.decode(memory.subarray(outputPtr, outputPtr + outputLen));
		const delimiter = output.indexOf("\n");
		const jsonStr = output.slice(delimiter + 1);
		const parsed = JSON.parse(jsonStr) as CelPrecompileResult;
		if (parsed.valid && parsed.program_id) {
			programSourceCache.set(parsed.program_id, source);
		}
		return parsed;
	} finally {
		if (outputPtr) {
			new Uint8Array(wasm.memory.buffer, outputPtr, outputLen).fill(0);
			wasm.cel_free_cstring(outputPtr);
		}
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).fill(0);
		wasm.cel_free(inputPtr, payloadBytes.byteLength);
	}
}

export function batchPrecompileCel(scripts: PrecompileScript[]): CelBatchPrecompileResult {
	const start = performance.now();
	const wasm = getOrCreateIsolateInstance();
	const payloadBytes = encoder.encode(JSON.stringify({ scripts }));
	const inputPtr = wasm.cel_alloc(payloadBytes.byteLength);
	if (!inputPtr) {
		throw new Error("Unable to allocate CEL request memory");
	}

	let outputPtr = 0;
	let outputLen = 0;
	try {
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).set(payloadBytes);
		outputPtr = wasm.cel_batch_precompile(inputPtr, payloadBytes.byteLength);
		if (!outputPtr) {
			throw new Error("CEL precompiler returned no response");
		}
		const dv = new DataView(wasm.memory.buffer);
		outputLen = dv.getUint32(outputPtr - 4, true);
		const memory = new Uint8Array(wasm.memory.buffer);
		const output = decoder.decode(memory.subarray(outputPtr, outputPtr + outputLen));
		const delimiter = output.indexOf("\n");
		const jsonStr = output.slice(delimiter + 1);
		const parsed = JSON.parse(jsonStr) as CelBatchPrecompileResult;
		parsed.execution_time_us = Math.round((performance.now() - start) * 1000);

		if (parsed.results) {
			for (let i = 0; i < parsed.results.length; i++) {
				const res = parsed.results[i];
				const original = scripts[i];
				if (res.valid && res.program_id && original) {
					programSourceCache.set(res.program_id, original.source);
				}
			}
		}
		return parsed;
	} finally {
		if (outputPtr) {
			new Uint8Array(wasm.memory.buffer, outputPtr, outputLen).fill(0);
			wasm.cel_free_cstring(outputPtr);
		}
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).fill(0);
		wasm.cel_free(inputPtr, payloadBytes.byteLength);
	}
}

export function listPrecompiledCel(): ProgramListResult {
	const wasm = getOrCreateIsolateInstance();
	let outputPtr = 0;
	let outputLen = 0;
	try {
		outputPtr = wasm.cel_list_programs();
		if (!outputPtr) {
			throw new Error("CEL runtime returned no response");
		}
		const dv = new DataView(wasm.memory.buffer);
		outputLen = dv.getUint32(outputPtr - 4, true);
		const memory = new Uint8Array(wasm.memory.buffer);
		const output = decoder.decode(memory.subarray(outputPtr, outputPtr + outputLen));
		const delimiter = output.indexOf("\n");
		const jsonStr = output.slice(delimiter + 1);
		return JSON.parse(jsonStr) as ProgramListResult;
	} finally {
		if (outputPtr) {
			new Uint8Array(wasm.memory.buffer, outputPtr, outputLen).fill(0);
			wasm.cel_free_cstring(outputPtr);
		}
	}
}

export function batchEvaluateCel(
	rules: BatchRule[],
	context: Record<string, unknown> = {},
): CelBatchEvaluationResult {
	const start = performance.now();
	const wasm = getOrCreateIsolateInstance();

	const resolvedRules = rules.map((r) => {
		let source = r.source && r.source.trim().length > 0 ? r.source : undefined;
		if (!source && r.program_id) {
			source = programSourceCache.get(r.program_id);
		}
		return {
			id: r.id,
			source,
			program_id: r.program_id,
		};
	});

	const payloadBytes = encoder.encode(
		JSON.stringify({
			context,
			rules: resolvedRules,
		}),
	);

	const inputPtr = wasm.cel_alloc(payloadBytes.byteLength);
	if (!inputPtr) {
		throw new Error("Unable to allocate CEL request memory");
	}

	let outputPtr = 0;
	let outputLen = 0;
	try {
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).set(payloadBytes);
		outputPtr = wasm.cel_batch_eval_json(inputPtr, payloadBytes.byteLength);
		if (!outputPtr) {
			throw new Error("CEL runtime returned no response");
		}
		const dv = new DataView(wasm.memory.buffer);
		outputLen = dv.getUint32(outputPtr - 4, true);
		const memory = new Uint8Array(wasm.memory.buffer);
		const output = decoder.decode(memory.subarray(outputPtr, outputPtr + outputLen));
		const delimiter = output.indexOf("\n");
		const jsonStr = output.slice(delimiter + 1);
		const parsed = JSON.parse(jsonStr) as CelBatchEvaluationResult;
		const latencyUs = Math.round((performance.now() - start) * 1000);
		parsed.execution_time_us = latencyUs;

		if (parsed.results) {
			for (const res of parsed.results) {
				if (res.success && res.program_id) {
					const original = resolvedRules.find((r) => r.id === res.id);
					if (original?.source) {
						programSourceCache.set(res.program_id, original.source);
					}
				}
			}
		}
		return parsed;
	} finally {
		if (outputPtr) {
			new Uint8Array(wasm.memory.buffer, outputPtr, outputLen).fill(0);
			wasm.cel_free_cstring(outputPtr);
		}
		new Uint8Array(wasm.memory.buffer, inputPtr, payloadBytes.byteLength).fill(0);
		wasm.cel_free(inputPtr, payloadBytes.byteLength);
	}
}

export async function getCelService() {
	return {
		precompiler: {
			precompile: (source: string, id?: string) => precompileCel(source, id),
			batchPrecompile: (scripts: PrecompileScript[]) => batchPrecompileCel(scripts),
			list: () => listPrecompiledCel(),
		},
		runner: {
			eval: (source: string, context: Record<string, unknown> = {}, programId?: string) =>
				evaluateCel(source, context, programId),
			batchEval: (rules: BatchRule[], context: Record<string, unknown> = {}) =>
				batchEvaluateCel(rules, context),
		},
	};
}

let BaseWorkerEntrypoint: any = class {
	constructor(public ctx: any, public env: any) {}
};
try {
	// @ts-ignore
	const cf = await import("cloudflare:workers");
	if (cf?.WorkerEntrypoint) {
		BaseWorkerEntrypoint = cf.WorkerEntrypoint;
	}
} catch {
	// Fallback for non-workerd runtimes
}

export class CelRpcService extends BaseWorkerEntrypoint {
	async evaluate(
		source?: string,
		context: Record<string, unknown> = {},
		programId?: string,
	): Promise<CelEvaluationResult> {
		return evaluateCel(source, context, programId);
	}

	async precompile(source: string, id?: string): Promise<CelPrecompileResult> {
		return precompileCel(source, id);
	}

	async batchPrecompile(scripts: PrecompileScript[]): Promise<CelBatchPrecompileResult> {
		return batchPrecompileCel(scripts);
	}

	async listPrecompiled(): Promise<ProgramListResult> {
		return listPrecompiledCel();
	}

	async batchEvaluate(
		rules: BatchRule[],
		context: Record<string, unknown> = {},
	): Promise<CelBatchEvaluationResult> {
		return batchEvaluateCel(rules, context);
	}
}

const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-headers": "Authorization, Content-Type",
	"access-control-max-age": "86400",
};

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...CORS_HEADERS,
			...extraHeaders,
		},
	});
}

function unauthorizedResponse(): Response {
	return new Response(JSON.stringify({ error: "Unauthorized" }), {
		status: 401,
		headers: {
			"www-authenticate": "Bearer",
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...CORS_HEADERS,
		},
	});
}

async function hasValidBearerToken(request: Request, expectedToken?: string): Promise<boolean> {
	if (!expectedToken) return false;

	const authorization = request.headers.get("authorization");
	const match = authorization?.match(/^Bearer ([^\s]+)$/i);
	if (!match) return false;

	const [expectedDigest, providedDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
		crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
	]);
	const expected = new Uint8Array(expectedDigest);
	const provided = new Uint8Array(providedDigest);
	let difference = 0;
	for (let index = 0; index < expected.length; index++) {
		difference |= expected[index] ^ provided[index];
	}
	return difference === 0;
}

async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength && Number(declaredLength) > MAX_REQUEST_BYTES) return null;
	if (!request.body) return new Uint8Array();

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalLength += value.byteLength;
			if (totalLength > MAX_REQUEST_BYTES) {
				await reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function executeWasmOp(
	wasm: CelExports,
	op: (inputPtr: number, len: number) => number,
	requestBytes: Uint8Array,
	startTimeMs: number,
): Response {
	const inputPointer = wasm.cel_alloc(requestBytes.byteLength);
	if (!inputPointer) {
		return jsonResponse({ error: "Unable to allocate CEL request memory" }, 500);
	}

	let outputPointer = 0;
	let outputLength = 0;
	try {
		new Uint8Array(wasm.memory.buffer, inputPointer, requestBytes.byteLength).set(requestBytes);
		outputPointer = op(inputPointer, requestBytes.byteLength);
		if (!outputPointer) {
			return jsonResponse({ error: "CEL runtime returned no response" }, 500);
		}

		try {
			const dv = new DataView(wasm.memory.buffer);
			outputLength = dv.getUint32(outputPointer - 4, true);
			const memory = new Uint8Array(wasm.memory.buffer);
			const output = decoder.decode(memory.subarray(outputPointer, outputPointer + outputLength));
			const delimiter = output.indexOf("\n");
			const status = Number(output.slice(0, delimiter));
			if (delimiter < 1 || !Number.isInteger(status) || status < 200 || status > 599) {
				return jsonResponse({ error: "CEL runtime returned an invalid response" }, 500);
			}

			const durationMs = (performance.now() - startTimeMs).toFixed(3);
			return new Response(output.slice(delimiter + 1), {
				status,
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"server-timing": `cel;dur=${durationMs}`,
					...CORS_HEADERS,
				},
			});
		} catch {
			return jsonResponse({ error: "CEL runtime returned an unreadable response" }, 500);
		} finally {
			if (outputPointer) {
				new Uint8Array(wasm.memory.buffer, outputPointer, outputLength).fill(0);
				wasm.cel_free_cstring(outputPointer);
			}
		}
	} finally {
		new Uint8Array(wasm.memory.buffer, inputPointer, requestBytes.byteLength).fill(0);
		wasm.cel_free(inputPointer, requestBytes.byteLength);
	}
}

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: CORS_HEADERS,
			});
		}

		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			try {
				const wasm = getOrCreateIsolateInstance();
				if (wasm && wasm.memory) {
					return jsonResponse({ status: "healthy", wasm: "ready" }, 200);
				}
			} catch (err) {
				return jsonResponse({ status: "degraded", wasm: "error", error: String(err) }, 503);
			}
		}

		if (!(await hasValidBearerToken(request, env.API_TOKEN))) {
			return unauthorizedResponse();
		}

		const isEvaluate = url.pathname === "/v1/evaluate";
		const isPrecompile = url.pathname === "/v1/precompile";
		const isBatchEvaluate = url.pathname === "/v1/batch-evaluate";
		const isBatchPrecompile = url.pathname === "/v1/batch-precompile";
		const isProgramsList = url.pathname === "/v1/programs";

		if (!isEvaluate && !isPrecompile && !isBatchEvaluate && !isBatchPrecompile && !isProgramsList) {
			return jsonResponse({ error: "Not found" }, 404);
		}

		if (isProgramsList) {
			if (request.method !== "GET") {
				return new Response(JSON.stringify({ error: "Method not allowed" }), {
					status: 405,
					headers: {
						allow: "GET, OPTIONS",
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
						...CORS_HEADERS,
					},
				});
			}
			const result = listPrecompiledCel();
			return jsonResponse(result, 200);
		}

		if (request.method !== "POST") {
			return new Response(JSON.stringify({ error: "Method not allowed" }), {
				status: 405,
				headers: {
					allow: "POST, OPTIONS",
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					...CORS_HEADERS,
				},
			});
		}
		if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
			return jsonResponse({ error: "Content-Type must be application/json" }, 415);
		}

		let requestBytes = await readLimitedBody(request);
		if (!requestBytes) return jsonResponse({ error: "Request body is too large" }, 413);

		let payload: unknown;
		try {
			payload = JSON.parse(decoder.decode(requestBytes));
		} catch {
			return jsonResponse({ error: "Request body must be valid UTF-8 JSON" }, 400);
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return jsonResponse({ error: "Request body must be a JSON object" }, 400);
		}

		const record = payload as Record<string, unknown>;

		if (isBatchPrecompile) {
			const scripts = record.scripts;
			if (!Array.isArray(scripts) || scripts.length === 0) {
				return jsonResponse({ error: "scripts must be a non-empty array" }, 400);
			}
			if (scripts.length > 200) {
				return jsonResponse({ error: "scripts array exceeds maximum batch limit (200)" }, 400);
			}
			for (const item of scripts as Record<string, unknown>[]) {
				if (!item || typeof item !== "object") {
					return jsonResponse({ error: "Each script must be an object" }, 400);
				}
				if (typeof item.source !== "string" || item.source.trim().length === 0) {
					return jsonResponse({ error: "Each script must have a non-empty string source" }, 400);
				}
				if (item.id !== undefined && (typeof item.id !== "string" || item.id.trim().length === 0)) {
					return jsonResponse({ error: "Optional script id must be a non-empty string" }, 400);
				}
				if (encoder.encode(item.source as string).byteLength > MAX_EXPRESSION_BYTES) {
					return jsonResponse(
						{ error: `Script '${item.id ?? "anonymous"}' expression is too large` },
						413,
					);
				}
			}
			requestBytes = encoder.encode(JSON.stringify(record));
		} else if (isBatchEvaluate) {
			const rules = record.rules;
			if (!Array.isArray(rules) || rules.length === 0) {
				return jsonResponse({ error: "rules must be a non-empty array" }, 400);
			}
			if (rules.length > 200) {
				return jsonResponse({ error: "rules array exceeds maximum batch limit (200)" }, 400);
			}
			if (
				record.context !== undefined &&
				(!record.context || typeof record.context !== "object" || Array.isArray(record.context))
			) {
				return jsonResponse({ error: "context must be a JSON object" }, 400);
			}
			for (const rule of rules as Record<string, unknown>[]) {
				if (!rule || typeof rule !== "object") {
					return jsonResponse({ error: "Each rule must be an object" }, 400);
				}
				if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
					return jsonResponse({ error: "Each rule must have a non-empty string id" }, 400);
				}
				const rSource = typeof rule.source === "string" && rule.source.trim().length > 0;
				const rProgramId = typeof rule.program_id === "string" && rule.program_id.trim().length > 0;
				if (!rSource && !rProgramId) {
					return jsonResponse({ error: `Rule '${rule.id}' must provide either source or program_id` }, 400);
				}
				if (rSource && encoder.encode(rule.source as string).byteLength > MAX_EXPRESSION_BYTES) {
					return jsonResponse({ error: `Rule '${rule.id}' expression is too large` }, 413);
				}
				if (!rSource && rProgramId) {
					const cached = programSourceCache.get(rule.program_id as string);
					if (cached) {
						rule.source = cached;
					}
				}
			}
			requestBytes = encoder.encode(JSON.stringify(record));
		} else {
			const hasSource = typeof record.source === "string" && record.source.trim().length > 0;
			const hasProgramId = typeof record.program_id === "string" && record.program_id.trim().length > 0;

			if (isPrecompile && !hasSource) {
				return jsonResponse({ error: "source must be a non-empty CEL expression" }, 400);
			}
			if (
				isPrecompile &&
				record.id !== undefined &&
				(typeof record.id !== "string" || record.id.trim().length === 0)
			) {
				return jsonResponse({ error: "Optional id must be a non-empty string" }, 400);
			}
			if (isEvaluate && !hasSource && !hasProgramId) {
				return jsonResponse({ error: "Either source or program_id must be provided" }, 400);
			}
			if (hasSource && encoder.encode(record.source as string).byteLength > MAX_EXPRESSION_BYTES) {
				return jsonResponse({ error: "CEL expression is too large" }, 413);
			}
			if (
				isEvaluate &&
				record.context !== undefined &&
				(!record.context || typeof record.context !== "object" || Array.isArray(record.context))
			) {
				return jsonResponse({ error: "context must be a JSON object" }, 400);
			}

			if (isEvaluate && !hasSource && hasProgramId) {
				const cachedSource = programSourceCache.get(record.program_id as string);
				if (cachedSource) {
					record.source = cachedSource;
					requestBytes = encoder.encode(JSON.stringify(record));
				}
			}
		}

		const startTime = performance.now();
		try {
			const wasm = getOrCreateIsolateInstance();
			const response = executeWasmOp(
				wasm,
				isEvaluate
					? (p, l) => wasm.cel_eval_json(p, l)
					: isPrecompile
					? (p, l) => wasm.cel_precompile(p, l)
					: isBatchEvaluate
					? (p, l) => wasm.cel_batch_eval_json(p, l)
					: (p, l) => wasm.cel_batch_precompile(p, l),
				requestBytes,
				startTime,
			);
			return response;
		} catch {
			return jsonResponse({ error: "CEL runtime failed to evaluate the expression" }, 500);
		}
	},
} satisfies ExportedHandler<WorkerEnv>;
