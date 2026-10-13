# n-cel

`n-cel` is a stateless Cloudflare Worker that evaluates Google CEL expressions with the Rust `cel-interpreter` crate compiled to WebAssembly. Each call parses/compiles the submitted expression and evaluates it against the supplied JSON context.

## API

`POST /v1/evaluate` requires a bearer token and an `application/json` body:

```json
{
  "source": "user.age >= 18 && user.active",
  "context": {
    "user": {
      "age": 24,
      "active": true
    }
  }
}
```

Successful responses include `success`, `value`, and `value_type`. Invalid expressions and evaluation errors return an error response with `success: false`.

For the example above, a successful response is:

```json
{
  "success": true,
  "value": true,
  "value_type": "bool"
}
```

Call it locally after setting the secret in `.dev.vars`:

```sh
curl http://localhost:8787/v1/evaluate \
  -H "Authorization: Bearer <local secret>" \
  -H "Content-Type: application/json" \
  --data '{"source":"user.age >= 18 && user.active","context":{"user":{"age":24,"active":true}}}'
```

The worker reads its API credential from the `API_TOKEN` secret. For local development, put `API_TOKEN=<a local secret>` in `.dev.vars`. Set a deployed secret with:

```sh
bunx wrangler secret put API_TOKEN
```

Unknown paths return `404`; unsupported methods return `405`. Request bodies are limited to 16 KiB and expressions to 4 KiB. Request context and expression contents are not logged or persisted.

## Build and run

Install the Rust `wasm32-unknown-unknown` target once, then use Bun scripts to build the WebAssembly module and start/deploy the Worker:

```sh
rustup target add wasm32-unknown-unknown
bun run dev
bun run deploy
```

The build writes `src/cel_engine.wasm`, which is committed so Wrangler can bundle the worker from a clean checkout; the build script regenerates it from `wasm/` before development or deployment.

## Tests

The Vitest suite exercises the Worker with real CEL expressions and the compiled Rust/WASM evaluator. For HTTP-level curl checks, start `bun run dev` in one terminal with `API_TOKEN` configured in `.dev.vars`, then run `bun run test:curl` in another terminal. The curl script reads `API_TOKEN` from the process environment or `.dev.vars`; set `CEL_WORKER_URL` to target another running Worker.
