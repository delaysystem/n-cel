import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { evaluateCel, getCelService, precompileCel } from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const testToken = "n-cel-vitest-only-token";
const testEnv = { API_TOKEN: testToken } as unknown as Env;

async function evaluate(payload: Record<string, unknown>) {
	const request = new IncomingRequest("https://n-cel.test/v1/evaluate", {
		method: "POST",
		headers: {
			authorization: `Bearer ${testToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
	});
	const response = await worker.fetch(request, testEnv, createExecutionContext());
	return { response, body: (await response.json()) as Record<string, unknown> };
}

async function precompile(source: string) {
	const request = new IncomingRequest("https://n-cel.test/v1/precompile", {
		method: "POST",
		headers: {
			authorization: `Bearer ${testToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ source }),
	});
	const response = await worker.fetch(request, testEnv, createExecutionContext());
	return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("CEL evaluation Worker", () => {
	it("evaluates nested JSON, string functions, and the all macro", async () => {
		const { response, body } = await evaluate({
			source: "user.age >= threshold && user.name.startsWith('A') && user.roles.all(r, size(r) > 0) && user.address.city == 'San Francisco'",
			context: {
				user: {
					name: "Alice",
					age: 28,
					roles: ["admin", "editor"],
					address: { city: "San Francisco", zip: "94105" },
				},
				threshold: 21,
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("server-timing")).toContain("cel;dur=");
		expect(body).toMatchObject({ success: true, value: true, value_type: "bool" });
		expect(typeof body.program_id).toBe("string");
	});

	it("evaluates CEL arithmetic and conditional expressions", async () => {
		const { response: arithmeticResponse, body: arithmeticBody } = await evaluate({
			source: "10 + 20 * 2",
			context: {},
		});
		expect(arithmeticResponse.status).toBe(200);
		expect(arithmeticBody).toMatchObject({ success: true, value: 50, value_type: "int" });

		const { response: conditionalResponse, body: conditionalBody } = await evaluate({
			source: "user.tier == 'gold' ? 'premium_support' : 'standard_support'",
			context: { user: { tier: "gold" } },
		});
		expect(conditionalResponse.status).toBe(200);
		expect(conditionalBody).toMatchObject({
			success: true,
			value: "premium_support",
			value_type: "string",
		});
	});

	it("returns a client error for invalid CEL syntax without crashing", async () => {
		const { response, body } = await evaluate({
			source: "user.age >=",
			context: { user: { age: 28 } },
		});
		expect(response.status).toBe(422);
		expect(body).toMatchObject({ success: false, error_code: "COMPILATION_ERROR" });
	});

	it("rejects pathological exponential nested comprehensions", async () => {
		const deep = "[1].all(a, [1].all(b, [1].all(c, [1].all(d, a+b+c+d > 0))))";
		const { response, body } = await evaluate({ source: deep, context: {} });
		expect(response.status).toBe(422);
		expect(body).toMatchObject({ success: false, error_code: "COMPLEXITY_EXCEEDED" });
	});

	it("supports evaluating via precompiled program_id with zero compilation overhead", async () => {
		const pre = await precompile("user.score > 100 && user.tier == 'platinum'");
		expect(pre.response.status).toBe(200);
		const programId = pre.body.program_id as string;
		expect(programId).toBeDefined();

		// Call evaluate using program_id without sending source
		const { response, body } = await evaluate({
			program_id: programId,
			context: { user: { score: 150, tier: "platinum" } },
		});
		expect(response.status).toBe(200);
		expect(body).toMatchObject({ success: true, value: true, value_type: "bool" });
	});

	it("supports CORS preflight OPTIONS requests", async () => {
		const request = new IncomingRequest("https://n-cel.test/v1/evaluate", {
			method: "OPTIONS",
		});
		const response = await worker.fetch(request, testEnv, createExecutionContext());
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("access-control-allow-methods")).toContain("POST");
	});

	it("requires the API bearer token", async () => {
		const request = new IncomingRequest("https://n-cel.test/v1/evaluate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "1 + 1", context: {} }),
		});
		const response = await worker.fetch(request, testEnv, createExecutionContext());

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe("Bearer");
	});

	it("handles library imports and in-isolate getCelService execution", async () => {
		const res = evaluateCel("x * 2 + y", { x: 5, y: 10 });
		expect(res.success).toBe(true);
		expect(res.value).toBe(20);
		expect(res.value_type).toBe("int");
		expect(typeof res.execution_time_us).toBe("number");
		expect(typeof res.program_id).toBe("string");

		// Evaluate using cached program_id
		const cachedRes = evaluateCel(undefined, { x: 10, y: 5 }, res.program_id);
		expect(cachedRes.success).toBe(true);
		expect(cachedRes.value).toBe(25);

		const pre = precompileCel("x == true");
		expect(pre.valid).toBe(true);

		const service = await getCelService();
		const sPre = service.precompiler.precompile("foo != 'bar'");
		expect(sPre.valid).toBe(true);

		const sEval = service.runner.eval("foo != 'bar'", { foo: "baz" });
		expect(sEval.success).toBe(true);
		expect(sEval.value).toBe(true);
	});

	it("responds to unauthenticated GET /health probe", async () => {
		const request = new IncomingRequest("https://n-cel.test/health", {
			method: "GET",
		});
		const response = await worker.fetch(request, testEnv, createExecutionContext());
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({ status: "healthy", wasm: "ready" });
	});

	it("evaluates regex extension functions (matches, regex_replace, regex_find)", async () => {
		// 1. matches free function and receiver syntax
		const { body: matchFree } = await evaluate({
			source: "matches(email, r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$')",
			context: { email: "agent@salesforce.com" },
		});
		expect(matchFree).toMatchObject({ success: true, value: true, value_type: "bool" });

		const { body: matchReceiver } = await evaluate({
			source: "email.matches(r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$')",
			context: { email: "agent@salesforce.com" },
		});
		expect(matchReceiver).toMatchObject({ success: true, value: true, value_type: "bool" });

		// 2. regex_replace
		const { body: replaceRes } = await evaluate({
			source: "regex_replace(phone, r'\\D', '')",
			context: { phone: "+1 (555) 234-5678" },
		});
		expect(replaceRes).toMatchObject({ success: true, value: "15552345678", value_type: "string" });

		// 3. regex_find
		const { body: findRes } = await evaluate({
			source: "regex_find(log, r'REQ-[0-9]{5}')",
			context: { log: "Timestamp 2026-10-03 trace REQ-98765 finished in 2ms" },
		});
		expect(findRes).toMatchObject({ success: true, value: "REQ-98765", value_type: "string" });
	});

	it("evaluates domain and formula helpers (isBlank, isNotBlank, lower, upper, coalesce)", async () => {
		const { body } = await evaluate({
			source: "isBlank(empty_str) && isNotBlank(full_str) && lower(mixed) == 'hello' && upper(mixed) == 'HELLO' && coalesce(null_val, 'fallback') == 'fallback'",
			context: {
				empty_str: "   ",
				full_str: "active",
				mixed: "Hello",
				null_val: null,
			},
		});
		expect(body).toMatchObject({ success: true, value: true, value_type: "bool" });
	});

	it("supports batch evaluation via POST /v1/batch-evaluate", async () => {
		const request = new IncomingRequest("https://n-cel.test/v1/batch-evaluate", {
			method: "POST",
			headers: {
				authorization: `Bearer ${testToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context: {
					record: { status: "Closed - Won", amount: 150000, region: "US-West" },
					tier_threshold: 100000,
				},
				rules: [
					{ id: "high_value", source: "record.amount >= tier_threshold" },
					{ id: "is_won", source: "record.status == 'Closed - Won'" },
					{ id: "is_emea", source: "record.region == 'EMEA'" },
					{ id: "invalid_syntax", source: "record.amount >=" },
				],
			}),
		});
		const response = await worker.fetch(request, testEnv, createExecutionContext());
		expect(response.status).toBe(200);
		expect(response.headers.get("server-timing")).toContain("cel;dur=");
		const body = (await response.json()) as {
			success: boolean;
			total_evaluated: number;
			total_failed: number;
			results: Array<{ id: string; success: boolean; value: unknown; error_code?: string }>;
		};
		expect(body.success).toBe(false); // False because total_failed > 0
		expect(body.total_evaluated).toBe(4);
		expect(body.total_failed).toBe(1);

		const resMap = new Map(body.results.map((r) => [r.id, r]));
		expect(resMap.get("high_value")).toMatchObject({ success: true, value: true });
		expect(resMap.get("is_won")).toMatchObject({ success: true, value: true });
		expect(resMap.get("is_emea")).toMatchObject({ success: true, value: false });
		expect(resMap.get("invalid_syntax")).toMatchObject({ success: false, error_code: "COMPILATION_ERROR" });
	});

	it("supports in-isolate batchEvaluateCel and CelRpcService", async () => {
		const { CelRpcService, batchEvaluateCel } = await import("../src/index");

		const batchRes = batchEvaluateCel(
			[
				{ id: "r1", source: "x + y == 30" },
				{ id: "r2", source: "x * y == 200" },
			],
			{ x: 10, y: 20 },
		);
		expect(batchRes.success).toBe(true);
		expect(batchRes.total_evaluated).toBe(2);
		expect(batchRes.results[0].value).toBe(true);
		expect(batchRes.results[1].value).toBe(true);

		const rpc = new CelRpcService({} as any, testEnv);
		const evalRes = await rpc.evaluate("10 + 5");
		expect(evalRes.success).toBe(true);
		expect(evalRes.value).toBe(15);

		const preRes = await rpc.precompile("a > b");
		expect(preRes.valid).toBe(true);

		const rpcBatch = await rpc.batchEvaluate([{ id: "rpc1", source: "status == 'ok'" }], { status: "ok" });
		expect(rpcBatch.success).toBe(true);
		expect(rpcBatch.results[0].value).toBe(true);
	});

	it("supports custom alias IDs and AST reference extraction during precompilation", async () => {
		const { precompileCel, evaluateCel } = await import("../src/index");

		const res = precompileCel(
			"user.role == 'admin' && size(user.tags) > 0 && account.annualRevenue >= threshold",
			"auth.admin_policy",
		);

		expect(res.valid).toBe(true);
		expect(res.program_id).toBe("auth.admin_policy");
		expect(res.complexity).toBeGreaterThan(0);
		expect(res.variables).toContain("user");
		expect(res.variables).toContain("account");
		expect(res.variables).toContain("threshold");
		expect(res.functions).toContain("size");

		// Execute using the custom program_id with 0 compilation overhead
		const evalRes = evaluateCel(
			undefined,
			{
				user: { role: "admin", tags: ["superuser"] },
				account: { annualRevenue: 2000000 },
				threshold: 1000000,
			},
			"auth.admin_policy",
		);
		expect(evalRes.success).toBe(true);
		expect(evalRes.value).toBe(true);
	});

	it("supports batch precompilation via POST /v1/batch-precompile and inventory via GET /v1/programs", async () => {
		// 1. Batch precompile multiple scripts in one HTTP request
		const request = new IncomingRequest("https://n-cel.test/v1/batch-precompile", {
			method: "POST",
			headers: {
				authorization: `Bearer ${testToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				scripts: [
					{ id: "policy.senior_rep", source: "user.role == 'Senior Sales Rep'" },
					{ id: "policy.high_amount", source: "opportunity.amount >= 500000" },
					{ source: "account.sla == 'Platinum'" },
				],
			}),
		});
		const response = await worker.fetch(request, testEnv, createExecutionContext());
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			total_compiled: number;
			total_failed: number;
			results: Array<{ valid: boolean; program_id: string; variables?: string[] }>;
		};
		expect(body.success).toBe(true);
		expect(body.total_compiled).toBe(3);
		expect(body.total_failed).toBe(0);
		expect(body.results[0].program_id).toBe("policy.senior_rep");
		expect(body.results[0].variables).toContain("user");
		expect(body.results[1].program_id).toBe("policy.high_amount");
		expect(body.results[1].variables).toContain("opportunity");
		expect(body.results[2].program_id).toMatch(/^cel_prog_/);

		// 2. Evaluate using precompiled ID in batch-evaluate
		const evalBatchReq = new IncomingRequest("https://n-cel.test/v1/batch-evaluate", {
			method: "POST",
			headers: {
				authorization: `Bearer ${testToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context: {
					user: { role: "Senior Sales Rep" },
					opportunity: { amount: 750000 },
				},
				rules: [
					{ id: "check_rep", program_id: "policy.senior_rep" },
					{ id: "check_amount", program_id: "policy.high_amount" },
				],
			}),
		});
		const evalBatchResp = await worker.fetch(evalBatchReq, testEnv, createExecutionContext());
		expect(evalBatchResp.status).toBe(200);
		const evalBatchBody = (await evalBatchResp.json()) as {
			success: boolean;
			results: Array<{ id: string; success: boolean; value: unknown }>;
		};
		expect(evalBatchBody.success).toBe(true);
		expect(evalBatchBody.results[0].value).toBe(true);
		expect(evalBatchBody.results[1].value).toBe(true);

		// 3. Inspect program inventory via GET /v1/programs
		const listReq = new IncomingRequest("https://n-cel.test/v1/programs", {
			method: "GET",
			headers: {
				authorization: `Bearer ${testToken}`,
			},
		});
		const listResp = await worker.fetch(listReq, testEnv, createExecutionContext());
		expect(listResp.status).toBe(200);
		const listBody = (await listResp.json()) as {
			count: number;
			programs: Array<{ id: string; variables: string[] }>;
		};
		expect(listBody.count).toBeGreaterThanOrEqual(3);
		const progIds = listBody.programs.map((p) => p.id);
		expect(progIds).toContain("policy.senior_rep");
		expect(progIds).toContain("policy.high_amount");
	});
});
