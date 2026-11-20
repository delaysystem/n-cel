import {
	evaluateCel,
	batchEvaluateCel,
	precompileCel,
	batchPrecompileCel,
	listPrecompiledCel,
	BatchRule,
	PrecompileScript,
} from "../src/index";

function runBenchmark() {
	console.log("================================================================");
	console.log("             n-cel High-Performance WASM Engine Benchmark        ");
	console.log("================================================================\n");

	const ITERATIONS = 1000;

	// -------------------------------------------------------------------------
	// 1. Cold Compile vs Warm AST vs Precompiled Custom Alias ID
	// -------------------------------------------------------------------------
	console.log(`[1] Compilation & AST Cache Latency (${ITERATIONS} iterations):`);

	// Cold evaluation (unique expressions to bypass in-isolate cache)
	let coldTotalUs = 0;
	for (let i = 0; i < 100; i++) {
		const expr = `amount > ${1000 + i} && status == 'active'`;
		const res = evaluateCel(expr, { amount: 1500, status: "active" });
		coldTotalUs += res.execution_time_us || 0;
	}
	const avgColdUs = coldTotalUs / 100;

	// Warm AST cache (same expression repeatedly)
	const warmExpr = "user.score >= 100 && user.verified == true";
	// Prime the cache
	evaluateCel(warmExpr, { user: { score: 120, verified: true } });
	let warmTotalUs = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const res = evaluateCel(warmExpr, { user: { score: 120, verified: true } });
		warmTotalUs += res.execution_time_us || 0;
	}
	const avgWarmUs = warmTotalUs / ITERATIONS;

	// Precompiled custom alias evaluation (zero parse, zero compile overhead)
	const precomp = precompileCel("user.score >= 100 && user.verified == true", "user.tier_gate");
	const programId = precomp.program_id!;
	let progIdTotalUs = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const res = evaluateCel(undefined, { user: { score: 120, verified: true } }, programId);
		progIdTotalUs += res.execution_time_us || 0;
	}
	const avgProgIdUs = progIdTotalUs / ITERATIONS;

	console.log(`  - Cold Parse & Compile:        ${avgColdUs.toFixed(1)} µs / eval`);
	console.log(`  - Warm In-Isolate AST Cache:    ${avgWarmUs.toFixed(1)} µs / eval  (${((1 - avgWarmUs / avgColdUs) * 100).toFixed(1)}% faster)`);
	console.log(`  - Precompiled Alias (program_id): ${avgProgIdUs.toFixed(1)} µs / eval  (${((1 - avgProgIdUs / avgColdUs) * 100).toFixed(1)}% faster, ${(avgColdUs / avgProgIdUs).toFixed(1)}x CPU throughput)\n`);

	// -------------------------------------------------------------------------
	// 2. Batch Precompilation Throughput (Precompiling Scripts Ahead-of-Time)
	// -------------------------------------------------------------------------
	console.log("[2] Ahead-Of-Time Script Precompilation (50 Policy Scripts):");

	const policyTemplates = [
		"opportunity.amount <= user.approvalLimit || user.role == 'Senior Sales Rep'",
		"account.type == 'Enterprise' && account.sla == 'Platinum'",
		"opportunity.discountPct <= 20 && opportunity.probability >= 50",
		"user.isActive && account.billingCountry == 'USA'",
		"opportunity.amount > 50000 && account.annualRevenue >= 1000000",
	];

	const scriptsToPrecompile: PrecompileScript[] = [];
	for (let i = 0; i < 50; i++) {
		scriptsToPrecompile.push({
			id: `policy.rule_${i}`,
			source: policyTemplates[i % policyTemplates.length],
		});
	}

	// Sequential precompilation
	const tPreSeqStart = performance.now();
	for (const s of scriptsToPrecompile) {
		precompileCel(s.source, s.id);
	}
	const preSeqTimeMs = performance.now() - tPreSeqStart;

	// Batch precompilation
	const tPreBatchStart = performance.now();
	const batchPrecompRes = batchPrecompileCel(scriptsToPrecompile);
	const preBatchTimeMs = performance.now() - tPreBatchStart;

	console.log(`  - Sequential Individual Precompile: ${preSeqTimeMs.toFixed(3)} ms total (${(preSeqTimeMs / 50).toFixed(3)} ms/script)`);
	console.log(`  - Batch AOT Precompile (50 scripts): ${preBatchTimeMs.toFixed(3)} ms total (${(preBatchTimeMs / 50).toFixed(3)} ms/script)`);
	console.log(`  - Speedup:                          ${(preSeqTimeMs / preBatchTimeMs).toFixed(2)}x faster precompilation`);
	console.log(`  - Registered Programs in Inventory: ${listPrecompiledCel().count} programs active\n`);

	// -------------------------------------------------------------------------
	// 3. Multi-Gate Rule Evaluation: Raw Sources vs Precompiled Pinned IDs
	// -------------------------------------------------------------------------
	const ruleCounts = [5, 10, 25, 50];
	console.log("[3] Multi-Gate Rule Evaluation: Individual vs Batch (Raw vs Precompiled):");

	const context = {
		account: {
			id: "001xx000003DGSWAA4",
			type: "Enterprise",
			annualRevenue: 5000000,
			sla: "Platinum",
			industry: "Technology",
			billingCountry: "USA",
		},
		opportunity: {
			id: "006xx000001ABC123",
			amount: 150000,
			stageName: "Proposal/Price Quote",
			probability: 75,
			hasDiscount: true,
			discountPct: 15,
		},
		user: {
			id: "005xx000001XYZ987",
			role: "Senior Sales Rep",
			approvalLimit: 100000,
			isActive: true,
			email: "rep@company.com",
		},
		order: {
			total: 75000,
		},
	};

	for (const count of ruleCounts) {
		const rawRules: BatchRule[] = [];
		const precompiledRules: BatchRule[] = [];

		for (let i = 0; i < count; i++) {
			const ruleId = `policy.rule_${i}`;
			precompiledRules.push({ id: ruleId, program_id: ruleId });
			rawRules.push({ id: `rule_${i}`, source: policyTemplates[i % policyTemplates.length] });
		}

		// Warmup
		batchEvaluateCel(rawRules, context);
		batchEvaluateCel(precompiledRules, context);

		const BATCH_ROUNDS = 50;
		// Individual sequential evaluations
		const t0 = performance.now();
		let totalSingleUs = 0;
		for (let r = 0; r < BATCH_ROUNDS; r++) {
			for (const item of rawRules) {
				const res = evaluateCel(item.source, context);
				totalSingleUs += res.execution_time_us || 0;
			}
		}
		const singleWallMs = (performance.now() - t0) / BATCH_ROUNDS;
		const avgSingleUs = totalSingleUs / (BATCH_ROUNDS * count);

		// Single batch evaluation (raw sources)
		const t1 = performance.now();
		let totalBatchRawUs = 0;
		for (let r = 0; r < BATCH_ROUNDS; r++) {
			const res = batchEvaluateCel(rawRules, context);
			totalBatchRawUs += res.execution_time_us || 0;
		}
		const batchWallMs = (performance.now() - t1) / BATCH_ROUNDS;
		const avgBatchRawUs = totalBatchRawUs / (BATCH_ROUNDS * count);

		// Single batch evaluation (PRECOMPILED program_ids)
		const t2 = performance.now();
		let totalBatchPreUs = 0;
		for (let r = 0; r < BATCH_ROUNDS; r++) {
			const res = batchEvaluateCel(precompiledRules, context);
			totalBatchPreUs += res.execution_time_us || 0;
		}
		const precompiledBatchWallMs = (performance.now() - t2) / BATCH_ROUNDS;
		const avgBatchPreUs = totalBatchPreUs / (BATCH_ROUNDS * count);

		const speedup = (singleWallMs / precompiledBatchWallMs).toFixed(2);
		console.log(`  - ${count} Rules:`);
		console.log(`      * Individual Calls (Raw):         ${singleWallMs.toFixed(3)} ms total (${avgSingleUs.toFixed(1)} µs/rule)`);
		console.log(`      * Batch Gate (Raw Sources):       ${batchWallMs.toFixed(3)} ms total (${avgBatchRawUs.toFixed(1)} µs/rule)`);
		console.log(`      * Batch Gate (Precompiled IDs):   ${precompiledBatchWallMs.toFixed(3)} ms total (${avgBatchPreUs.toFixed(1)} µs/rule)`);
		console.log(`      * Precompiled Batch Speedup vs Individual: ${speedup}x faster\n`);
	}

	// -------------------------------------------------------------------------
	// 4. Native Regex Operations
	// -------------------------------------------------------------------------
	console.log(`[4] Native Regex Operations (${ITERATIONS} iterations):`);

	// A. matches()
	const emailContext = { email: "marcus.vance@enterprise-cloud.co.uk" };
	const matchSource = "matches(email, r'^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+$')";
	evaluateCel(matchSource, emailContext);
	let matchTotalUs = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const res = evaluateCel(matchSource, emailContext);
		matchTotalUs += res.execution_time_us || 0;
	}
	console.log(`  - matches(email, regex):        ${(matchTotalUs / ITERATIONS).toFixed(1)} µs / eval`);

	// B. regex_replace()
	const phoneContext = { phone: "+1 (800) 555-0199 ext. 420" };
	const replaceSource = "regex_replace(phone, r'[^0-9]', '')";
	evaluateCel(replaceSource, phoneContext);
	let replaceTotalUs = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const res = evaluateCel(replaceSource, phoneContext);
		replaceTotalUs += res.execution_time_us || 0;
	}
	console.log(`  - regex_replace(phone, regex):  ${(replaceTotalUs / ITERATIONS).toFixed(1)} µs / eval`);

	// C. regex_find()
	const logContext = { message: "2026-10-03T16:00:00Z WARN worker [trace=TRACE-884920] payment rejected" };
	const findSource = "regex_find(message, r'TRACE-[0-9]+')";
	evaluateCel(findSource, logContext);
	let findTotalUs = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const res = evaluateCel(findSource, logContext);
		findTotalUs += res.execution_time_us || 0;
	}
	console.log(`  - regex_find(message, regex):   ${(findTotalUs / ITERATIONS).toFixed(1)} µs / eval\n`);

	// -------------------------------------------------------------------------
	// 5. Domain & Formula Helpers
	// -------------------------------------------------------------------------
	console.log(`[5] Domain & Formula Helpers Chaining (${ITERATIONS} iterations):`);

	const helperContext = {
		raw_email: "  CONTACT@DOMAIN.COM  ",
		fallback_name: null,
		tags: ["salesforce", "enterprise", "vip"],
	};
	const helperSource = "isNotBlank(raw_email) && lower(raw_email.trim()) == 'contact@domain.com' && coalesce(fallback_name, 'Guest') == 'Guest' && !isBlank(tags)";
	evaluateCel(helperSource, helperContext);
	let helperTotalUs = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const res = evaluateCel(helperSource, helperContext);
		helperTotalUs += res.execution_time_us || 0;
	}
	console.log(`  - Chained Helpers (isBlank/isNotBlank/lower/coalesce): ${(helperTotalUs / ITERATIONS).toFixed(1)} µs / eval\n`);

	console.log("================================================================");
	console.log("                     Benchmark Complete                         ");
	console.log("================================================================");
}

runBenchmark();
