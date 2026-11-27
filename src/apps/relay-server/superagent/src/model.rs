//! Model rounds relayed to an account device: the server holds no model
//! credentials. A [`ModelHolder`] runs one round on one device; the turn
//! loop picks the device (`policy::rank_model_holders`) and retries a round
//! on the next holder when one is lost.
//!
//! The relay wire (owner verbs on desktop and CLI, admitted only for the
//! `CloudAgent` scope, advertised as `fleet_model_v1`):
//!
//! - `fleet_model_start {requestId, model?, system, messages, tools,
//!   maxOutputTokens}` -> `{requestId}` (idempotent on `requestId`);
//! - `fleet_model_poll {requestId, afterSeq, waitMs <= 25000}` ->
//!   `{chunks: [{seq, text}], done, result?: {text, toolCalls: [{id, name,
//!   arguments}], usage?, stopReason?}, error?}` (resumable: a lost poll is
//!   repeated with the same `afterSeq`);
//! - `fleet_model_cancel {requestId}`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::device::{BoxFuture, DeviceRpc, RpcError};

/// Longest a single poll waits on the device.
pub const POLL_WAIT_MS: u64 = 25_000;
/// Consecutive transport failures before the holder counts as lost.
const POLL_RETRIES: u32 = 3;
/// Absolute wall-clock ceiling for one relayed model round.
pub const DEFAULT_MAX_ROUND_DURATION: Duration = Duration::from_secs(600);
/// Longest a round may run without receiving any non-empty chunk or completion.
pub const DEFAULT_MAX_IDLE_POLL_DURATION: Duration = Duration::from_secs(120);
/// Maximum cumulative streamed delta bytes accepted in one model round.
pub const DEFAULT_MAX_DELTA_BYTES: usize = 2 * 1024 * 1024;
/// Maximum tool calls accepted from one model reply.
pub const DEFAULT_MAX_TOOL_CALLS: usize = 32;
/// Backoff when a holder answers an empty non-done poll in under one second,
/// preventing CPU spin loops against a hostile or broken device.
const DEFAULT_EMPTY_POLL_BACKOFF: Duration = Duration::from_millis(250);
const FAST_EMPTY_POLL_THRESHOLD: Duration = Duration::from_secs(1);

/// Error code prefix emitted when a round is aborted for exceeding its idle or
/// total wall-clock ceiling (used by the engine to apply per-account cooldown).
pub const MODEL_ROUND_TIMEOUT_CODE: &str = "fleet_model_round_timeout";

/// Bounds enforced per relayed model round to prevent hostile or stalled
/// holders from pinning global concurrency slots or flooding memory.
#[derive(Debug, Clone)]
pub struct RelayModelLimits {
    pub max_round_duration: Duration,
    pub max_idle_poll_duration: Duration,
    pub max_delta_bytes: usize,
    pub max_tool_calls: usize,
    pub empty_poll_backoff: Duration,
}

impl Default for RelayModelLimits {
    fn default() -> Self {
        Self {
            max_round_duration: DEFAULT_MAX_ROUND_DURATION,
            max_idle_poll_duration: DEFAULT_MAX_IDLE_POLL_DURATION,
            max_delta_bytes: DEFAULT_MAX_DELTA_BYTES,
            max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
            empty_poll_backoff: DEFAULT_EMPTY_POLL_BACKOFF,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub system: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelReply {
    pub text: String,
    pub tool_calls: Vec<ModelToolCall>,
    pub usage: Value,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    /// The holder went away mid-round; try the next one.
    HolderLost(String),
    /// The holder answered with a model error (bad request, quota): the
    /// round fails instead of moving to another device.
    Failed(String),
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HolderLost(m) | Self::Failed(m) => f.write_str(m),
        }
    }
}

/// Streamed text of a round, as it arrives.
pub type DeltaSink = Arc<dyn Fn(&str) + Send + Sync>;

pub trait ModelHolder: Send + Sync + 'static {
    fn run<'a>(
        &'a self,
        account_id: &'a str,
        holder: &'a str,
        request: &'a ModelRequest,
        deltas: DeltaSink,
    ) -> BoxFuture<'a, Result<ModelReply, ModelError>>;

    fn cancel<'a>(
        &'a self,
        account_id: &'a str,
        holder: &'a str,
        request_id: &'a str,
    ) -> BoxFuture<'a, ()>;
}

/// The real holder: `fleet_model_*` over the device RPC.
pub struct RelayModel {
    rpc: Arc<dyn DeviceRpc>,
    limits: RelayModelLimits,
}

impl RelayModel {
    pub fn new(rpc: Arc<dyn DeviceRpc>) -> Self {
        Self::with_limits(rpc, RelayModelLimits::default())
    }

    pub fn with_limits(rpc: Arc<dyn DeviceRpc>, limits: RelayModelLimits) -> Self {
        Self { rpc, limits }
    }
}

/// A tool call as the relay carries it (arguments are JSON text).
pub fn relay_tool_call(call: &ModelToolCall) -> Value {
    let arguments = match &call.arguments {
        Value::Null => "{}".to_string(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    json!({ "id": call.id, "name": call.name, "arguments": arguments })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PollChunk {
    seq: u64,
    text: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RelayToolCallWire {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RelayErrorWire {
    code: String,
    message: String,
}

/// `RelayResult` of the device side (`superagent_relay::dto`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RelayResultWire {
    text: String,
    tool_calls: Vec<RelayToolCallWire>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    error: Option<RelayErrorWire>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PollAnswer {
    chunks: Vec<PollChunk>,
    done: bool,
    result: Option<RelayResultWire>,
}

fn is_holder_lost_refusal(code_or_message: &str) -> bool {
    code_or_message.starts_with("fleet_model_unknown_request")
        || code_or_message.starts_with("fleet_model_busy")
        || code_or_message.starts_with("fleet_model_unavailable")
}

impl RelayResultWire {
    fn into_reply(self) -> Result<ModelReply, ModelError> {
        if let Some(error) = self.error {
            let formatted = format!("{}: {}", error.code, error.message);
            return Err(if is_holder_lost_refusal(&error.code) {
                ModelError::HolderLost(formatted)
            } else {
                ModelError::Failed(formatted)
            });
        }
        Ok(ModelReply {
            text: self.text,
            tool_calls: self
                .tool_calls
                .into_iter()
                .map(|call| ModelToolCall {
                    // Unparseable arguments reach the tool parser as text and
                    // come back to the model as invalid_arguments.
                    arguments: serde_json::from_str(&call.arguments)
                        .unwrap_or(Value::String(call.arguments)),
                    id: call.id,
                    name: call.name,
                })
                .collect(),
            usage: self.usage.unwrap_or(Value::Null),
            stop_reason: self.finish_reason,
        })
    }
}

fn lost(error: RpcError) -> ModelError {
    match error {
        // The holder forgot the request (it restarted), is busy, or its model
        // relay is unavailable: another holder runs the round.
        RpcError::Refused(message) if is_holder_lost_refusal(&message) => {
            ModelError::HolderLost(message)
        }
        RpcError::Refused(message) => ModelError::Failed(message),
        other => ModelError::HolderLost(other.message().to_string()),
    }
}

impl ModelHolder for RelayModel {
    fn run<'a>(
        &'a self,
        account_id: &'a str,
        holder: &'a str,
        request: &'a ModelRequest,
        deltas: DeltaSink,
    ) -> BoxFuture<'a, Result<ModelReply, ModelError>> {
        Box::pin(async move {
            let args =
                serde_json::to_value(request).map_err(|e| ModelError::Failed(e.to_string()))?;
            self.rpc
                .call(
                    account_id,
                    holder,
                    "fleet_model_start",
                    json!({ "request": args }),
                )
                .await
                .map_err(lost)?;
            let mut after = 0u64;
            let mut failures = 0u32;
            let mut delta_bytes = 0usize;
            let started = Instant::now();
            let mut last_progress = started;
            let round_deadline = started + self.limits.max_round_duration;
            loop {
                let now = Instant::now();
                let idle_deadline = last_progress + self.limits.max_idle_poll_duration;
                let effective_deadline = round_deadline.min(idle_deadline);
                if now >= effective_deadline {
                    self.cancel(account_id, holder, &request.request_id).await;
                    let reason = if now >= round_deadline {
                        "the model round exceeded its wall-clock time limit"
                    } else {
                        "the model holder made no progress before the idle poll limit"
                    };
                    return Err(ModelError::Failed(format!(
                        "{MODEL_ROUND_TIMEOUT_CODE}: {reason}"
                    )));
                }
                let remaining = effective_deadline.saturating_duration_since(now);
                let wait_ms = (remaining.as_millis() as u64).clamp(1, POLL_WAIT_MS);
                let poll_started = Instant::now();
                let rpc_timeout = remaining.saturating_add(Duration::from_secs(5));
                let answer = tokio::time::timeout(
                    rpc_timeout,
                    self.rpc.call(
                        account_id,
                        holder,
                        "fleet_model_poll",
                        json!({ "request": {
                            "requestId": request.request_id,
                            "afterSeq": after,
                            "waitMs": wait_ms,
                        }}),
                    ),
                )
                .await;
                let answer = match answer {
                    Ok(Ok(answer)) => {
                        failures = 0;
                        answer
                    }
                    Ok(Err(RpcError::Transport(message))) if failures + 1 < POLL_RETRIES => {
                        failures += 1;
                        log::debug!("Model poll retry: holder={}, error={}", holder, message);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    }
                    Ok(Err(error)) => return Err(lost(error)),
                    Err(_) => {
                        self.cancel(account_id, holder, &request.request_id).await;
                        return Err(ModelError::Failed(format!(
                            "{MODEL_ROUND_TIMEOUT_CODE}: model poll exceeded round deadline"
                        )));
                    }
                };
                let answer: PollAnswer = serde_json::from_value(answer)
                    .map_err(|e| ModelError::HolderLost(format!("unreadable model poll: {e}")))?;
                let mut progressed = false;
                for chunk in answer.chunks {
                    if chunk.seq > after {
                        after = chunk.seq;
                        if let Some(text) = chunk.text.filter(|text| !text.is_empty()) {
                            progressed = true;
                            delta_bytes = delta_bytes.saturating_add(text.len());
                            if delta_bytes > self.limits.max_delta_bytes {
                                self.cancel(account_id, holder, &request.request_id).await;
                                return Err(ModelError::Failed(
                                    "fleet_model_output_too_large: model round exceeded streamed output limit"
                                        .into(),
                                ));
                            }
                            deltas(&text);
                        }
                    }
                }
                if progressed {
                    last_progress = Instant::now();
                }
                if answer.done {
                    let reply = answer
                        .result
                        .ok_or_else(|| {
                            ModelError::HolderLost("the model round ended without a result".into())
                        })?
                        .into_reply()?;
                    if reply.tool_calls.len() > self.limits.max_tool_calls {
                        return Err(ModelError::Failed(format!(
                            "fleet_model_too_many_tool_calls: model reply returned {} tool calls (max {})",
                            reply.tool_calls.len(),
                            self.limits.max_tool_calls
                        )));
                    }
                    return Ok(reply);
                }
                if !progressed
                    && poll_started.elapsed() < FAST_EMPTY_POLL_THRESHOLD
                    && !self.limits.empty_poll_backoff.is_zero()
                {
                    let now = Instant::now();
                    let next_deadline =
                        round_deadline.min(last_progress + self.limits.max_idle_poll_duration);
                    if now < next_deadline {
                        let sleep_for = self
                            .limits
                            .empty_poll_backoff
                            .min(next_deadline.saturating_duration_since(now));
                        tokio::time::sleep(sleep_for).await;
                    }
                }
            }
        })
    }

    fn cancel<'a>(
        &'a self,
        account_id: &'a str,
        holder: &'a str,
        request_id: &'a str,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self
                .rpc
                .call(
                    account_id,
                    holder,
                    "fleet_model_cancel",
                    json!({ "request": { "requestId": request_id } }),
                )
                .await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::DeviceSnapshot;

    #[test]
    fn busy_and_unavailable_refusals_trigger_failover() {
        assert!(matches!(
            lost(RpcError::Refused(
                "fleet_model_busy: already running 4 rounds".into()
            )),
            ModelError::HolderLost(_)
        ));
        assert!(matches!(
            lost(RpcError::Refused(
                "fleet_model_unavailable: provider not ready".into()
            )),
            ModelError::HolderLost(_)
        ));
        assert!(matches!(
            lost(RpcError::Refused(
                "fleet_model_unknown_request: gone".into()
            )),
            ModelError::HolderLost(_)
        ));
        assert!(matches!(
            lost(RpcError::Refused(
                "fleet_model_invalid_request: bad prompt".into()
            )),
            ModelError::Failed(_)
        ));
        assert!(matches!(
            lost(RpcError::Refused(
                "fleet_model_provider_error: quota exceeded".into()
            )),
            ModelError::Failed(_)
        ));
    }

    #[test]
    fn relay_result_unavailable_and_busy_map_to_holder_lost() {
        let unavailable = RelayResultWire {
            error: Some(RelayErrorWire {
                code: "fleet_model_unavailable".into(),
                message: "no provider".into(),
            }),
            ..RelayResultWire::default()
        };
        assert!(matches!(
            unavailable.into_reply(),
            Err(ModelError::HolderLost(_))
        ));

        let busy = RelayResultWire {
            error: Some(RelayErrorWire {
                code: "fleet_model_busy".into(),
                message: "saturated".into(),
            }),
            ..RelayResultWire::default()
        };
        assert!(matches!(busy.into_reply(), Err(ModelError::HolderLost(_))));

        let provider_err = RelayResultWire {
            error: Some(RelayErrorWire {
                code: "fleet_model_provider_error".into(),
                message: "rate limited".into(),
            }),
            ..RelayResultWire::default()
        };
        assert!(matches!(
            provider_err.into_reply(),
            Err(ModelError::Failed(_))
        ));
    }

    struct StubRpc(Result<Value, RpcError>);

    impl DeviceRpc for StubRpc {
        fn devices<'a>(
            &'a self,
            _account_id: &'a str,
        ) -> BoxFuture<'a, Result<Vec<DeviceSnapshot>, RpcError>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn call<'a>(
            &'a self,
            _account_id: &'a str,
            _device_id: &'a str,
            _command: &'a str,
            _args: Value,
        ) -> BoxFuture<'a, Result<Value, RpcError>> {
            let outcome = self.0.clone();
            Box::pin(async move { outcome })
        }
    }

    #[tokio::test]
    async fn relay_model_run_maps_busy_start_to_holder_lost() {
        let model = RelayModel::new(Arc::new(StubRpc(Err(RpcError::Refused(
            "fleet_model_busy: busy".into(),
        )))));
        let request = ModelRequest {
            request_id: "r1".into(),
            model: None,
            system: String::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            max_output_tokens: 128,
        };
        let sink: DeltaSink = Arc::new(|_| {});
        let err = model
            .run("acct", "dev-1", &request, sink)
            .await
            .unwrap_err();
        assert!(matches!(err, ModelError::HolderLost(_)), "{err:?}");
    }

    struct ScriptedRpc {
        polls: std::sync::Mutex<std::collections::VecDeque<Value>>,
        cancelled: std::sync::atomic::AtomicUsize,
    }

    impl ScriptedRpc {
        fn new(polls: Vec<Value>) -> Self {
            Self {
                polls: std::sync::Mutex::new(polls.into()),
                cancelled: std::sync::atomic::AtomicUsize::new(0),
            }
        }
    }

    impl DeviceRpc for ScriptedRpc {
        fn devices<'a>(
            &'a self,
            _account_id: &'a str,
        ) -> BoxFuture<'a, Result<Vec<DeviceSnapshot>, RpcError>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn call<'a>(
            &'a self,
            _account_id: &'a str,
            _device_id: &'a str,
            command: &'a str,
            _args: Value,
        ) -> BoxFuture<'a, Result<Value, RpcError>> {
            match command {
                "fleet_model_start" => Box::pin(async { Ok(json!({ "requestId": "r1" })) }),
                "fleet_model_cancel" => {
                    self.cancelled
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Box::pin(async { Ok(json!({ "cancelled": true })) })
                }
                "fleet_model_poll" => {
                    let next = self
                        .polls
                        .lock()
                        .unwrap()
                        .pop_front()
                        .unwrap_or_else(|| json!({ "chunks": [], "done": false }));
                    Box::pin(async move { Ok(next) })
                }
                other => {
                    let msg = format!("unexpected command: {other}");
                    Box::pin(async move { Err(RpcError::Refused(msg)) })
                }
            }
        }
    }

    fn sample_request() -> ModelRequest {
        ModelRequest {
            request_id: "r1".into(),
            model: None,
            system: String::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            max_output_tokens: 128,
        }
    }

    #[tokio::test]
    async fn relay_model_aborts_infinite_empty_polls_and_cancels_holder() {
        let rpc = Arc::new(ScriptedRpc::new(Vec::new()));
        let model = RelayModel::with_limits(
            rpc.clone(),
            RelayModelLimits {
                max_round_duration: Duration::from_secs(5),
                max_idle_poll_duration: Duration::from_millis(60),
                empty_poll_backoff: Duration::from_millis(10),
                ..RelayModelLimits::default()
            },
        );
        let err = model
            .run("acct", "dev-1", &sample_request(), Arc::new(|_| {}))
            .await
            .unwrap_err();
        match err {
            ModelError::Failed(message) => {
                assert!(message.contains(MODEL_ROUND_TIMEOUT_CODE), "{message}");
            }
            other => panic!("expected Failed timeout, got {other:?}"),
        }
        assert_eq!(rpc.cancelled.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn relay_model_aborts_when_streamed_deltas_exceed_cap() {
        let rpc = Arc::new(ScriptedRpc::new(vec![json!({
            "chunks": [{ "seq": 1, "text": "x".repeat(200) }],
            "done": false
        })]));
        let model = RelayModel::with_limits(
            rpc.clone(),
            RelayModelLimits {
                max_delta_bytes: 128,
                ..RelayModelLimits::default()
            },
        );
        let err = model
            .run("acct", "dev-1", &sample_request(), Arc::new(|_| {}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ModelError::Failed(ref m) if m.contains("fleet_model_output_too_large"))
        );
        assert_eq!(rpc.cancelled.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn relay_model_rejects_excessive_tool_calls() {
        let calls: Vec<Value> = (0..5)
            .map(|i| json!({ "id": format!("c{i}"), "name": "fleet_list_runtimes", "arguments": "{}" }))
            .collect();
        let rpc = Arc::new(ScriptedRpc::new(vec![json!({
            "chunks": [],
            "done": true,
            "result": { "text": "", "toolCalls": calls }
        })]));
        let model = RelayModel::with_limits(
            rpc,
            RelayModelLimits {
                max_tool_calls: 3,
                ..RelayModelLimits::default()
            },
        );
        let err = model
            .run("acct", "dev-1", &sample_request(), Arc::new(|_| {}))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ModelError::Failed(ref m) if m.contains("fleet_model_too_many_tool_calls"))
        );
    }
}
