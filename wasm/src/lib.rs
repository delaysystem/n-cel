use cel::objects::{Key, Map};
use cel::{Context, Program, Value};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::alloc::{alloc, dealloc, Layout};
use std::collections::HashMap;
use std::slice;
use std::sync::{Arc, Mutex, OnceLock};

const ERROR_FALLBACK: &str = "{\"success\":false,\"value\":null,\"value_type\":\"error\",\"error_code\":\"INTERNAL_ERROR\",\"error\":\"Unable to serialize CEL response\"}";
const MAX_DYNAMIC_CACHE: usize = 2048;

#[derive(Clone)]
struct PinnedEntry {
    program: Arc<Program>,
    source: String,
    complexity: usize,
    variables: Vec<String>,
    functions: Vec<String>,
}

static PINNED_SCRIPTS: OnceLock<Mutex<HashMap<String, PinnedEntry>>> = OnceLock::new();
static DYNAMIC_CACHE: OnceLock<Mutex<HashMap<String, Arc<Program>>>> = OnceLock::new();

fn get_pinned() -> &'static Mutex<HashMap<String, PinnedEntry>> {
    PINNED_SCRIPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_dynamic() -> &'static Mutex<HashMap<String, Arc<Program>>> {
    DYNAMIC_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Deserialize)]
struct EvalRequest {
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    program_id: Option<String>,
    #[serde(default = "empty_object")]
    context: JsonValue,
}

fn empty_object() -> JsonValue {
    JsonValue::Object(JsonMap::new())
}

#[derive(Serialize)]
struct EvalResponse {
    success: bool,
    value: JsonValue,
    value_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    program_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl EvalResponse {
    fn error(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            success: false,
            value: JsonValue::Null,
            value_type: "error",
            program_id: None,
            error_code: Some(code),
            error: Some(message.into()),
        }
    }
}

fn fnv1a_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

fn check_expression_complexity(source: &str) -> Result<(), &'static str> {
    if source.len() > 4096 {
        return Err("CEL expression exceeds maximum length (4096 bytes)");
    }

    const MACROS: &[&str] = &[".all(", ".exists(", ".exists_one(", ".map(", ".filter("];
    let mut total_macros = 0;
    let mut max_nesting = 0;
    let mut current_nesting = 0;

    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'.' {
            let rem = &source[i..];
            for m in MACROS {
                if rem.starts_with(m) {
                    total_macros += 1;
                    current_nesting += 1;
                    if current_nesting > max_nesting {
                        max_nesting = current_nesting;
                    }
                    i += m.len() - 1;
                    break;
                }
            }
        } else if bytes[i] == b')' {
            if current_nesting > 0 {
                current_nesting -= 1;
            }
        }
        i += 1;
    }

    if max_nesting > 3 {
        return Err("CEL expression exceeds maximum comprehension nesting depth (max 3)");
    }
    if total_macros > 12 {
        return Err("CEL expression exceeds maximum macro count (max 12)");
    }

    Ok(())
}

fn get_or_compile_program(
    source_opt: Option<&str>,
    program_id_opt: Option<&str>,
) -> Result<(Arc<Program>, String), (u16, EvalResponse)> {
    if let Some(pid) = program_id_opt {
        if let Ok(pinned) = get_pinned().lock() {
            if let Some(entry) = pinned.get(pid) {
                return Ok((Arc::clone(&entry.program), pid.to_string()));
            }
        }
        if let Ok(dynamic) = get_dynamic().lock() {
            if let Some(prog) = dynamic.get(pid) {
                return Ok((Arc::clone(prog), pid.to_string()));
            }
        }
    }

    let source = match source_opt {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => {
            return Err((
                400,
                EvalResponse::error(
                    "MISSING_SOURCE",
                    "source must be provided when program_id is missing or not cached",
                ),
            ));
        }
    };

    let pid = format!("cel_prog_{}", fnv1a_hash(source));

    if let Ok(pinned) = get_pinned().lock() {
        if let Some(entry) = pinned.get(&pid) {
            return Ok((Arc::clone(&entry.program), pid));
        }
    }

    if let Ok(dynamic) = get_dynamic().lock() {
        if let Some(prog) = dynamic.get(&pid) {
            return Ok((Arc::clone(prog), pid));
        }
    }

    if let Err(err) = check_expression_complexity(source) {
        return Err((422, EvalResponse::error("COMPLEXITY_EXCEEDED", err)));
    }

    let program = match Program::compile(source) {
        Ok(p) => Arc::new(p),
        Err(e) => return Err((422, EvalResponse::error("COMPILATION_ERROR", e.to_string()))),
    };

    if let Ok(mut dynamic) = get_dynamic().lock() {
        if dynamic.len() >= MAX_DYNAMIC_CACHE {
            if let Some(k) = dynamic.keys().next().cloned() {
                dynamic.remove(&k);
            }
        }
        dynamic.insert(pid.clone(), Arc::clone(&program));
    }

    Ok((program, pid))
}

fn add_custom_helpers(context: &mut Context) {
    use cel::extractors::This;

    // 1. Regex functions (callable as `text.matches(pattern)` or `matches(text, pattern)`)
    context.add_function("matches", |This(text): This<Arc<String>>, pattern: Arc<String>| -> bool {
        if let Ok(re) = regex::Regex::new(&pattern) {
            re.is_match(&text)
        } else {
            false
        }
    });

    context.add_function(
        "regex_replace",
        |This(text): This<Arc<String>>, pattern: Arc<String>, replacement: Arc<String>| -> Arc<String> {
            if let Ok(re) = regex::Regex::new(&pattern) {
                Arc::new(re.replace_all(&text, replacement.as_str()).to_string())
            } else {
                text
            }
        },
    );

    context.add_function(
        "regex_find",
        |This(text): This<Arc<String>>, pattern: Arc<String>| -> Arc<String> {
            if let Ok(re) = regex::Regex::new(&pattern) {
                if let Some(m) = re.find(&text) {
                    return Arc::new(m.as_str().to_string());
                }
            }
            Arc::new(String::new())
        },
    );

    // 2. Salesforce / Agentforce helpers
    context.add_function("isBlank", |This(val): This<Value>| -> bool {
        match val {
            Value::Null => true,
            Value::String(s) => s.trim().is_empty(),
            Value::List(l) => l.is_empty(),
            Value::Map(m) => m.map.is_empty(),
            _ => false,
        }
    });

    context.add_function("isNotBlank", |This(val): This<Value>| -> bool {
        match val {
            Value::Null => false,
            Value::String(s) => !s.trim().is_empty(),
            Value::List(l) => !l.is_empty(),
            Value::Map(m) => !m.map.is_empty(),
            _ => true,
        }
    });

    context.add_function("lower", |This(text): This<Arc<String>>| -> Arc<String> {
        Arc::new(text.to_lowercase())
    });

    context.add_function("upper", |This(text): This<Arc<String>>| -> Arc<String> {
        Arc::new(text.to_uppercase())
    });

    context.add_function("coalesce", |This(a): This<Value>, b: Value| -> Result<Value, cel::ExecutionError> {
        match a {
            Value::Null => Ok(b),
            _ => Ok(a),
        }
    });
}

fn json_to_cel_value(value: JsonValue) -> Result<Value, String> {
    match value {
        JsonValue::Null => Ok(Value::Null),
        JsonValue::Bool(value) => Ok(Value::Bool(value)),
        JsonValue::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(Value::Int(value))
            } else if let Some(value) = value.as_u64() {
                if value <= i64::MAX as u64 {
                    Ok(Value::Int(value as i64))
                } else {
                    Ok(Value::UInt(value))
                }
            } else if let Some(value) = value.as_f64() {
                Ok(Value::Float(value))
            } else {
                Err("JSON number cannot be represented as a CEL number".to_string())
            }
        }
        JsonValue::String(value) => Ok(Value::String(Arc::new(value))),
        JsonValue::Array(values) => values
            .into_iter()
            .map(json_to_cel_value)
            .collect::<Result<Vec<_>, _>>()
            .map(|values| Value::List(Arc::new(values))),
        JsonValue::Object(values) => {
            let mut entries = HashMap::with_capacity(values.len());
            for (key, value) in values {
                entries.insert(Key::String(Arc::new(key)), json_to_cel_value(value)?);
            }
            Ok(Value::Map(Map {
                map: Arc::new(entries),
            }))
        }
    }
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::List(_) => "list",
        Value::Map(_) => "map",
        Value::Int(_) => "int",
        Value::UInt(_) => "uint",
        Value::Float(_) => "double",
        Value::String(_) => "string",
        Value::Bytes(_) => "bytes",
        Value::Bool(_) => "bool",
        Value::Null => "null",
        Value::Timestamp(_) => "timestamp",
        Value::Duration(_) => "duration",
        Value::Function(_, _) => "function",
        Value::Opaque(_) => "opaque",
    }
}

fn evaluate_json(input: &[u8]) -> (u16, EvalResponse) {
    let request: EvalRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => return (400, EvalResponse::error("INVALID_JSON", error.to_string())),
    };

    let JsonValue::Object(context_values) = request.context else {
        return (
            400,
            EvalResponse::error("INVALID_CONTEXT", "context must be a JSON object"),
        );
    };

    let (program, program_id) =
        match get_or_compile_program(request.source.as_deref(), request.program_id.as_deref()) {
            Ok(p) => p,
            Err(e) => return e,
        };

    let mut context = Context::default();
    add_custom_helpers(&mut context);

    for (name, value) in context_values {
        let value = match json_to_cel_value(value) {
            Ok(value) => value,
            Err(error) => return (400, EvalResponse::error("INVALID_CONTEXT", error)),
        };
        if let Err(error) = context.add_variable(name, value) {
            return (
                400,
                EvalResponse::error(
                    "INVALID_CONTEXT",
                    format!("Unable to add context variable: {error:?}"),
                ),
            );
        }
    }

    match program.execute(&context) {
        Ok(value) => {
            let kind = value_type(&value);
            match value.json() {
                Ok(value) => (
                    200,
                    EvalResponse {
                        success: true,
                        value,
                        value_type: kind,
                        program_id: Some(program_id),
                        error_code: None,
                        error: None,
                    },
                ),
                Err(error) => (
                    422,
                    EvalResponse::error("JSON_SERIALIZATION_ERROR", error.to_string()),
                ),
            }
        }
        Err(error) => (
            422,
            EvalResponse::error("EXECUTION_ERROR", error.to_string()),
        ),
    }
}

#[derive(Deserialize)]
struct BatchRule {
    id: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    program_id: Option<String>,
}

#[derive(Deserialize)]
struct BatchEvalRequest {
    #[serde(default = "empty_object")]
    context: JsonValue,
    rules: Vec<BatchRule>,
}

#[derive(Serialize)]
struct BatchRuleResult {
    id: String,
    success: bool,
    value: JsonValue,
    value_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    program_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct BatchEvalResponse {
    success: bool,
    results: Vec<BatchRuleResult>,
    total_evaluated: usize,
    total_failed: usize,
}

fn batch_evaluate_json(input: &[u8]) -> (u16, String) {
    let request: BatchEvalRequest = match serde_json::from_slice(input) {
        Ok(r) => r,
        Err(e) => {
            return (
                400,
                format!(
                    "{{\"success\":false,\"error\":\"{}\"}}",
                    e.to_string().replace('"', "\\\"")
                ),
            )
        }
    };

    let JsonValue::Object(context_values) = request.context else {
        return (
            400,
            "{\"success\":false,\"error\":\"context must be a JSON object\"}".to_string(),
        );
    };

    let mut context = Context::default();
    add_custom_helpers(&mut context);

    for (name, value) in context_values {
        let value = match json_to_cel_value(value) {
            Ok(v) => v,
            Err(e) => {
                return (
                    400,
                    format!(
                        "{{\"success\":false,\"error\":\"{}\"}}",
                        e.replace('"', "\\\"")
                    ),
                )
            }
        };
        if let Err(e) = context.add_variable(name, value) {
            return (
                400,
                format!(
                    "{{\"success\":false,\"error\":\"Unable to add variable: {:?}\"}}",
                    e
                ),
            );
        }
    }

    let mut results = Vec::with_capacity(request.rules.len());

    for rule in request.rules {
        let (program, program_id) =
            match get_or_compile_program(rule.source.as_deref(), rule.program_id.as_deref()) {
                Ok(p) => p,
                Err((_, err_resp)) => {
                    results.push(BatchRuleResult {
                        id: rule.id,
                        success: false,
                        value: JsonValue::Null,
                        value_type: "error",
                        program_id: None,
                        error_code: err_resp.error_code,
                        error: err_resp.error,
                    });
                    continue;
                }
            };

        match program.execute(&context) {
            Ok(value) => {
                let kind = value_type(&value);
                match value.json() {
                    Ok(val) => {
                        results.push(BatchRuleResult {
                            id: rule.id,
                            success: true,
                            value: val,
                            value_type: kind,
                            program_id: Some(program_id),
                            error_code: None,
                            error: None,
                        });
                    }
                    Err(e) => {
                        results.push(BatchRuleResult {
                            id: rule.id,
                            success: false,
                            value: JsonValue::Null,
                            value_type: "error",
                            program_id: Some(program_id),
                            error_code: Some("JSON_SERIALIZATION_ERROR"),
                            error: Some(e.to_string()),
                        });
                    }
                }
            }
            Err(e) => {
                results.push(BatchRuleResult {
                    id: rule.id,
                    success: false,
                    value: JsonValue::Null,
                    value_type: "error",
                    program_id: Some(program_id),
                    error_code: Some("EXECUTION_ERROR"),
                    error: Some(e.to_string()),
                });
            }
        }
    }

    let total_evaluated = results.len();
    let total_failed = results.iter().filter(|r| !r.success).count();

    let response = BatchEvalResponse {
        success: total_failed == 0,
        results,
        total_evaluated,
        total_failed,
    };

    (
        200,
        serde_json::to_string(&response).unwrap_or_else(|_| ERROR_FALLBACK.to_string()),
    )
}

#[derive(Deserialize)]
struct PrecompileRequest {
    source: String,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Serialize)]
struct PrecompileResponse {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    complexity: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    program_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variables: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    functions: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct BatchPrecompileRequest {
    scripts: Vec<PrecompileRequest>,
}

#[derive(Serialize)]
struct BatchPrecompileResponse {
    success: bool,
    total_compiled: usize,
    total_failed: usize,
    results: Vec<PrecompileResponse>,
}

#[derive(Serialize)]
struct ProgramMeta {
    id: String,
    source: String,
    complexity: usize,
    variables: Vec<String>,
    functions: Vec<String>,
}

#[derive(Serialize)]
struct ProgramListResponse {
    count: usize,
    programs: Vec<ProgramMeta>,
}

fn compile_single_script(source: &str, requested_id: Option<&str>) -> (u16, PrecompileResponse) {
    if source.trim().is_empty() {
        return (
            400,
            PrecompileResponse {
                valid: false,
                error_code: Some("EMPTY_SOURCE"),
                error: Some("source must be a non-empty CEL expression".to_string()),
                complexity: None,
                program_id: None,
                variables: None,
                functions: None,
            },
        );
    }

    if let Err(err) = check_expression_complexity(source) {
        return (
            422,
            PrecompileResponse {
                valid: false,
                error_code: Some("COMPLEXITY_EXCEEDED"),
                error: Some(err.to_string()),
                complexity: None,
                program_id: None,
                variables: None,
                functions: None,
            },
        );
    }

    let default_pid = format!("cel_prog_{}", fnv1a_hash(source));
    let target_id = requested_id
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(&default_pid)
        .to_string();

    match Program::compile(source) {
        Ok(program) => {
            let refs = program.references();
            let mut variables: Vec<String> = refs.variables().into_iter().map(String::from).collect();
            variables.sort();
            let mut functions: Vec<String> = refs.functions().into_iter().map(String::from).collect();
            functions.sort();
            let complexity = source.split_whitespace().count().max(1);

            let entry = PinnedEntry {
                program: Arc::new(program),
                source: source.to_string(),
                complexity,
                variables: variables.clone(),
                functions: functions.clone(),
            };

            if let Ok(mut pinned) = get_pinned().lock() {
                if target_id != default_pid {
                    pinned.insert(default_pid, entry.clone());
                }
                pinned.insert(target_id.clone(), entry);
            }

            (
                200,
                PrecompileResponse {
                    valid: true,
                    error_code: None,
                    error: None,
                    complexity: Some(complexity),
                    program_id: Some(target_id),
                    variables: Some(variables),
                    functions: Some(functions),
                },
            )
        }
        Err(err) => (
            422,
            PrecompileResponse {
                valid: false,
                error_code: Some("COMPILATION_ERROR"),
                error: Some(err.to_string()),
                complexity: None,
                program_id: None,
                variables: None,
                functions: None,
            },
        ),
    }
}

fn precompile_json(input: &[u8]) -> (u16, PrecompileResponse) {
    let request: PrecompileRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => {
            return (
                400,
                PrecompileResponse {
                    valid: false,
                    error_code: Some("INVALID_JSON"),
                    error: Some(error.to_string()),
                    complexity: None,
                    program_id: None,
                    variables: None,
                    functions: None,
                },
            );
        }
    };
    compile_single_script(&request.source, request.id.as_deref())
}

fn batch_precompile_json(input: &[u8]) -> (u16, String) {
    let request: BatchPrecompileRequest = match serde_json::from_slice(input) {
        Ok(request) => request,
        Err(error) => {
            return (
                400,
                format!(
                    "{{\"success\":false,\"error\":\"{}\"}}",
                    error.to_string().replace('"', "\\\"")
                ),
            );
        }
    };

    let mut results = Vec::with_capacity(request.scripts.len());
    let mut total_failed = 0;

    for item in request.scripts {
        let (_, resp) = compile_single_script(&item.source, item.id.as_deref());
        if !resp.valid {
            total_failed += 1;
        }
        results.push(resp);
    }

    let total_compiled = results.len();
    let response = BatchPrecompileResponse {
        success: total_failed == 0,
        total_compiled,
        total_failed,
        results,
    };

    (
        200,
        serde_json::to_string(&response).unwrap_or_else(|_| "{\"success\":false}".to_string()),
    )
}

fn list_programs_json() -> (u16, String) {
    let mut programs = Vec::new();
    if let Ok(pinned) = get_pinned().lock() {
        for (id, entry) in pinned.iter() {
            programs.push(ProgramMeta {
                id: id.clone(),
                source: entry.source.clone(),
                complexity: entry.complexity,
                variables: entry.variables.clone(),
                functions: entry.functions.clone(),
            });
        }
    }
    programs.sort_by(|a, b| a.id.cmp(&b.id));
    let count = programs.len();
    let response = ProgramListResponse { count, programs };
    (
        200,
        serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"count\":0,\"programs\":[]}".to_string()),
    )
}

fn build_output_payload(status: u16, json: &str) -> *mut u8 {
    let payload = format!("{status}\n{json}");
    let payload_bytes = payload.as_bytes();
    let total_len = payload_bytes.len();

    let layout = match Layout::array::<u8>(total_len + 5) {
        Ok(l) => l,
        Err(_) => return std::ptr::null_mut(),
    };
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() {
        return std::ptr::null_mut();
    }

    unsafe {
        let len_bytes = (total_len as u32).to_le_bytes();
        std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), ptr, 4);
        std::ptr::copy_nonoverlapping(payload_bytes.as_ptr(), ptr.add(4), total_len);
        *ptr.add(4 + total_len) = 0;
        ptr.add(4)
    }
}

#[no_mangle]
pub extern "C" fn cel_alloc(length: usize) -> *mut u8 {
    if length == 0 {
        return std::ptr::null_mut();
    }
    match Layout::array::<u8>(length) {
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn cel_free(pointer: *mut u8, length: usize) {
    if !pointer.is_null() && length > 0 {
        if let Ok(layout) = Layout::array::<u8>(length) {
            dealloc(pointer, layout);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn cel_free_cstring(pointer: *mut u8) {
    if !pointer.is_null() {
        let base = pointer.sub(4);
        let mut len_bytes = [0u8; 4];
        std::ptr::copy_nonoverlapping(base, len_bytes.as_mut_ptr(), 4);
        let total_len = u32::from_le_bytes(len_bytes) as usize;
        if let Ok(layout) = Layout::array::<u8>(total_len + 5) {
            dealloc(base, layout);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn cel_free_output(pointer: *mut u8) {
    cel_free_cstring(pointer);
}

#[no_mangle]
pub unsafe extern "C" fn cel_eval_json(input_pointer: *const u8, input_length: usize) -> *mut u8 {
    if input_pointer.is_null() || input_length == 0 {
        let response = EvalResponse::error("EMPTY_REQUEST", "request body is empty");
        let json = serde_json::to_string(&response).unwrap_or_else(|_| ERROR_FALLBACK.to_string());
        return build_output_payload(400, &json);
    }
    let input = slice::from_raw_parts(input_pointer, input_length);
    let (status, response) = evaluate_json(input);
    let json = serde_json::to_string(&response).unwrap_or_else(|_| ERROR_FALLBACK.to_string());
    build_output_payload(status, &json)
}

#[no_mangle]
pub unsafe extern "C" fn cel_batch_eval_json(
    input_pointer: *const u8,
    input_length: usize,
) -> *mut u8 {
    if input_pointer.is_null() || input_length == 0 {
        return build_output_payload(
            400,
            "{\"success\":false,\"error\":\"request body is empty\"}",
        );
    }
    let input = slice::from_raw_parts(input_pointer, input_length);
    let (status, json) = batch_evaluate_json(input);
    build_output_payload(status, &json)
}

#[no_mangle]
pub unsafe extern "C" fn cel_precompile(input_pointer: *const u8, input_length: usize) -> *mut u8 {
    if input_pointer.is_null() || input_length == 0 {
        let response = PrecompileResponse {
            valid: false,
            error_code: Some("EMPTY_REQUEST"),
            error: Some("request body is empty".to_string()),
            complexity: None,
            program_id: None,
            variables: None,
            functions: None,
        };
        let json =
            serde_json::to_string(&response).unwrap_or_else(|_| "{\"valid\":false}".to_string());
        return build_output_payload(400, &json);
    }
    let input = slice::from_raw_parts(input_pointer, input_length);
    let (status, response) = precompile_json(input);
    let json =
        serde_json::to_string(&response).unwrap_or_else(|_| "{\"valid\":false}".to_string());
    build_output_payload(status, &json)
}

#[no_mangle]
pub unsafe extern "C" fn cel_batch_precompile(
    input_pointer: *const u8,
    input_length: usize,
) -> *mut u8 {
    if input_pointer.is_null() || input_length == 0 {
        return build_output_payload(
            400,
            "{\"success\":false,\"error\":\"request body is empty\"}",
        );
    }
    let input = slice::from_raw_parts(input_pointer, input_length);
    let (status, json) = batch_precompile_json(input);
    build_output_payload(status, &json)
}

#[no_mangle]
pub unsafe extern "C" fn cel_list_programs() -> *mut u8 {
    let (status, json) = list_programs_json();
    build_output_payload(status, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_regex_functions() {
        // Test free function matches() with raw CEL string r'...'
        let input = br#"{"source": "matches('alice@example.com', r'^[a-z]+@[a-z]+\\.[a-z]+$')", "context": {}}"#;
        let (status, resp) = evaluate_json(input);
        assert_eq!(status, 200);
        assert_eq!(resp.value, JsonValue::Bool(true));

        // Test regex_replace with raw CEL string
        let rep_input =
            br#"{"source": "regex_replace('hello 123 world', r'\\d+', '456')", "context": {}}"#;
        let (status, resp) = evaluate_json(rep_input);
        assert_eq!(status, 200);
        assert_eq!(
            resp.value,
            JsonValue::String("hello 456 world".to_string())
        );

        // Test regex_find with raw CEL string
        let find_input =
            br#"{"source": "regex_find('Invoice #INV-98721 total $50', r'INV-\\d+')", "context": {}}"#;
        let (status, resp) = evaluate_json(find_input);
        assert_eq!(status, 200);
        assert_eq!(resp.value, JsonValue::String("INV-98721".to_string()));

        // Also test receiver method syntax: 'alice@example.com'.matches(...)
        let receiver_input =
            br#"{"source": "'alice@example.com'.matches(r'^[a-z]+@[a-z]+\\.[a-z]+$')", "context": {}}"#;
        let (status, resp) = evaluate_json(receiver_input);
        assert_eq!(status, 200);
        assert_eq!(resp.value, JsonValue::Bool(true));
    }

    #[test]
    fn test_salesforce_helpers() {
        let input = br#"{"source": "isBlank('') && isNotBlank('hello') && lower('HELLO') == 'hello' && coalesce(null, 'ok') == 'ok'", "context": {}}"#;
        let (status, resp) = evaluate_json(input);
        assert_eq!(status, 200);
        assert_eq!(resp.value, JsonValue::Bool(true));
    }

    #[test]
    fn test_batch_evaluate() {
        let input = br#"{
            "context": {"user": {"score": 150, "verified": true}},
            "rules": [
                {"id": "r1", "source": "user.score > 100"},
                {"id": "r2", "source": "user.verified"},
                {"id": "r3", "source": "user.score < 50"}
            ]
        }"#;
        let (status, json) = batch_evaluate_json(input);
        assert_eq!(status, 200);
        let resp: JsonValue = serde_json::from_str(&json).unwrap();
        assert_eq!(resp["total_evaluated"].as_u64().unwrap(), 3);
        assert_eq!(resp["results"][0]["value"], JsonValue::Bool(true));
        assert_eq!(resp["results"][1]["value"], JsonValue::Bool(true));
        assert_eq!(resp["results"][2]["value"], JsonValue::Bool(false));
    }

    #[test]
    fn test_batch_precompile_and_listing() {
        let input = br#"{
            "scripts": [
                {"id": "rule_score", "source": "score >= 100"},
                {"id": "rule_email", "source": "email.endsWith('@corp.com')"}
            ]
        }"#;
        let (status, json) = batch_precompile_json(input);
        assert_eq!(status, 200);
        let resp: JsonValue = serde_json::from_str(&json).unwrap();
        assert_eq!(resp["success"], JsonValue::Bool(true));
        assert_eq!(resp["total_compiled"].as_u64().unwrap(), 2);
        assert_eq!(resp["results"][0]["program_id"], "rule_score");
        assert_eq!(resp["results"][1]["program_id"], "rule_email");

        // Verify referenced variables are extracted
        let vars = resp["results"][0]["variables"].as_array().unwrap();
        assert_eq!(vars[0].as_str().unwrap(), "score");

        // Verify we can evaluate using the custom program_id
        let eval_input = br#"{"program_id": "rule_score", "context": {"score": 150}}"#;
        let (status, eval_resp) = evaluate_json(eval_input);
        assert_eq!(status, 200);
        assert_eq!(eval_resp.value, JsonValue::Bool(true));

        // Test listing programs
        let (status, list_json) = list_programs_json();
        assert_eq!(status, 200);
        let list_resp: JsonValue = serde_json::from_str(&list_json).unwrap();
        assert!(list_resp["count"].as_u64().unwrap() >= 2);
    }
}
