type EvaluationRequest = {
	source: string;
	context: Record<string, unknown>;
};

type CurlResponse = {
	status: number;
	body: string;
};

const baseUrl = (Bun.env.CEL_WORKER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const endpoint = `${baseUrl}/v1/evaluate`;

function parseDevToken(contents: string): string | undefined {
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*API_TOKEN\s*=\s*(.*?)\s*$/);
		if (!match) continue;

		const value = match[1];
		if (value.startsWith('"') && value.endsWith('"')) {
			try {
				return JSON.parse(value) as string;
			} catch {
				return undefined;
			}
		}
		if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
		return value;
	}
	return undefined;
}

async function getApiToken(): Promise<string> {
	if (Bun.env.API_TOKEN) return Bun.env.API_TOKEN;
	const devVars = Bun.file(new URL("../.dev.vars", import.meta.url));
	if (await devVars.exists()) {
		const token = parseDevToken(await devVars.text());
		if (token) return token;
	}
	throw new Error("Set API_TOKEN or add it to n-cel/.dev.vars before running the curl tests.");
}

async function curlPost(body: EvaluationRequest, token?: string): Promise<CurlResponse> {
	const args = [
		"curl",
		"--silent",
		"--show-error",
		"--max-time",
		"20",
		"--write-out",
		"\n%{http_code}",
	];
	if (token) args.push("--config", "-");
	args.push(
		"--request",
		"POST",
		"--header",
		"Content-Type: application/json",
		"--data-binary",
		JSON.stringify(body),
		"--url",
		endpoint,
	);

	const child = Bun.spawn(args, {
		stdin: token ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (token) {
		const header = JSON.stringify(`Authorization: Bearer ${token}`);
		child.stdin.write(`header = ${header}\n`);
		child.stdin.end();
	}

	const [output, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`curl failed (${exitCode}): ${stderr.trim()}`);

	const separator = output.lastIndexOf("\n");
	if (separator < 0) throw new Error("curl did not return an HTTP status code");
	const status = Number(output.slice(separator + 1).trim());
	if (!Number.isInteger(status)) throw new Error("curl returned an invalid HTTP status code");
	return { status, body: output.slice(0, separator) };
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function parseJson(body: string, name: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(body);
		assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `${name}: expected a JSON object`);
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`${name}: invalid JSON response (${String(error)})`);
	}
}

const token = await getApiToken();
const checks: Array<{
	name: string;
	body: EvaluationRequest;
	expectedStatus: number;
	assertBody: (value: Record<string, unknown>) => void;
}> = [
	{
		name: "nested fields, startsWith, all, and size",
		body: {
			source:
				"user.age >= threshold && user.name.startsWith('A') && user.roles.all(r, size(r) > 0) && user.address.city == 'San Francisco'",
			context: {
				user: {
					name: "Alice",
					age: 28,
					roles: ["admin", "editor"],
					address: { city: "San Francisco", zip: "94105" },
				},
				threshold: 21,
			},
		},
		expectedStatus: 200,
		assertBody: (value) =>
			assert(value.success === true && value.value === true && value.value_type === "bool", "expected true bool result"),
	},
	{
		name: "CEL arithmetic precedence",
		body: { source: "10 + 20 * 2", context: {} },
		expectedStatus: 200,
		assertBody: (value) =>
			assert(value.success === true && value.value === 50 && value.value_type === "int", "expected integer result 50"),
	},
	{
		name: "CEL conditional expression",
		body: {
			source: "user.tier == 'gold' ? 'premium_support' : 'standard_support'",
			context: { user: { tier: "gold" } },
		},
		expectedStatus: 200,
		assertBody: (value) =>
			assert(
				value.success === true && value.value === "premium_support" && value.value_type === "string",
				"expected premium_support string result",
			),
	},
	{
		name: "invalid CEL syntax",
		body: { source: "user.age >=", context: { user: { age: 28 } } },
		expectedStatus: 422,
		assertBody: (value) =>
			assert(value.success === false && value.error_code === "COMPILATION_ERROR", "expected CEL compilation error"),
	},
];

for (const check of checks) {
	const response = await curlPost(check.body, token);
	assert(response.status === check.expectedStatus, `${check.name}: expected HTTP ${check.expectedStatus}, got ${response.status}`);
	check.assertBody(parseJson(response.body, check.name));
	console.log(`PASS ${check.name}`);
}

const unauthorized = await curlPost({ source: "1 + 1", context: {} });
assert(unauthorized.status === 401, `missing bearer token: expected HTTP 401, got ${unauthorized.status}`);
assert(
	unauthorized.body.includes('"error":"Unauthorized"'),
	"missing bearer token: expected an Unauthorized response",
);
console.log("PASS bearer-token enforcement");
console.log(`All ${checks.length + 1} curl checks passed against ${endpoint}`);
