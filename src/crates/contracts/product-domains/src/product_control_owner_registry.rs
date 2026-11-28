//! Typed owner facts for user-facing OpenBitFun product controls.
//!
//! This registry is deliberately separate from the explanatory capability
//! overlay. Config paths, command handlers, value schemas, risk, and argument
//! scope are executable product facts and therefore live in compiled Rust.
//! The capability generator exports this registry and joins it with titles,
//! search terms, tutorials, and other presentation-only metadata.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::product_control::{
    ProductCapabilityOperationHandler, ProductCapabilityOptionHandler, ProductControlArgumentScope,
    ProductControlRisk, ProductControlValueSchema, ProductControlValueType,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProductControlOwnerDefinition {
    Option {
        capability_id: String,
        option_id: String,
        value_schema: ProductControlValueSchema,
        handler: ProductCapabilityOptionHandler,
    },
    Operation {
        capability_id: String,
        operation_id: String,
        risk: ProductControlRisk,
        input_schema: Value,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        argument_scopes: BTreeMap<String, ProductControlArgumentScope>,
        handler: ProductCapabilityOperationHandler,
    },
}

fn schema(value_type: ProductControlValueType) -> ProductControlValueSchema {
    ProductControlValueSchema {
        value_type,
        nullable: false,
        r#enum: None,
        minimum: None,
        maximum: None,
        min_length: None,
        max_length: None,
    }
}

fn boolean() -> ProductControlValueSchema {
    schema(ProductControlValueType::Boolean)
}

fn string() -> ProductControlValueSchema {
    schema(ProductControlValueType::String)
}

fn string_enum(values: &[&str]) -> ProductControlValueSchema {
    ProductControlValueSchema {
        r#enum: Some(
            values
                .iter()
                .map(|value| Value::String((*value).to_string()))
                .collect(),
        ),
        ..string()
    }
}

fn string_length(minimum: usize, maximum: usize) -> ProductControlValueSchema {
    ProductControlValueSchema {
        min_length: Some(minimum),
        max_length: Some(maximum),
        ..string()
    }
}

fn integer_range(minimum: f64, maximum: f64) -> ProductControlValueSchema {
    ProductControlValueSchema {
        minimum: Some(minimum),
        maximum: Some(maximum),
        ..schema(ProductControlValueType::Integer)
    }
}

fn nullable_integer_range(minimum: f64, maximum: f64) -> ProductControlValueSchema {
    ProductControlValueSchema {
        nullable: true,
        ..integer_range(minimum, maximum)
    }
}

fn number_range(minimum: f64, maximum: f64) -> ProductControlValueSchema {
    ProductControlValueSchema {
        minimum: Some(minimum),
        maximum: Some(maximum),
        ..schema(ProductControlValueType::Number)
    }
}

fn option(
    capability_id: &str,
    option_id: &str,
    value_schema: ProductControlValueSchema,
    handler: ProductCapabilityOptionHandler,
) -> ProductControlOwnerDefinition {
    ProductControlOwnerDefinition::Option {
        capability_id: capability_id.to_string(),
        option_id: option_id.to_string(),
        value_schema,
        handler,
    }
}

fn config(path: &str) -> ProductCapabilityOptionHandler {
    ProductCapabilityOptionHandler::Config {
        path: path.to_string(),
    }
}

fn merge_config(path: &str, fields: &[&str]) -> ProductCapabilityOptionHandler {
    ProductCapabilityOptionHandler::MergeConfig {
        path: path.to_string(),
        fields: fields.iter().map(|field| (*field).to_string()).collect(),
    }
}

fn provider(provider_id: &str, option_id: &str) -> ProductCapabilityOptionHandler {
    ProductCapabilityOptionHandler::Provider {
        provider_id: provider_id.to_string(),
        option_id: option_id.to_string(),
    }
}

fn operation(
    capability_id: &str,
    operation_id: &str,
    risk: ProductControlRisk,
    input_schema: Value,
    argument_scopes: &[(&str, ProductControlArgumentScope)],
    handler: ProductCapabilityOperationHandler,
) -> ProductControlOwnerDefinition {
    ProductControlOwnerDefinition::Operation {
        capability_id: capability_id.to_string(),
        operation_id: operation_id.to_string(),
        risk,
        input_schema,
        argument_scopes: argument_scopes
            .iter()
            .map(|(name, scope)| ((*name).to_string(), *scope))
            .collect(),
        handler,
    }
}

fn product_action(action_id: &str) -> ProductCapabilityOperationHandler {
    ProductCapabilityOperationHandler::ProductAction {
        action_id: action_id.to_string(),
    }
}

fn operation_provider(provider_id: &str, operation_id: &str) -> ProductCapabilityOperationHandler {
    ProductCapabilityOperationHandler::Provider {
        provider_id: provider_id.to_string(),
        operation_id: operation_id.to_string(),
    }
}

fn empty_input() -> Value {
    json!({ "type": "object", "additionalProperties": false })
}

fn mcp_input(action: &str) -> Value {
    if action == "list" {
        return empty_input();
    }
    let mut properties = serde_json::Map::new();
    let mut required = vec!["serverId"];
    properties.insert("serverId".into(), json!({ "type": "string", "minLength": 1,
        "description": "Exact user server ID from list-servers, or a new ID when adding a server. These settings belong to the executing OpenBitFun product host, not the workspace host." }));
    if matches!(action, "configure" | "delete") {
        required.push("expectedFingerprint");
        properties.insert("expectedFingerprint".into(), json!({ "type": "string", "minLength": 1,
            "description": "Copy the fingerprint returned by list-servers. Reload after a conflict; never overwrite a concurrent edit." }));
    }
    if action == "configure" {
        required.push("config");
        let mut fields = serde_json::Map::new();
        for field in ["name", "command", "url", "type", "source", "transport"] {
            fields.insert(
                field.into(),
                json!({ "anyOf": [{ "type": "string" }, { "type": "null" }] }),
            );
        }
        fields.insert(
            "args".into(),
            json!({ "type": "array", "items": { "type": "string" } }),
        );
        for field in [
            "enabled",
            "autoStart",
            "inheritParentEnvironment",
            "oauthEnabled",
        ] {
            fields.insert(field.into(), json!({ "type": "boolean" }));
        }
        properties.insert("config".into(), json!({ "type": "object", "additionalProperties": false,
            "properties": fields,
            "description": "Patch non-secret fields of one server; omitted fields and existing credentials are preserved. New stdio servers require command; HTTP/SSE servers require url. Use null to remove an obsolete string field when switching transport. Credentials, environment and headers are entered through the protected MCP settings flow, never by reading existing secrets or putting secrets in command/args/url. Saving reconciles runtime state; autoStart defaults to true. Inspect the returned status instead of assuming connection succeeded." }));
        properties.insert("workingDirectory".into(), json!({ "type": "string", "minLength": 1,
            "description": "Optional directory on the OpenBitFun product host for a local process; never a remote workspace path." }));
    }
    json!({ "type": "object", "additionalProperties": false, "properties": properties, "required": required })
}

fn miniapp_input(action: &str) -> Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();
    if action != "list" && action != "create" {
        properties.insert("appId".into(), json!({ "type": "string", "minLength": 1 }));
        required.push("appId");
    }
    if matches!(action, "update" | "delete") {
        properties.insert(
            "expectedVersion".into(),
            json!({ "type": "integer", "minimum": 1 }),
        );
    }
    if matches!(action, "create" | "update") {
        for field in [
            "name",
            "description",
            "icon",
            "category",
            "html",
            "css",
            "uiJs",
            "workerJs",
        ] {
            properties.insert(
                field.into(),
                if field == "name" {
                    json!({ "type": "string", "minLength": 1 })
                } else {
                    json!({ "type": "string" })
                },
            );
        }
        properties.insert(
            "tags".into(),
            json!({ "type": "array", "items": { "type": "string" } }),
        );
        properties.insert("permissions".into(), json!({ "type": "object" }));
        properties.insert("chrome".into(), json!({ "type": "object", "description": "Per-app titlebar configuration; see MiniApp chrome.titlebar contract. Use {} to restore defaults." }));
        properties.insert("esmDependencies".into(), json!({ "type": "array", "items": {
            "type": "object", "required": ["name"], "additionalProperties": false,
            "properties": { "name": { "type": "string" }, "version": { "type": "string" }, "url": { "type": "string" } }
        } }));
        properties.insert(
            "npmDependencies".into(),
            json!({ "type": "array", "items": {
            "type": "object", "required": ["name", "version"], "additionalProperties": false,
            "properties": { "name": { "type": "string" }, "version": { "type": "string" } }
        } }),
        );
        if action == "create" {
            required.push("name");
        }
    }
    json!({ "type": "object", "additionalProperties": false, "properties": properties, "required": required })
}

/// Return the complete compiled registry of executable product-control facts.
///
/// Every public option and operation must appear exactly once. Structural
/// generation gates reject both missing explanatory overlays and stale owner
/// definitions, so adding a setting or command cannot silently disappear from
/// Agent discovery, global search, or the Playbook.
pub fn owner_definitions() -> Vec<ProductControlOwnerDefinition> {
    use ProductCapabilityOptionHandler::{
        AppearanceSelection, FlowChatPermissionModeControl, Language,
    };
    use ProductControlArgumentScope::ProductHostLocal;
    use ProductControlRisk::{Destructive, Execute, Read, Ui, Write};

    vec![
        operation(
            "feature.detached-dispatch",
            "list-targets",
            Read,
            json!({"type": "object", "properties": {}, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "list-targets"),
        ),
        operation(
            "feature.detached-dispatch",
            "probe",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["target"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "probe"),
        ),
        operation(
            "feature.detached-dispatch",
            "submit",
            Execute,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512},
                "prompt": {"type": "string", "minLength": 1, "maxLength": 32768},
                "approvalPolicy": {"type": "string", "enum": ["auto", "reject-and-report", "remote"]},
                "workspacePath": {"type": "string", "minLength": 1},
                "source": {"type": "object", "description": "Target-resolved source ({kind:'workspace', workspaceId, ref?}, {kind:'remote', remoteUrl, ref}, or {kind:'job', jobId, sourceDeviceId, head?, branch?, baseCommit?}). Mutually exclusive with workspacePath."},
                "agent": {"type": "string", "minLength": 1, "maxLength": 128},
                "model": {"type": "string", "minLength": 1, "maxLength": 256},
                "baseRef": {"type": "string", "minLength": 1, "maxLength": 512},
                "includeUncommitted": {"type": "boolean"},
                "title": {"type": "string", "minLength": 1, "maxLength": 200}
            }, "required": ["target", "prompt", "approvalPolicy"], "additionalProperties": false}),
            &[("workspacePath", ProductHostLocal)],
            operation_provider("detached-dispatch", "submit"),
        ),
        operation(
            "feature.detached-dispatch",
            "status",
            Read,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "cursor": {"type": "integer", "minimum": 0},
                "summaryOnly": {"type": "boolean"}
            }, "required": ["jobId"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "status"),
        ),
        operation(
            "feature.detached-dispatch",
            "wait",
            Read,
            json!({"type": "object", "properties": {
                "jobIds": {"type": "array", "items": {"type": "string", "minLength": 1, "maxLength": 128}},
                "until": {"type": "string", "enum": ["state_change", "any_blocked", "any_terminal", "all_terminal"]},
                "timeoutSeconds": {"type": "integer", "minimum": 1, "maximum": 600}
            }, "required": ["jobIds"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "wait"),
        ),
        operation(
            "feature.detached-dispatch",
            "result-summary",
            Read,
            json!({"type": "object", "properties": {"jobId": {"type": "string", "minLength": 1, "maxLength": 128}}, "required": ["jobId"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "result-summary"),
        ),
        operation(
            "feature.detached-dispatch",
            "continue",
            Execute,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "prompt": {"type": "string", "minLength": 1, "maxLength": 32768},
                "approvalPolicy": {"type": "string", "enum": ["auto", "reject-and-report", "remote"]},
                "model": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["jobId", "prompt"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "continue"),
        ),
        operation(
            "feature.detached-dispatch",
            "append",
            Execute,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "prompt": {"type": "string", "minLength": 1, "maxLength": 32768}
            }, "required": ["jobId", "prompt"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "append"),
        ),
        operation(
            "feature.detached-dispatch",
            "answer",
            Execute,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "requestId": {"type": "string", "minLength": 1, "maxLength": 512},
                "reply": {"type": "string", "enum": ["once", "always", "reject"]},
                "feedback": {"type": "string", "maxLength": 4096},
                "answers": {"type": "object", "description": "Question answers keyed by question index when answering pendingQuestions"}
            }, "required": ["jobId", "requestId"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "answer"),
        ),
        operation(
            "feature.detached-dispatch",
            "sync-result",
            Execute,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "message": {"type": "string", "minLength": 1, "maxLength": 512}
            }, "required": ["jobId"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "sync-result"),
        ),
        operation(
            "feature.detached-dispatch",
            "fetch-file",
            Write,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "remotePath": {"type": "string", "minLength": 1, "maxLength": 2048, "description": "File path inside the target job workspace or session output directory"},
                "localPath": {"type": "string", "minLength": 1, "maxLength": 2048, "description": "Absolute destination file path on this controlling host"},
                "overwrite": {"type": "boolean"},
                "maxBytes": {"type": "integer", "minimum": 1, "maximum": 2147483648_u64}
            }, "required": ["jobId", "remotePath", "localPath"], "additionalProperties": false}),
            &[("localPath", ProductHostLocal)],
            operation_provider("detached-dispatch", "fetch-file"),
        ),
        operation(
            "feature.detached-dispatch",
            "publish-branch",
            Execute,
            json!({"type": "object", "properties": {
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "remote": {"type": "string", "minLength": 1, "maxLength": 128}
            }, "required": ["jobId"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "publish-branch"),
        ),
        operation(
            "feature.detached-dispatch",
            "list-jobs",
            Read,
            json!({"type": "object", "properties": {"target": {"type": "string", "minLength": 1, "maxLength": 512}}, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "list-jobs"),
        ),
        operation(
            "feature.detached-dispatch",
            "cancel",
            Destructive,
            json!({"type": "object", "properties": {"jobId": {"type": "string", "minLength": 1, "maxLength": 128}}, "required": ["jobId"], "additionalProperties": false}),
            &[],
            operation_provider("detached-dispatch", "cancel"),
        ),
        operation(
            "feature.fleet",
            "navigator",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Optional device filter ('self', 'local', 'all', deviceId, device:<id>, or device name/alias)"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "navigator"),
        ),
        operation(
            "feature.fleet",
            "device-detail",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "device-detail"),
        ),
        operation(
            "feature.fleet",
            "list-models",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Device perspective for model grouping; defaults to 'self'"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "list-models"),
        ),
        operation(
            "feature.fleet",
            "list-workspaces",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "'self' (default), 'all', or a specific device selector"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "list-workspaces"),
        ),
        operation(
            "feature.fleet",
            "list-sessions",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 2048},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "list-sessions"),
        ),
        operation(
            "feature.fleet",
            "create-session",
            Execute,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 2048},
                "sessionName": {"type": "string", "minLength": 1, "maxLength": 200},
                "agentType": {"type": "string", "minLength": 1, "maxLength": 128},
                "modelName": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["sessionName"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "create-session"),
        ),
        operation(
            "feature.fleet",
            "send-message",
            Execute,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "message": {"type": "string", "minLength": 1, "maxLength": 65536},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 2048},
                "agentType": {"type": "string", "minLength": 1, "maxLength": 128},
                "modelId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["sessionId", "message"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "send-message"),
        ),
        operation(
            "feature.fleet",
            "read-session",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 2048},
                "tailTurnCount": {"type": "integer", "minimum": 1, "maximum": 16}
            }, "required": ["sessionId"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "read-session"),
        ),
        operation(
            "feature.fleet",
            "cancel-session",
            Destructive,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["sessionId"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "cancel-session"),
        ),
        operation(
            "feature.fleet",
            "list-prompts",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "'all' (default), 'self', or a specific device selector"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "list-prompts"),
        ),
        operation(
            "feature.fleet",
            "answer-prompt",
            Execute,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self' (this device)"},
                "requestId": {"type": "string", "minLength": 1, "maxLength": 512},
                "route": {"type": "string", "enum": ["auto", "session", "dispatch"]},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "jobId": {"type": "string", "minLength": 1, "maxLength": 128},
                "reply": {"type": "string", "enum": ["once", "always", "reject"]},
                "feedback": {"type": "string", "maxLength": 4096},
                "answers": {"type": "object", "description": "Answers payload when answering a user question"}
            }, "required": ["requestId"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "answer-prompt"),
        ),
        operation(
            "feature.fleet",
            "pull-file",
            Write,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Source device selector; defaults to 'self' (this device)"},
                "remotePath": {"type": "string", "minLength": 1, "maxLength": 2048, "description": "File path on the source device (within an opened workspace)"},
                "localPath": {"type": "string", "minLength": 1, "maxLength": 2048, "description": "Absolute destination file path on this host"},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "overwrite": {"type": "boolean"},
                "maxBytes": {"type": "integer", "minimum": 1, "maximum": 134217728_u64}
            }, "required": ["remotePath", "localPath"], "additionalProperties": false}),
            &[("localPath", ProductHostLocal)],
            operation_provider("fleet", "pull-file"),
        ),
        operation(
            "feature.fleet",
            "attention",
            Read,
            empty_input(),
            &[],
            operation_provider("fleet", "attention"),
        ),
        operation(
            "feature.fleet",
            "mark-attention-read",
            Write,
            json!({"type": "object", "properties": {
                "revision": {"type": "integer", "minimum": 0}
            }, "required": ["revision"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "mark-attention-read"),
        ),
        operation(
            "feature.fleet",
            "recent-sessions",
            Read,
            json!({"type": "object", "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "cursor": {"type": "string", "minLength": 1, "maxLength": 512}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "recent-sessions"),
        ),
        operation(
            "feature.fleet",
            "search-sessions",
            Read,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "'self' (default), 'all', or a specific device selector"},
                "query": {"type": "string", "minLength": 1, "maxLength": 1024},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 2048},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100}
            }, "required": ["query"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "search-sessions"),
        ),
        operation(
            "feature.fleet",
            "manage-cron",
            Execute,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector (e.g. an always-on host); defaults to 'self'"},
                "action": {"type": "string", "enum": ["list", "create", "update", "delete"]},
                "jobId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 2048},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "name": {"type": "string", "minLength": 1, "maxLength": 200},
                "schedule": {"type": "object", "description": "CronSchedule object for create/update"},
                "payload": {"type": "object", "description": "CronJobPayload object for create/update"},
                "enabled": {"type": "boolean"}
            }, "required": ["action"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "manage-cron"),
        ),
        operation(
            "feature.fleet",
            "invoke-control",
            Execute,
            json!({"type": "object", "properties": {
                "target": {"type": "string", "minLength": 1, "maxLength": 512, "description": "Target device selector; defaults to 'self'"},
                "action": {"type": "string", "enum": ["get", "configure", "execute"]},
                "capabilityId": {"type": "string", "minLength": 1, "maxLength": 128},
                "operationId": {"type": "string", "minLength": 1, "maxLength": 128},
                "optionId": {"type": "string", "minLength": 1, "maxLength": 128},
                "arguments": {"type": "object"},
                "value": {}
            }, "required": ["action", "capabilityId"], "additionalProperties": false}),
            &[],
            operation_provider("fleet", "invoke-control"),
        ),
        // ── workspace-ops (feature.projects & feature.remote-workspaces) ──
        operation(
            "feature.projects",
            "list-workspaces",
            Read,
            empty_input(),
            &[],
            operation_provider("workspace-ops", "list-workspaces"),
        ),
        operation(
            "feature.projects",
            "open-workspace",
            Write,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "path": {"type": "string", "minLength": 1, "maxLength": 4096},
                "createLocal": {"type": "boolean"},
                "remoteConnectionId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": [], "additionalProperties": false}),
            &[("path", ProductHostLocal)],
            operation_provider("workspace-ops", "open-workspace"),
        ),
        operation(
            "feature.projects",
            "close-workspace",
            Write,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "close-workspace"),
        ),
        operation(
            "feature.projects",
            "set-active-workspace",
            Write,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "set-active-workspace"),
        ),
        operation(
            "feature.remote-workspaces",
            "list-connections",
            Read,
            empty_input(),
            &[],
            operation_provider("workspace-ops", "list-connections"),
        ),
        operation(
            "feature.remote-workspaces",
            "discover-environments",
            Read,
            json!({"type": "object", "properties": {
                "dockerSshConfig": {"type": "object", "description": "Optional SSHConnectionConfig when listing remote Docker containers"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "discover-environments"),
        ),
        operation(
            "feature.remote-workspaces",
            "test-connection",
            Read,
            json!({"type": "object", "properties": {
                "config": {"type": "object", "description": "SSHConnectionConfig object (from list-connections or discovered host)"}
            }, "required": ["config"], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "test-connection"),
        ),
        operation(
            "feature.remote-workspaces",
            "connect",
            Execute,
            json!({"type": "object", "properties": {
                "config": {"type": "object", "description": "SSHConnectionConfig object"}
            }, "required": ["config"], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "connect"),
        ),
        operation(
            "feature.remote-workspaces",
            "disconnect",
            Write,
            json!({"type": "object", "properties": {
                "connectionId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["connectionId"], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "disconnect"),
        ),
        operation(
            "feature.remote-workspaces",
            "open-remote-workspace",
            Execute,
            json!({"type": "object", "properties": {
                "connectionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "connectionName": {"type": "string", "minLength": 1, "maxLength": 256},
                "remotePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "sshHost": {"type": "string", "minLength": 1, "maxLength": 256},
                "rebindConnection": {"type": "boolean"}
            }, "required": ["connectionId", "connectionName", "remotePath"], "additionalProperties": false}),
            &[],
            operation_provider("workspace-ops", "open-remote-workspace"),
        ),
        operation(
            "feature.remote-workspaces",
            "transfer-file",
            Execute,
            json!({"type": "object", "properties": {
                "direction": {"type": "string", "enum": ["upload", "download"]},
                "connectionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "localPath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "remotePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["direction", "connectionId", "localPath", "remotePath"], "additionalProperties": false}),
            &[("localPath", ProductHostLocal)],
            operation_provider("workspace-ops", "transfer-file"),
        ),
        // ── skills-ops (feature.skills) ───────────────────────────────────
        operation(
            "feature.skills",
            "list-skills",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "forceRefresh": {"type": "boolean"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("skills-ops", "list-skills"),
        ),
        operation(
            "feature.skills",
            "search-market",
            Read,
            json!({"type": "object", "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 256},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("skills-ops", "search-market"),
        ),
        operation(
            "feature.skills",
            "install-market-skill",
            Execute,
            json!({"type": "object", "properties": {
                "package": {"type": "string", "minLength": 1, "maxLength": 512},
                "level": {"type": "string", "enum": ["user", "project"]},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["package"], "additionalProperties": false}),
            &[],
            operation_provider("skills-ops", "install-market-skill"),
        ),
        operation(
            "feature.skills",
            "add-local-skill",
            Write,
            json!({"type": "object", "properties": {
                "sourcePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "level": {"type": "string", "enum": ["user", "project"]},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "targetName": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["sourcePath"], "additionalProperties": false}),
            &[("sourcePath", ProductHostLocal)],
            operation_provider("skills-ops", "add-local-skill"),
        ),
        operation(
            "feature.skills",
            "set-skill-enabled",
            Write,
            json!({"type": "object", "properties": {
                "skillKey": {"type": "string", "minLength": 1, "maxLength": 256},
                "enabled": {"type": "boolean"},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["skillKey", "enabled"], "additionalProperties": false}),
            &[],
            operation_provider("skills-ops", "set-skill-enabled"),
        ),
        operation(
            "feature.skills",
            "delete-skill",
            Destructive,
            json!({"type": "object", "properties": {
                "skillKey": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["skillKey"], "additionalProperties": false}),
            &[],
            operation_provider("skills-ops", "delete-skill"),
        ),
        // ── acp-ops (setting.tools.acp) ───────────────────────────────────
        operation(
            "setting.tools.acp",
            "list-clients",
            Read,
            empty_input(),
            &[],
            operation_provider("acp-ops", "list-clients"),
        ),
        operation(
            "setting.tools.acp",
            "probe-client",
            Read,
            json!({"type": "object", "properties": {
                "remoteConnectionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "forceRefresh": {"type": "boolean"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("acp-ops", "probe-client"),
        ),
        operation(
            "setting.tools.acp",
            "install-client",
            Execute,
            json!({"type": "object", "properties": {
                "clientId": {"type": "string", "minLength": 1, "maxLength": 128},
                "remoteConnectionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "predownloadAdapterOnly": {"type": "boolean"}
            }, "required": ["clientId"], "additionalProperties": false}),
            &[],
            operation_provider("acp-ops", "install-client"),
        ),
        operation(
            "setting.tools.acp",
            "set-acp-permission-mode",
            Write,
            json!({"type": "object", "properties": {
                "clientId": {"type": "string", "minLength": 1, "maxLength": 128},
                "permissionMode": {"type": "string", "minLength": 1, "maxLength": 64}
            }, "required": ["clientId", "permissionMode"], "additionalProperties": false}),
            &[],
            operation_provider("acp-ops", "set-acp-permission-mode"),
        ),
        // ── ecosystem-ops (feature.ecosystem-compatibility) ───────────────
        operation(
            "feature.ecosystem-compatibility",
            "discover-sources",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "forceRefresh": {"type": "boolean"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ecosystem-ops", "discover-sources"),
        ),
        operation(
            "feature.ecosystem-compatibility",
            "set-source-enabled",
            Write,
            json!({"type": "object", "properties": {
                "sourceKey": {"type": "string", "minLength": 1, "maxLength": 256},
                "enabled": {"type": "boolean"},
                "expectedPreferenceRevision": {"type": "integer", "minimum": 0},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["sourceKey", "enabled", "expectedPreferenceRevision"], "additionalProperties": false}),
            &[],
            operation_provider("ecosystem-ops", "set-source-enabled"),
        ),
        operation(
            "feature.ecosystem-compatibility",
            "plan-mcp-import",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ecosystem-ops", "plan-mcp-import"),
        ),
        operation(
            "feature.ecosystem-compatibility",
            "apply-mcp-import",
            Execute,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "plan": {"type": "object"},
                "serverKeys": {"type": "array", "items": {"type": "string", "minLength": 1}}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ecosystem-ops", "apply-mcp-import"),
        ),
        operation(
            "feature.ecosystem-compatibility",
            "list-external-sessions",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ecosystem-ops", "list-external-sessions"),
        ),
        operation(
            "feature.ecosystem-compatibility",
            "restore-external-session",
            Execute,
            json!({"type": "object", "properties": {
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["sessionId"], "additionalProperties": false}),
            &[],
            operation_provider("ecosystem-ops", "restore-external-session"),
        ),
        // ── review-ops (feature.code-review & feature.files-editor) ───────
        operation(
            "feature.code-review",
            "launch-deep-review",
            Execute,
            json!({"type": "object", "properties": {
                "parentSessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "intent": {"type": "string", "enum": ["review", "strict"]},
                "commandText": {"type": "string", "minLength": 1, "maxLength": 1024},
                "files": {"type": "array", "items": {"type": "string", "minLength": 1}},
                "focus": {"type": "string", "minLength": 1, "maxLength": 1024},
                "dryRun": {"type": "boolean"}
            }, "required": ["parentSessionId"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "launch-deep-review"),
        ),
        operation(
            "feature.code-review",
            "launch-pr-review",
            Execute,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "remoteId": {"type": "string", "minLength": 1, "maxLength": 256},
                "pullRequestId": {"type": "string", "minLength": 1, "maxLength": 256},
                "provider": {"type": "object", "description": "{platform, host, projectPath}"},
                "parentSessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "dryRun": {"type": "boolean"}
            }, "required": ["workspaceId", "remoteId", "pullRequestId", "provider"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "launch-pr-review"),
        ),
        operation(
            "feature.code-review",
            "launch-remediation",
            Execute,
            json!({"type": "object", "properties": {
                "payload": {"type": "object", "description": "Remediation launch request matching list-review-records findings"}
            }, "required": ["payload"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "launch-remediation"),
        ),
        operation(
            "feature.code-review",
            "list-review-records",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "parentSessionId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "list-review-records"),
        ),
        operation(
            "feature.code-review",
            "generate-commit-message",
            Read,
            json!({"type": "object", "properties": {
                "repoPath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "options": {"type": "object"}
            }, "required": ["repoPath"], "additionalProperties": false}),
            &[("repoPath", ProductHostLocal)],
            operation_provider("review-ops", "generate-commit-message"),
        ),
        operation(
            "feature.files-editor",
            "session-diff-stats",
            Read,
            json!({"type": "object", "properties": {
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["sessionId"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "session-diff-stats"),
        ),
        operation(
            "feature.files-editor",
            "accept-or-reject-file",
            Write,
            json!({"type": "object", "properties": {
                "decision": {"type": "string", "enum": ["accept_file", "reject_file", "accept_session"]},
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "filePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["decision", "sessionId"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "accept-or-reject-file"),
        ),
        operation(
            "feature.files-editor",
            "rollback-session-turn",
            Destructive,
            json!({"type": "object", "properties": {
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "turnIndex": {"type": "integer", "minimum": 0},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["sessionId", "turnIndex"], "additionalProperties": false}),
            &[],
            operation_provider("review-ops", "rollback-session-turn"),
        ),
        // ── ai-policy-ops (models / permissions / web-search) ─────────────
        operation(
            "setting.ai.models",
            "list-catalog",
            Read,
            empty_input(),
            &[],
            operation_provider("ai-policy-ops", "list-catalog"),
        ),
        operation(
            "setting.ai.models",
            "list-model-pools",
            Read,
            json!({"type": "object", "properties": {
                "poolId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "list-model-pools"),
        ),
        operation(
            "setting.ai.models",
            "save-model-pool",
            Write,
            json!({"type": "object", "properties": {
                "pool": {"type": "object", "description": "ModelPoolDefinition object"}
            }, "required": ["pool"], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "save-model-pool"),
        ),
        operation(
            "setting.ai.models",
            "delete-model-pool",
            Destructive,
            json!({"type": "object", "properties": {
                "poolId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["poolId"], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "delete-model-pool"),
        ),
        operation(
            "setting.ai.models",
            "set-task-model",
            Write,
            json!({"type": "object", "properties": {
                "task": {"type": "string", "minLength": 1, "maxLength": 128},
                "selection": {"type": "object", "description": "{kind:'inherit'} or {kind:'fixed', model_id:'...'}"}
            }, "required": ["task", "selection"], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "set-task-model"),
        ),
        operation(
            "setting.ai.models",
            "set-default-models",
            Write,
            json!({"type": "object", "properties": {
                "primary": {"type": "string", "minLength": 1, "maxLength": 256},
                "fast": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "set-default-models"),
        ),
        operation(
            "setting.ai.permissions",
            "get-permissions",
            Read,
            empty_input(),
            &[],
            operation_provider("ai-policy-ops", "get-permissions"),
        ),
        operation(
            "setting.ai.permissions",
            "set-permission-mode",
            Write,
            json!({"type": "object", "properties": {
                "mode": {"type": "string", "enum": ["ask", "auto", "full_access"]}
            }, "required": ["mode"], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "set-permission-mode"),
        ),
        operation(
            "setting.ai.permissions",
            "upsert-permission-rule",
            Write,
            json!({"type": "object", "properties": {
                "index": {"type": "integer", "minimum": 0},
                "rule": {"type": "object", "description": "{action, resource, effect}"}
            }, "required": ["rule"], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "upsert-permission-rule"),
        ),
        operation(
            "setting.ai.permissions",
            "delete-permission-rule",
            Destructive,
            json!({"type": "object", "properties": {
                "index": {"type": "integer", "minimum": 0},
                "expected": {"type": "object"}
            }, "required": ["index"], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "delete-permission-rule"),
        ),
        operation(
            "setting.ai.permissions",
            "set-device-dispatch-policy",
            Write,
            json!({"type": "object", "properties": {
                "acceptDispatch": {"type": "boolean"},
                "allowAutoApproval": {"type": "boolean"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "set-device-dispatch-policy"),
        ),
        operation(
            "setting.tools.web-search",
            "get-web-search-status",
            Read,
            empty_input(),
            &[],
            operation_provider("ai-policy-ops", "get-web-search-status"),
        ),
        operation(
            "setting.tools.web-search",
            "set-web-search-provider",
            Write,
            json!({"type": "object", "properties": {
                "provider": {"type": "string", "minLength": 1, "maxLength": 64},
                "endpoint": {"type": "string", "minLength": 1, "maxLength": 1024},
                "protocol": {"type": "string", "minLength": 1, "maxLength": 64}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("ai-policy-ops", "set-web-search-provider"),
        ),
        // ── agent-assistant-ops (agents / assistants / memory) ────────────
        operation(
            "feature.agents",
            "list-agents",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "list-agents"),
        ),
        operation(
            "feature.agents",
            "get-agent-detail",
            Read,
            json!({"type": "object", "properties": {
                "agentId": {"type": "string", "minLength": 1, "maxLength": 128},
                "isSubagent": {"type": "boolean"},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["agentId"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "get-agent-detail"),
        ),
        operation(
            "feature.agents",
            "create-agent",
            Write,
            json!({"type": "object", "properties": {
                "kind": {"type": "string", "enum": ["mode", "subagent"]},
                "id": {"type": "string", "minLength": 1, "maxLength": 128},
                "name": {"type": "string", "minLength": 1, "maxLength": 128},
                "description": {"type": "string", "minLength": 1, "maxLength": 2048},
                "prompt": {"type": "string", "minLength": 1, "maxLength": 65536},
                "level": {"type": "string", "enum": ["user", "project"]},
                "tools": {"type": "array", "items": {"type": "string", "minLength": 1}},
                "readonly": {"type": "boolean"},
                "review": {"type": "boolean"},
                "model": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["kind", "id", "name", "description", "prompt"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "create-agent"),
        ),
        operation(
            "feature.agents",
            "update-agent",
            Write,
            json!({"type": "object", "properties": {
                "agentId": {"type": "string", "minLength": 1, "maxLength": 128},
                "isSubagent": {"type": "boolean"},
                "payload": {"type": "object"}
            }, "required": ["agentId", "payload"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "update-agent"),
        ),
        operation(
            "feature.agents",
            "delete-agent",
            Destructive,
            json!({"type": "object", "properties": {
                "agentId": {"type": "string", "minLength": 1, "maxLength": 128},
                "isSubagent": {"type": "boolean"},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["agentId"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "delete-agent"),
        ),
        operation(
            "feature.personal-assistants",
            "list-assistants",
            Read,
            empty_input(),
            &[],
            operation_provider("agent-assistant-ops", "list-assistants"),
        ),
        operation(
            "feature.personal-assistants",
            "create-assistant",
            Write,
            json!({"type": "object", "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 128}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "create-assistant"),
        ),
        operation(
            "feature.personal-assistants",
            "set-assistant-identity",
            Write,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "name": {"type": "string", "minLength": 1, "maxLength": 128},
                "role": {"type": "string", "minLength": 1, "maxLength": 256},
                "creature": {"type": "string", "minLength": 1, "maxLength": 128},
                "vibe": {"type": "string", "minLength": 1, "maxLength": 256},
                "emoji": {"type": "string", "minLength": 1, "maxLength": 32}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "set-assistant-identity"),
        ),
        operation(
            "feature.personal-assistants",
            "set-primary-assistant",
            Write,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "set-primary-assistant"),
        ),
        operation(
            "feature.personal-assistants",
            "reset-assistant",
            Destructive,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "reset-assistant"),
        ),
        operation(
            "feature.personal-assistants",
            "delete-assistant",
            Destructive,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": ["workspaceId"], "additionalProperties": false}),
            &[],
            operation_provider("agent-assistant-ops", "delete-assistant"),
        ),
        operation(
            "setting.ai.memory",
            "get-memory-paths",
            Read,
            empty_input(),
            &[],
            operation_provider("agent-assistant-ops", "get-memory-paths"),
        ),
        operation(
            "setting.ai.memory",
            "reset-memory",
            Destructive,
            empty_input(),
            &[],
            operation_provider("agent-assistant-ops", "reset-memory"),
        ),
        // ── automation-data-ops (computer-use / miniapp market / home / data)
        operation(
            "feature.computer-use",
            "computer-use-status",
            Read,
            json!({"type": "object", "properties": {
                "port": {"type": "integer", "minimum": 1, "maximum": 65535}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "computer-use-status"),
        ),
        operation(
            "feature.computer-use",
            "request-os-permission",
            Execute,
            json!({"type": "object", "properties": {
                "kind": {"type": "string", "enum": ["accessibility", "screen_recording", "input_monitoring"]},
                "openSettingsPane": {"type": "string", "enum": ["accessibility", "screen_capture", "input_monitoring"]}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "request-os-permission"),
        ),
        operation(
            "feature.computer-use",
            "launch-browser",
            Execute,
            json!({"type": "object", "properties": {
                "port": {"type": "integer", "minimum": 1, "maximum": 65535},
                "enableDefaultCdp": {"type": "boolean"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "launch-browser"),
        ),
        operation(
            "feature.computer-use",
            "disconnect-browser",
            Write,
            json!({"type": "object", "properties": {
                "port": {"type": "integer", "minimum": 1, "maximum": 65535}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "disconnect-browser"),
        ),
        operation(
            "feature.computer-use",
            "control-session-status",
            Read,
            empty_input(),
            &[],
            operation_provider("automation-data-ops", "control-session-status"),
        ),
        operation(
            "feature.computer-use",
            "stop-control-session",
            Destructive,
            json!({"type": "object", "properties": {
                "generation": {"type": "integer", "minimum": 0}
            }, "required": ["generation"], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "stop-control-session"),
        ),
        operation(
            "feature.miniapps",
            "browse-miniapp-market",
            Read,
            json!({"type": "object", "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 256},
                "category": {"type": "string", "minLength": 1, "maxLength": 128},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                "cursor": {"type": "string", "minLength": 1, "maxLength": 512}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "browse-miniapp-market"),
        ),
        operation(
            "feature.miniapps",
            "install-market-miniapp",
            Execute,
            json!({"type": "object", "properties": {
                "slug": {"type": "string", "minLength": 1, "maxLength": 256},
                "releaseNumber": {"type": "integer", "minimum": 1},
                "existingAppId": {"type": "string", "minLength": 1, "maxLength": 256},
                "confirmPermissions": {"type": "boolean"},
                "confirmOverwrite": {"type": "boolean"}
            }, "required": ["slug", "releaseNumber"], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "install-market-miniapp"),
        ),
        operation(
            "feature.miniapps",
            "call-miniapp-worker",
            Execute,
            json!({"type": "object", "properties": {
                "appId": {"type": "string", "minLength": 1, "maxLength": 256},
                "method": {"type": "string", "minLength": 1, "maxLength": 256},
                "params": {"type": "object"}
            }, "required": ["appId", "method"], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "call-miniapp-worker"),
        ),
        operation(
            "feature.home-search",
            "personal-overview",
            Read,
            json!({"type": "object", "properties": {
                "timeZone": {"type": "string", "minLength": 1, "maxLength": 128}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "personal-overview"),
        ),
        operation(
            "feature.home-search",
            "search-sessions",
            Read,
            json!({"type": "object", "properties": {
                "query": {"type": "string", "minLength": 1, "maxLength": 1024},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100}
            }, "required": ["query"], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "search-sessions"),
        ),
        operation(
            "feature.insights",
            "list-insights",
            Read,
            json!({"type": "object", "properties": {
                "days": {"type": "integer", "minimum": 1, "maximum": 365}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "list-insights"),
        ),
        operation(
            "feature.insights",
            "load-insights-report",
            Read,
            json!({"type": "object", "properties": {
                "path": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["path"], "additionalProperties": false}),
            &[("path", ProductHostLocal)],
            operation_provider("automation-data-ops", "load-insights-report"),
        ),
        operation(
            "feature.insights",
            "generate-insights",
            Execute,
            json!({"type": "object", "properties": {
                "days": {"type": "integer", "minimum": 1, "maximum": 365},
                "modelId": {"type": "string", "minLength": 1, "maxLength": 256},
                "generationId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "generate-insights"),
        ),
        operation(
            "feature.insights",
            "cancel-insights",
            Write,
            json!({"type": "object", "properties": {
                "generationId": {"type": "string", "minLength": 1, "maxLength": 256}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "cancel-insights"),
        ),
        operation(
            "setting.data.usage",
            "get-usage-stats",
            Read,
            json!({"type": "object", "properties": {
                "request": {"type": "object", "description": "Optional TokenUsageStatisticsRequest filter"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "get-usage-stats"),
        ),
        operation(
            "setting.data.usage",
            "get-activity-heatmap",
            Read,
            json!({"type": "object", "properties": {
                "request": {"type": "object", "description": "Optional TokenUsageActivityRequest filter"}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "get-activity-heatmap"),
        ),
        operation(
            "setting.data.archived",
            "list-archived-sessions",
            Read,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "list-archived-sessions"),
        ),
        operation(
            "setting.data.archived",
            "unarchive-session",
            Write,
            json!({"type": "object", "properties": {
                "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": ["sessionId"], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "unarchive-session"),
        ),
        operation(
            "setting.data.archived",
            "delete-all-archived-sessions",
            Destructive,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "workspacePath": {"type": "string", "minLength": 1, "maxLength": 4096}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "delete-all-archived-sessions"),
        ),
        operation(
            "setting.data.storage",
            "inspect-snapshot-storage",
            Read,
            json!({"type": "object", "properties": {
                "period": {"type": "string", "minLength": 1, "maxLength": 64}
            }, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "inspect-snapshot-storage"),
        ),
        operation(
            "setting.data.storage",
            "clean-snapshot-storage",
            Destructive,
            json!({"type": "object", "properties": {
                "workspaceId": {"type": "string", "minLength": 1, "maxLength": 256},
                "period": {"type": "string", "minLength": 1, "maxLength": 64},
                "candidates": {"type": "array", "items": {"type": "object"}}
            }, "required": ["workspaceId", "period", "candidates"], "additionalProperties": false}),
            &[],
            operation_provider("automation-data-ops", "clean-snapshot-storage"),
        ),
        operation(
            "setting.data.diagnostics",
            "runtime-diagnostics-info",
            Read,
            empty_input(),
            &[],
            operation_provider("automation-data-ops", "runtime-diagnostics-info"),
        ),
        operation(
            "setting.data.diagnostics",
            "export-diagnostics-bundle",
            Execute,
            empty_input(),
            &[],
            operation_provider("automation-data-ops", "export-diagnostics-bundle"),
        ),
        operation(
            "feature.remote-connect",
            "status",
            Read,
            json!({"type": "object", "properties": {}, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("remote-connect", "status"),
        ),
        operation(
            "feature.remote-connect",
            "start",
            Write,
            json!({"type": "object", "properties": {"method": {"type": "string", "enum": ["weixin", "telegram", "feishu", "mobile_web", "lan"]}, "lanIp": {"type": "string"}}, "required": ["method"], "additionalProperties": false}),
            &[],
            operation_provider("remote-connect", "start"),
        ),
        operation(
            "feature.remote-connect",
            "stop",
            Write,
            json!({"type": "object", "properties": {"method": {"type": "string", "enum": ["weixin", "telegram", "feishu", "mobile_web", "lan"]}}, "required": ["method"], "additionalProperties": false}),
            &[],
            operation_provider("remote-connect", "stop"),
        ),
        operation(
            "feature.remote-connect",
            "configure-bot",
            Write,
            json!({"type": "object", "properties": {"method": {"type": "string", "enum": ["weixin", "telegram", "feishu"]}, "credentialsFile": {"type": "string", "minLength": 1}}, "required": ["method", "credentialsFile"], "additionalProperties": false}),
            &[("credentialsFile", ProductHostLocal)],
            operation_provider("remote-connect", "configure-bot"),
        ),
        operation(
            "feature.remote-connect",
            "weixin-login-start",
            Write,
            json!({"type": "object", "properties": {}, "required": [], "additionalProperties": false}),
            &[],
            operation_provider("remote-connect", "weixin-login-start"),
        ),
        operation(
            "feature.remote-connect",
            "weixin-login-poll",
            Write,
            json!({"type": "object", "properties": {"sessionKey": {"type": "string", "minLength": 1}, "verifyCode": {"type": "string"}}, "required": ["sessionKey"], "additionalProperties": false}),
            &[],
            operation_provider("remote-connect", "weixin-login-poll"),
        ),
        operation(
            "feature.remote-connect",
            "set-bot-verbose",
            Write,
            json!({"type": "object", "properties": {"enabled": {"type": "boolean"}}, "required": ["enabled"], "additionalProperties": false}),
            &[],
            operation_provider("remote-connect", "set-bot-verbose"),
        ),
        operation(
            "setting.tools.mcp",
            "list-servers",
            Read,
            mcp_input("list"),
            &[],
            operation_provider("mcp", "list"),
        ),
        operation(
            "setting.tools.mcp",
            "configure-server",
            Write,
            mcp_input("configure"),
            &[("workingDirectory", ProductHostLocal)],
            operation_provider("mcp", "configure"),
        ),
        operation(
            "setting.tools.mcp",
            "delete-server",
            Destructive,
            mcp_input("delete"),
            &[],
            operation_provider("mcp", "delete"),
        ),
        operation(
            "setting.tools.mcp",
            "start-server",
            Write,
            mcp_input("start"),
            &[],
            operation_provider("mcp", "start"),
        ),
        operation(
            "setting.tools.mcp",
            "stop-server",
            Write,
            mcp_input("stop"),
            &[],
            operation_provider("mcp", "stop"),
        ),
        operation(
            "setting.tools.mcp",
            "restart-server",
            Write,
            mcp_input("restart"),
            &[],
            operation_provider("mcp", "restart"),
        ),
        operation(
            "feature.miniapps",
            "list-apps",
            Read,
            miniapp_input("list"),
            &[],
            operation_provider("miniapp", "list"),
        ),
        operation(
            "feature.miniapps",
            "inspect-app",
            Read,
            miniapp_input("inspect"),
            &[],
            operation_provider("miniapp", "inspect"),
        ),
        operation(
            "feature.miniapps",
            "create-app",
            Write,
            miniapp_input("create"),
            &[],
            operation_provider("miniapp", "create"),
        ),
        operation(
            "feature.miniapps",
            "update-app",
            Write,
            miniapp_input("update"),
            &[],
            operation_provider("miniapp", "update"),
        ),
        operation(
            "feature.miniapps",
            "delete-app",
            Destructive,
            miniapp_input("delete"),
            &[],
            operation_provider("miniapp", "delete"),
        ),
        operation(
            "feature.ai-assistant",
            "new-session",
            Ui,
            empty_input(),
            &[],
            product_action("session.new"),
        ),
        operation(
            "feature.projects",
            "open-project",
            Ui,
            empty_input(),
            &[],
            product_action("project.open"),
        ),
        operation(
            "feature.projects",
            "new-project",
            Ui,
            empty_input(),
            &[],
            product_action("project.new"),
        ),
        operation(
            "feature.terminal",
            "new-terminal",
            Ui,
            empty_input(),
            &[],
            product_action("surface.terminal.open"),
        ),
        option(
            "setting.application.general",
            "launch-at-login",
            boolean(),
            provider("desktop-lifecycle", "launch-at-login"),
        ),
        option(
            "setting.application.general",
            "prevent-sleep",
            boolean(),
            provider("desktop-lifecycle", "prevent-sleep"),
        ),
        option(
            "setting.application.general",
            "auto-update",
            boolean(),
            config("app.auto_update"),
        ),
        option(
            "setting.application.general",
            "close-button-behavior",
            string_enum(&["ask", "minimize_to_tray", "quit"]),
            config("app.close_button_behavior"),
        ),
        option(
            "setting.application.general",
            "completion-notification",
            boolean(),
            config("app.notifications.dialog_completion_notify"),
        ),
        option(
            "setting.application.general",
            "permission-notification",
            boolean(),
            config("app.notifications.permission_request_notify"),
        ),
        option(
            "setting.application.appearance",
            "theme",
            string(),
            AppearanceSelection,
        ),
        option(
            "setting.application.appearance",
            "language",
            string(),
            Language,
        ),
        option(
            "setting.application.pet",
            "enabled",
            boolean(),
            merge_config("app.ai_experience", &["enable_agent_companion"]),
        ),
        option(
            "setting.application.pet",
            "desktop-cards-enabled",
            boolean(),
            merge_config("app.ai_experience", &["enable_desktop_cards"]),
        ),
        operation(
            "setting.application.pet",
            "list-pets",
            Read,
            empty_input(),
            &[],
            operation_provider("agent-companion-pet", "list"),
        ),
        operation(
            "setting.application.pet",
            "use-pet",
            Write,
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "path": { "type": "string", "minLength": 1, "description": "Local Petdex directory or archive path." },
                    "id": { "type": "string", "minLength": 1, "description": "Already imported pet ID." }
                },
                "anyOf": [{ "required": ["path"] }, { "required": ["id"] }]
            }),
            &[("path", ProductHostLocal)],
            operation_provider("agent-companion-pet", "use"),
        ),
        operation(
            "setting.application.pet",
            "delete-pet",
            Destructive,
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": { "type": "string", "minLength": 1, "description": "Imported pet ID." },
                    "packagePath": { "type": "string", "minLength": 1, "description": "Imported OpenBitFun pet-package directory." }
                },
                "anyOf": [{ "required": ["id"] }, { "required": ["packagePath"] }]
            }),
            &[("packagePath", ProductHostLocal)],
            operation_provider("agent-companion-pet", "delete"),
        ),
        option(
            "setting.application.input",
            "voice-enabled",
            boolean(),
            merge_config("app.ai_experience", &["voice_input.enabled"]),
        ),
        option(
            "setting.application.input",
            "auto-show-selection-toolbar",
            boolean(),
            config("app.flow_chat.auto_show_selection_toolbar"),
        ),
        option(
            "setting.application.input",
            "voice-language",
            string_enum(&["auto", "zh", "en", "ja", "yue"]),
            merge_config("app.ai_experience", &["voice_input.default_language"]),
        ),
        option(
            "setting.application.input",
            "max-recording-seconds",
            integer_range(10.0, 600.0),
            merge_config("app.ai_experience", &["voice_input.max_recording_seconds"]),
        ),
        option(
            "setting.application.terminal",
            "terminal-default-shell",
            string(),
            config("terminal.default_shell"),
        ),
        option(
            "setting.application.terminal",
            "terminal-panel-position",
            string_enum(&["right", "bottom"]),
            config("terminal.terminal_panel_position"),
        ),
        option(
            "setting.application.development",
            "editor-font-family",
            string(),
            config("editor.font_family"),
        ),
        option(
            "setting.application.development",
            "editor-font-weight",
            string_enum(&["normal", "bold"]),
            config("editor.font_weight"),
        ),
        option(
            "setting.application.development",
            "editor-font-size",
            integer_range(10.0, 32.0),
            config("editor.font_size"),
        ),
        option(
            "setting.application.development",
            "editor-line-height",
            number_range(1.0, 3.0),
            config("editor.line_height"),
        ),
        option(
            "setting.application.development",
            "editor-cursor-style",
            string_enum(&[
                "line",
                "line-thin",
                "block",
                "block-outline",
                "underline",
                "underline-thin",
            ]),
            config("editor.cursor_style"),
        ),
        option(
            "setting.application.development",
            "editor-cursor-blinking",
            string_enum(&["blink", "smooth", "phase", "expand", "solid"]),
            config("editor.cursor_blinking"),
        ),
        option(
            "setting.application.development",
            "editor-tab-size",
            integer_range(1.0, 8.0),
            config("editor.tab_size"),
        ),
        option(
            "setting.application.development",
            "editor-insert-spaces",
            boolean(),
            config("editor.insert_spaces"),
        ),
        option(
            "setting.application.development",
            "editor-detect-indentation",
            boolean(),
            config("editor.detect_indentation"),
        ),
        option(
            "setting.application.development",
            "editor-word-wrap",
            string_enum(&["off", "on", "wordWrapColumn", "bounded"]),
            config("editor.word_wrap"),
        ),
        option(
            "setting.application.development",
            "editor-line-numbers",
            string_enum(&["on", "off", "relative", "interval"]),
            config("editor.line_numbers"),
        ),
        option(
            "setting.application.development",
            "editor-smooth-scrolling",
            boolean(),
            config("editor.smooth_scrolling"),
        ),
        option(
            "setting.application.development",
            "editor-minimap-enabled",
            boolean(),
            config("editor.minimap.enabled"),
        ),
        option(
            "setting.application.development",
            "editor-minimap-side",
            string_enum(&["left", "right"]),
            config("editor.minimap.side"),
        ),
        option(
            "setting.application.development",
            "editor-minimap-size",
            string_enum(&["proportional", "fill", "fit"]),
            config("editor.minimap.size"),
        ),
        option(
            "setting.application.development",
            "editor-render-whitespace",
            string_enum(&["none", "boundary", "selection", "trailing", "all"]),
            config("editor.render_whitespace"),
        ),
        option(
            "setting.application.development",
            "editor-render-line-highlight",
            string_enum(&["none", "gutter", "line", "all"]),
            config("editor.render_line_highlight"),
        ),
        option(
            "setting.application.development",
            "editor-scroll-beyond-last-line",
            boolean(),
            config("editor.scroll_beyond_last_line"),
        ),
        option(
            "setting.application.development",
            "editor-auto-save",
            string_enum(&["off", "afterDelay", "onFocusChange", "onWindowChange"]),
            config("editor.auto_save"),
        ),
        option(
            "setting.application.development",
            "editor-auto-save-delay",
            integer_range(100.0, 60_000.0),
            config("editor.auto_save_delay"),
        ),
        option(
            "setting.application.development",
            "editor-semantic-highlighting",
            boolean(),
            config("editor.semantic_highlighting"),
        ),
        option(
            "setting.application.development",
            "editor-bracket-pair-colorization",
            boolean(),
            config("editor.bracket_pair_colorization"),
        ),
        option(
            "setting.application.development",
            "editor-format-on-save",
            boolean(),
            config("editor.format_on_save"),
        ),
        option(
            "setting.application.development",
            "editor-format-on-paste",
            boolean(),
            config("editor.format_on_paste"),
        ),
        option(
            "setting.application.development",
            "editor-trim-auto-whitespace",
            boolean(),
            config("editor.trim_auto_whitespace"),
        ),
        option(
            "setting.ai.models",
            "stream-ttft-timeout-seconds",
            nullable_integer_range(1.0, 86_400.0),
            config("ai.stream_ttft_timeout_secs"),
        ),
        option(
            "setting.ai.models",
            "stream-idle-timeout-seconds",
            nullable_integer_range(1.0, 86_400.0),
            config("ai.stream_idle_timeout_secs"),
        ),
        option(
            "setting.ai.memory",
            "enabled",
            boolean(),
            merge_config("memories", &["generate_memories", "use_memories"]),
        ),
        option(
            "setting.ai.memory",
            "btw-sessions",
            boolean(),
            merge_config("memories", &["generate_for_btw_sessions"]),
        ),
        option(
            "setting.ai.memory",
            "external-context-policy",
            string_enum(&["clear_tool_results", "allow", "skip_session"]),
            merge_config("memories", &["external_context_policy"]),
        ),
        option(
            "setting.ai.memory",
            "minimum-rollout-idle-hours",
            integer_range(1.0, 48.0),
            merge_config("memories", &["min_rollout_idle_hours"]),
        ),
        option(
            "setting.ai.memory",
            "maximum-rollout-age-days",
            integer_range(0.0, 90.0),
            merge_config("memories", &["max_rollout_age_days"]),
        ),
        option(
            "setting.ai.memory",
            "startup-rollout-limit",
            integer_range(1.0, 128.0),
            merge_config("memories", &["max_rollouts_per_startup"]),
        ),
        option(
            "setting.ai.memory",
            "startup-rollout-scan-limit",
            integer_range(1.0, 50_000.0),
            merge_config("memories", &["max_rollouts_scan_limit"]),
        ),
        option(
            "setting.ai.memory",
            "extraction-concurrency",
            integer_range(1.0, 16.0),
            merge_config("memories", &["phase1_max_concurrency"]),
        ),
        option(
            "setting.ai.memory",
            "raw-memory-limit",
            integer_range(1.0, 4096.0),
            merge_config("memories", &["max_raw_memories_for_consolidation"]),
        ),
        option(
            "setting.ai.memory",
            "memory-retention-days",
            integer_range(0.0, 365.0),
            merge_config("memories", &["max_unused_days"]),
        ),
        option(
            "setting.workspace.session",
            "session-title-generation",
            boolean(),
            merge_config("app.ai_experience", &["enable_session_title_generation"]),
        ),
        option(
            "setting.workspace.session",
            "prompt-suggestion",
            boolean(),
            merge_config("app.ai_experience", &["enable_prompt_suggestion"]),
        ),
        option(
            "setting.workspace.session",
            "workspace-search",
            boolean(),
            merge_config("app.ai_experience", &["enable_workspace_search"]),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-root-path",
            string_length(1, 4096),
            config("app.worktrees.rootPath"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-branch-prefix",
            string_length(1, 200),
            config("app.worktrees.branchPrefix"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-copy-local-changes",
            boolean(),
            config("app.worktrees.copyLocalChanges"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-auto-delete-enabled",
            boolean(),
            config("app.worktrees.autoDeleteEnabled"),
        ),
        option(
            "setting.workspace.worktrees",
            "worktree-auto-delete-limit",
            integer_range(1.0, 100.0),
            config("app.worktrees.autoDeleteLimit"),
        ),
        option(
            "setting.tools.execution",
            "show-permission-mode-control",
            boolean(),
            FlowChatPermissionModeControl,
        ),
        option(
            "setting.tools.execution",
            "deferred-tool-loading",
            boolean(),
            config("ai.enable_deferred_tool_loading"),
        ),
        option(
            "setting.tools.execution",
            "tool-presentation-mode",
            string_enum(&["native", "ptc", "ptc_python"]),
            config("ai.tool_presentation_mode"),
        ),
        option(
            "setting.tools.execution",
            "subagent-model-override",
            boolean(),
            config("ai.allow_subagent_model_override"),
        ),
        option(
            "setting.tools.execution",
            "subagent-batch-policy",
            string_enum(&["safe_only", "force_parallel", "serial"]),
            config("ai.subagent_batch_execution_policy"),
        ),
        option(
            "setting.tools.execution",
            "subagent-max-concurrency",
            integer_range(1.0, 32.0),
            config("ai.subagent_max_concurrency"),
        ),
        option(
            "setting.tools.execution",
            "swarm-max-concurrency",
            integer_range(1.0, 64.0),
            config("ai.swarm_max_concurrency"),
        ),
        option(
            "setting.tools.execution",
            "tool-timeout-seconds",
            nullable_integer_range(1.0, 86_400.0),
            config("ai.tool_execution_timeout_secs"),
        ),
        option(
            "setting.tools.execution",
            "computer-use-enabled",
            boolean(),
            config("ai.computer_use_enabled"),
        ),
        option(
            "setting.tools.execution",
            "browser-auto-connect",
            boolean(),
            config("ai.browser_control_auto_connect_on_startup"),
        ),
        option(
            "setting.tools.execution",
            "tool-json-repair",
            boolean(),
            config("ai.allow_tool_json_repair"),
        ),
        option(
            "setting.tools.automation",
            "hooks-enabled",
            boolean(),
            merge_config("app.hooks", &["enabled"]),
        ),
        option(
            "setting.tools.automation",
            "project-hooks-enabled",
            boolean(),
            merge_config("app.hooks", &["project_hooks_enabled"]),
        ),
        option(
            "setting.data.diagnostics",
            "log-level",
            string_enum(&["error", "warn", "info", "debug", "trace", "off"]),
            config("app.logging.level"),
        ),
        option(
            "setting.data.diagnostics",
            "sensitive-diagnostics",
            boolean(),
            config("app.logging.include_sensitive_diagnostics"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn owner_definition_ids_are_unique() {
        let mut ids = BTreeSet::new();
        for definition in owner_definitions() {
            let id = match definition {
                ProductControlOwnerDefinition::Option {
                    capability_id,
                    option_id,
                    ..
                } => format!("{capability_id}:option:{option_id}"),
                ProductControlOwnerDefinition::Operation {
                    capability_id,
                    operation_id,
                    ..
                } => format!("{capability_id}:operation:{operation_id}"),
            };
            assert!(ids.insert(id.clone()), "duplicate owner definition: {id}");
        }
    }

    #[test]
    fn capability_op_metadata_matches_owner_definitions() {
        use crate::product_capability_ops::{is_capability_op_provider, CAPABILITY_OP_METADATA};
        let mut from_owners = BTreeSet::new();
        for definition in owner_definitions() {
            if let ProductControlOwnerDefinition::Operation {
                handler:
                    ProductCapabilityOperationHandler::Provider {
                        provider_id,
                        operation_id,
                    },
                ..
            } = definition
            {
                if is_capability_op_provider(&provider_id) {
                    assert!(
                        from_owners.insert((provider_id.clone(), operation_id.clone())),
                        "duplicate provider operation {provider_id}:{operation_id}"
                    );
                }
            }
        }
        let from_meta: BTreeSet<(String, String)> = CAPABILITY_OP_METADATA
            .iter()
            .map(|(p, op, _, _, _)| ((*p).to_string(), (*op).to_string()))
            .collect();
        assert_eq!(from_owners, from_meta);
    }
}
