//! Typed, closed product-control operation contracts for all 8 expanded
//! OpenBitFun control domains:
//! - `workspace-ops` (`feature.projects`, `feature.remote-workspaces`)
//! - `skills-ops` (`feature.skills`)
//! - `acp-ops` (`setting.tools.acp`)
//! - `ecosystem-ops` (`feature.ecosystem-compatibility`)
//! - `review-ops` (`feature.code-review`, `feature.files-editor`)
//! - `ai-policy-ops` (`setting.ai.models`, `setting.ai.permissions`, `setting.tools.web-search`)
//! - `agent-assistant-ops` (`feature.agents`, `feature.personal-assistants`, `setting.ai.memory`)
//! - `automation-data-ops` (`feature.computer-use`, `feature.miniapps` market/worker,
//!   `feature.home-search`, `feature.insights`, `setting.data.usage`, `setting.data.archived`,
//!   `setting.data.storage`, `setting.data.diagnostics`)
//!
//! Every operation is strictly allow-listed, schema-validated, risk-classified,
//! and declares its exact CLI and peer availability rather than exposing an
//! arbitrary command gateway.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WORKSPACE_OPS_PROVIDER: &str = "workspace-ops";
pub const SKILLS_OPS_PROVIDER: &str = "skills-ops";
pub const ACP_OPS_PROVIDER: &str = "acp-ops";
pub const ECOSYSTEM_OPS_PROVIDER: &str = "ecosystem-ops";
pub const REVIEW_OPS_PROVIDER: &str = "review-ops";
pub const AI_POLICY_OPS_PROVIDER: &str = "ai-policy-ops";
pub const AGENT_ASSISTANT_OPS_PROVIDER: &str = "agent-assistant-ops";
pub const AUTOMATION_DATA_OPS_PROVIDER: &str = "automation-data-ops";

pub const ALL_CAPABILITY_OP_PROVIDERS: &[&str] = &[
    WORKSPACE_OPS_PROVIDER,
    SKILLS_OPS_PROVIDER,
    ACP_OPS_PROVIDER,
    ECOSYSTEM_OPS_PROVIDER,
    REVIEW_OPS_PROVIDER,
    AI_POLICY_OPS_PROVIDER,
    AGENT_ASSISTANT_OPS_PROVIDER,
    AUTOMATION_DATA_OPS_PROVIDER,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionFileDecisionAction {
    AcceptFile,
    RejectFile,
    AcceptSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProductCapabilityOpRequest {
    // ── workspace-ops (feature.projects & feature.remote-workspaces) ──────
    ListWorkspaces {},
    OpenWorkspace {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        create_local: bool,
        #[serde(default)]
        remote_connection_id: Option<String>,
    },
    CloseWorkspace {
        workspace_id: String,
    },
    SetActiveWorkspace {
        workspace_id: String,
    },
    ListConnections {},
    DiscoverEnvironments {
        #[serde(default)]
        docker_ssh_config: Option<Value>,
    },
    TestConnection {
        config: Value,
    },
    Connect {
        config: Value,
    },
    Disconnect {
        connection_id: String,
    },
    OpenRemoteWorkspace {
        connection_id: String,
        connection_name: String,
        remote_path: String,
        #[serde(default)]
        ssh_host: Option<String>,
        #[serde(default)]
        rebind_connection: bool,
    },
    TransferFile {
        direction: RemoteTransferDirection,
        connection_id: String,
        local_path: String,
        remote_path: String,
    },

    // ── skills-ops (feature.skills) ───────────────────────────────────────
    ListSkills {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        force_refresh: bool,
    },
    SearchMarket {
        #[serde(default)]
        query: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
    },
    InstallMarketSkill {
        package: String,
        #[serde(default)]
        level: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    AddLocalSkill {
        source_path: String,
        #[serde(default)]
        level: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        target_name: Option<String>,
    },
    SetSkillEnabled {
        skill_key: String,
        enabled: bool,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    DeleteSkill {
        skill_key: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },

    // ── acp-ops (setting.tools.acp) ───────────────────────────────────────
    ListClients {},
    ProbeClient {
        #[serde(default)]
        remote_connection_id: Option<String>,
        #[serde(default)]
        force_refresh: bool,
    },
    InstallClient {
        client_id: String,
        #[serde(default)]
        remote_connection_id: Option<String>,
        #[serde(default)]
        predownload_adapter_only: bool,
    },
    SetAcpPermissionMode {
        client_id: String,
        permission_mode: String,
    },

    // ── ecosystem-ops (feature.ecosystem-compatibility) ───────────────────
    DiscoverSources {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        force_refresh: bool,
    },
    SetSourceEnabled {
        source_key: String,
        enabled: bool,
        expected_preference_revision: u64,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    PlanMcpImport {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    ApplyMcpImport {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        plan: Option<Value>,
        #[serde(default)]
        server_keys: Option<Vec<String>>,
    },
    ListExternalSessions {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    RestoreExternalSession {
        session_id: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },

    // ── review-ops (feature.code-review & feature.files-editor) ───────────
    LaunchDeepReview {
        parent_session_id: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        intent: Option<String>,
        #[serde(default)]
        command_text: Option<String>,
        #[serde(default)]
        files: Vec<String>,
        #[serde(default)]
        focus: Option<String>,
        #[serde(default)]
        dry_run: bool,
    },
    LaunchPrReview {
        workspace_id: String,
        remote_id: String,
        pull_request_id: String,
        provider: Value,
        #[serde(default)]
        parent_session_id: Option<String>,
        #[serde(default)]
        dry_run: bool,
    },
    LaunchRemediation {
        payload: Value,
    },
    ListReviewRecords {
        workspace_id: String,
        #[serde(default)]
        parent_session_id: Option<String>,
    },
    GenerateCommitMessage {
        repo_path: String,
        #[serde(default)]
        options: Option<Value>,
    },
    SessionDiffStats {
        session_id: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    AcceptOrRejectFile {
        decision: SessionFileDecisionAction,
        session_id: String,
        #[serde(default)]
        file_path: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    RollbackSessionTurn {
        session_id: String,
        turn_index: usize,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },

    // ── ai-policy-ops (models / permissions / web-search) ─────────────────
    ListCatalog {},
    ListModelPools {
        #[serde(default)]
        pool_id: Option<String>,
    },
    SaveModelPool {
        pool: Value,
    },
    DeleteModelPool {
        pool_id: String,
    },
    SetTaskModel {
        task: String,
        selection: Value,
    },
    SetDefaultModels {
        #[serde(default)]
        primary: Option<String>,
        #[serde(default)]
        fast: Option<String>,
    },
    GetPermissions {},
    SetPermissionMode {
        mode: String,
    },
    UpsertPermissionRule {
        #[serde(default)]
        index: Option<usize>,
        rule: Value,
    },
    DeletePermissionRule {
        index: usize,
        #[serde(default)]
        expected: Option<Value>,
    },
    SetDeviceDispatchPolicy {
        #[serde(default)]
        accept_dispatch: Option<bool>,
        #[serde(default)]
        allow_auto_approval: Option<bool>,
    },
    GetWebSearchStatus {},
    SetWebSearchProvider {
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        endpoint: Option<String>,
        #[serde(default)]
        protocol: Option<String>,
    },

    // ── agent-assistant-ops (agents / assistants / memory) ────────────────
    ListAgents {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    GetAgentDetail {
        agent_id: String,
        #[serde(default)]
        is_subagent: bool,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    CreateAgent {
        kind: String,
        id: String,
        name: String,
        description: String,
        prompt: String,
        #[serde(default)]
        level: Option<String>,
        #[serde(default)]
        tools: Option<Vec<String>>,
        #[serde(default)]
        readonly: Option<bool>,
        #[serde(default)]
        review: Option<bool>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    UpdateAgent {
        agent_id: String,
        #[serde(default)]
        is_subagent: bool,
        payload: Value,
    },
    DeleteAgent {
        agent_id: String,
        #[serde(default)]
        is_subagent: bool,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    ListAssistants {},
    CreateAssistant {
        #[serde(default)]
        name: Option<String>,
    },
    SetAssistantIdentity {
        workspace_id: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        role: Option<String>,
        #[serde(default)]
        creature: Option<String>,
        #[serde(default)]
        vibe: Option<String>,
        #[serde(default)]
        emoji: Option<String>,
    },
    SetPrimaryAssistant {
        workspace_id: String,
    },
    ResetAssistant {
        workspace_id: String,
    },
    DeleteAssistant {
        workspace_id: String,
    },
    GetMemoryPaths {},
    ResetMemory {},

    // ── automation-data-ops (computer-use / miniapp market / home / data) ─
    ComputerUseStatus {
        #[serde(default)]
        port: Option<u16>,
    },
    RequestOsPermission {
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        open_settings_pane: Option<String>,
    },
    LaunchBrowser {
        #[serde(default)]
        port: Option<u16>,
        #[serde(default)]
        enable_default_cdp: bool,
    },
    DisconnectBrowser {
        #[serde(default)]
        port: Option<u16>,
    },
    ControlSessionStatus {},
    StopControlSession {
        generation: u64,
    },
    BrowseMiniappMarket {
        #[serde(default)]
        query: Option<String>,
        #[serde(default)]
        category: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
        #[serde(default)]
        cursor: Option<String>,
    },
    InstallMarketMiniapp {
        slug: String,
        release_number: u32,
        #[serde(default)]
        existing_app_id: Option<String>,
        #[serde(default)]
        confirm_permissions: bool,
        #[serde(default)]
        confirm_overwrite: bool,
    },
    CallMiniappWorker {
        app_id: String,
        method: String,
        #[serde(default)]
        params: Option<Value>,
    },
    PersonalOverview {
        #[serde(default)]
        time_zone: Option<String>,
    },
    SearchSessions {
        query: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },
    ListInsights {
        #[serde(default)]
        days: Option<u32>,
    },
    LoadInsightsReport {
        path: String,
    },
    GenerateInsights {
        #[serde(default)]
        days: Option<u32>,
        #[serde(default)]
        model_id: Option<String>,
        #[serde(default)]
        generation_id: Option<String>,
    },
    CancelInsights {
        #[serde(default)]
        generation_id: Option<String>,
    },
    GetUsageStats {
        #[serde(default)]
        request: Option<Value>,
    },
    GetActivityHeatmap {
        #[serde(default)]
        request: Option<Value>,
    },
    ListArchivedSessions {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    UnarchiveSession {
        session_id: String,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    DeleteAllArchivedSessions {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_path: Option<String>,
    },
    InspectSnapshotStorage {
        #[serde(default)]
        period: Option<String>,
    },
    CleanSnapshotStorage {
        workspace_id: String,
        period: String,
        candidates: Vec<Value>,
    },
    RuntimeDiagnosticsInfo {},
    ExportDiagnosticsBundle {},
}

/// Static table mapping `(provider_id, operation_id)` -> `(cli_available, peer_safe, readonly)`.
pub const CAPABILITY_OP_METADATA: &[(&str, &str, bool, bool, bool)] = &[
    // workspace-ops
    (WORKSPACE_OPS_PROVIDER, "list-workspaces", true, true, true),
    (WORKSPACE_OPS_PROVIDER, "open-workspace", true, true, false),
    (WORKSPACE_OPS_PROVIDER, "close-workspace", true, true, false),
    (
        WORKSPACE_OPS_PROVIDER,
        "set-active-workspace",
        true,
        true,
        false,
    ),
    (WORKSPACE_OPS_PROVIDER, "list-connections", true, true, true),
    (
        WORKSPACE_OPS_PROVIDER,
        "discover-environments",
        false,
        true,
        true,
    ),
    (WORKSPACE_OPS_PROVIDER, "test-connection", false, true, true),
    (WORKSPACE_OPS_PROVIDER, "connect", false, true, false),
    (WORKSPACE_OPS_PROVIDER, "disconnect", false, true, false),
    (
        WORKSPACE_OPS_PROVIDER,
        "open-remote-workspace",
        true,
        true,
        false,
    ),
    (WORKSPACE_OPS_PROVIDER, "transfer-file", false, true, false),
    // skills-ops
    (SKILLS_OPS_PROVIDER, "list-skills", true, true, true),
    (SKILLS_OPS_PROVIDER, "search-market", false, true, true),
    (
        SKILLS_OPS_PROVIDER,
        "install-market-skill",
        false,
        true,
        false,
    ),
    (SKILLS_OPS_PROVIDER, "add-local-skill", true, true, false),
    (SKILLS_OPS_PROVIDER, "set-skill-enabled", true, true, false),
    (SKILLS_OPS_PROVIDER, "delete-skill", true, true, false),
    // acp-ops
    (ACP_OPS_PROVIDER, "list-clients", false, true, true),
    (ACP_OPS_PROVIDER, "probe-client", false, true, true),
    (ACP_OPS_PROVIDER, "install-client", false, true, false),
    (
        ACP_OPS_PROVIDER,
        "set-acp-permission-mode",
        false,
        true,
        false,
    ),
    // ecosystem-ops
    (ECOSYSTEM_OPS_PROVIDER, "discover-sources", true, true, true),
    (
        ECOSYSTEM_OPS_PROVIDER,
        "set-source-enabled",
        true,
        true,
        false,
    ),
    (ECOSYSTEM_OPS_PROVIDER, "plan-mcp-import", true, true, true),
    (
        ECOSYSTEM_OPS_PROVIDER,
        "apply-mcp-import",
        true,
        true,
        false,
    ),
    (
        ECOSYSTEM_OPS_PROVIDER,
        "list-external-sessions",
        true,
        true,
        true,
    ),
    (
        ECOSYSTEM_OPS_PROVIDER,
        "restore-external-session",
        true,
        true,
        false,
    ),
    // review-ops
    (
        REVIEW_OPS_PROVIDER,
        "launch-deep-review",
        false,
        true,
        false,
    ),
    (REVIEW_OPS_PROVIDER, "launch-pr-review", false, true, false),
    (
        REVIEW_OPS_PROVIDER,
        "launch-remediation",
        false,
        true,
        false,
    ),
    (
        REVIEW_OPS_PROVIDER,
        "list-review-records",
        false,
        true,
        true,
    ),
    (
        REVIEW_OPS_PROVIDER,
        "generate-commit-message",
        false,
        true,
        true,
    ),
    (REVIEW_OPS_PROVIDER, "session-diff-stats", true, true, true),
    (
        REVIEW_OPS_PROVIDER,
        "accept-or-reject-file",
        false,
        true,
        false,
    ),
    (
        REVIEW_OPS_PROVIDER,
        "rollback-session-turn",
        true,
        true,
        false,
    ),
    // ai-policy-ops
    (AI_POLICY_OPS_PROVIDER, "list-catalog", true, true, true),
    (AI_POLICY_OPS_PROVIDER, "list-model-pools", true, true, true),
    (AI_POLICY_OPS_PROVIDER, "save-model-pool", true, true, false),
    (
        AI_POLICY_OPS_PROVIDER,
        "delete-model-pool",
        true,
        true,
        false,
    ),
    (AI_POLICY_OPS_PROVIDER, "set-task-model", true, true, false),
    (
        AI_POLICY_OPS_PROVIDER,
        "set-default-models",
        true,
        true,
        false,
    ),
    (AI_POLICY_OPS_PROVIDER, "get-permissions", true, true, true),
    (
        AI_POLICY_OPS_PROVIDER,
        "set-permission-mode",
        true,
        true,
        false,
    ),
    (
        AI_POLICY_OPS_PROVIDER,
        "upsert-permission-rule",
        true,
        true,
        false,
    ),
    (
        AI_POLICY_OPS_PROVIDER,
        "delete-permission-rule",
        true,
        true,
        false,
    ),
    (
        AI_POLICY_OPS_PROVIDER,
        "set-device-dispatch-policy",
        true,
        true,
        false,
    ),
    (
        AI_POLICY_OPS_PROVIDER,
        "get-web-search-status",
        true,
        true,
        true,
    ),
    (
        AI_POLICY_OPS_PROVIDER,
        "set-web-search-provider",
        true,
        true,
        false,
    ),
    // agent-assistant-ops
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "list-agents",
        true,
        true,
        true,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "get-agent-detail",
        true,
        true,
        true,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "create-agent",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "update-agent",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "delete-agent",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "list-assistants",
        true,
        true,
        true,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "create-assistant",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "set-assistant-identity",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "set-primary-assistant",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "reset-assistant",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "delete-assistant",
        true,
        true,
        false,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "get-memory-paths",
        true,
        true,
        true,
    ),
    (
        AGENT_ASSISTANT_OPS_PROVIDER,
        "reset-memory",
        true,
        true,
        false,
    ),
    // automation-data-ops
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "computer-use-status",
        false,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "request-os-permission",
        false,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "launch-browser",
        false,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "disconnect-browser",
        false,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "control-session-status",
        false,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "stop-control-session",
        false,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "browse-miniapp-market",
        false,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "install-market-miniapp",
        false,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "call-miniapp-worker",
        false,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "personal-overview",
        true,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "search-sessions",
        true,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "list-insights",
        false,
        false,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "load-insights-report",
        false,
        false,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "generate-insights",
        false,
        false,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "cancel-insights",
        false,
        false,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "get-usage-stats",
        true,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "get-activity-heatmap",
        true,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "list-archived-sessions",
        true,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "unarchive-session",
        true,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "delete-all-archived-sessions",
        true,
        true,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "inspect-snapshot-storage",
        false,
        false,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "clean-snapshot-storage",
        false,
        false,
        false,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "runtime-diagnostics-info",
        true,
        true,
        true,
    ),
    (
        AUTOMATION_DATA_OPS_PROVIDER,
        "export-diagnostics-bundle",
        false,
        true,
        false,
    ),
];

pub fn is_capability_op_provider(provider_id: &str) -> bool {
    ALL_CAPABILITY_OP_PROVIDERS.contains(&provider_id)
}

pub fn lookup_capability_op(provider_id: &str, operation_id: &str) -> Option<(bool, bool, bool)> {
    CAPABILITY_OP_METADATA
        .iter()
        .find(|(p, op, _, _, _)| *p == provider_id && *op == operation_id)
        .map(|(_, _, cli, peer, readonly)| (*cli, *peer, *readonly))
}

impl ProductCapabilityOpRequest {
    pub fn from_provider_operation(
        provider_id: &str,
        operation_id: &str,
        arguments: Option<&Value>,
    ) -> Result<Self, String> {
        if lookup_capability_op(provider_id, operation_id).is_none() {
            return Err(format!(
                "Unknown product capability operation: {provider_id}:{operation_id}"
            ));
        }
        let mut payload = arguments.cloned().unwrap_or_else(|| serde_json::json!({}));
        let object = payload
            .as_object_mut()
            .ok_or("Operation arguments must be a JSON object")?;
        if object.contains_key("operation") {
            return Err("Operation name must be supplied by the registered handler".into());
        }
        object.insert("operation".into(), Value::String(operation_id.into()));
        let parsed: Self = serde_json::from_value(payload).map_err(|error| {
            format!("Invalid arguments for {provider_id}:{operation_id}: {error}")
        })?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::OpenWorkspace {
                workspace_id, path, ..
            } => {
                if workspace_id.as_deref().is_none_or(|v| v.trim().is_empty())
                    && path.as_deref().is_none_or(|v| v.trim().is_empty())
                {
                    return Err("open-workspace requires workspaceId or path".into());
                }
            }
            Self::CloseWorkspace { workspace_id } | Self::SetActiveWorkspace { workspace_id } => {
                if workspace_id.trim().is_empty() {
                    return Err("workspaceId cannot be empty".into());
                }
            }
            Self::Disconnect { connection_id } => {
                if connection_id.trim().is_empty() {
                    return Err("connectionId cannot be empty".into());
                }
            }
            Self::OpenRemoteWorkspace {
                connection_id,
                connection_name,
                remote_path,
                ..
            } => {
                if connection_id.trim().is_empty()
                    || connection_name.trim().is_empty()
                    || remote_path.trim().is_empty()
                {
                    return Err(
                        "open-remote-workspace requires connectionId, connectionName, and remotePath"
                            .into(),
                    );
                }
            }
            Self::TransferFile {
                connection_id,
                local_path,
                remote_path,
                ..
            } => {
                if connection_id.trim().is_empty()
                    || local_path.trim().is_empty()
                    || remote_path.trim().is_empty()
                {
                    return Err(
                        "transfer-file requires connectionId, localPath, and remotePath".into(),
                    );
                }
            }
            Self::InstallMarketSkill { package, .. } => {
                if package.trim().is_empty() {
                    return Err("package cannot be empty".into());
                }
            }
            Self::AddLocalSkill { source_path, .. } => {
                if source_path.trim().is_empty() {
                    return Err("sourcePath cannot be empty".into());
                }
            }
            Self::SetSkillEnabled { skill_key, .. } | Self::DeleteSkill { skill_key, .. } => {
                if skill_key.trim().is_empty() {
                    return Err("skillKey cannot be empty".into());
                }
            }
            Self::InstallClient { client_id, .. } => {
                if client_id.trim().is_empty() {
                    return Err("clientId cannot be empty".into());
                }
            }
            Self::SetAcpPermissionMode {
                client_id,
                permission_mode,
            } => {
                if client_id.trim().is_empty() || permission_mode.trim().is_empty() {
                    return Err("clientId and permissionMode cannot be empty".into());
                }
            }
            Self::SetSourceEnabled { source_key, .. } => {
                if source_key.trim().is_empty() {
                    return Err("sourceKey cannot be empty".into());
                }
            }
            Self::RestoreExternalSession { session_id, .. } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
            }
            Self::LaunchDeepReview {
                parent_session_id, ..
            } => {
                if parent_session_id.trim().is_empty() {
                    return Err("parentSessionId cannot be empty".into());
                }
            }
            Self::LaunchPrReview {
                workspace_id,
                remote_id,
                pull_request_id,
                ..
            } => {
                if workspace_id.trim().is_empty()
                    || remote_id.trim().is_empty()
                    || pull_request_id.trim().is_empty()
                {
                    return Err(
                        "launch-pr-review requires workspaceId, remoteId, and pullRequestId".into(),
                    );
                }
            }
            Self::ListReviewRecords { workspace_id, .. } => {
                if workspace_id.trim().is_empty() {
                    return Err("workspaceId cannot be empty".into());
                }
            }
            Self::GenerateCommitMessage { repo_path, .. } => {
                if repo_path.trim().is_empty() {
                    return Err("repoPath cannot be empty".into());
                }
            }
            Self::SessionDiffStats { session_id, .. }
            | Self::RollbackSessionTurn { session_id, .. } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
            }
            Self::AcceptOrRejectFile {
                decision,
                session_id,
                file_path,
                ..
            } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
                if matches!(
                    decision,
                    SessionFileDecisionAction::AcceptFile | SessionFileDecisionAction::RejectFile
                ) && file_path.as_deref().is_none_or(|v| v.trim().is_empty())
                {
                    return Err("accept_file and reject_file require filePath".into());
                }
            }
            Self::DeleteModelPool { pool_id } => {
                if pool_id.trim().is_empty() {
                    return Err("poolId cannot be empty".into());
                }
            }
            Self::SetTaskModel { task, .. } => {
                if task.trim().is_empty() {
                    return Err("task cannot be empty".into());
                }
            }
            Self::SetDefaultModels { primary, fast } => {
                if primary.as_deref().is_none_or(|v| v.trim().is_empty())
                    && fast.as_deref().is_none_or(|v| v.trim().is_empty())
                {
                    return Err("set-default-models requires primary and/or fast model ID".into());
                }
            }
            Self::SetPermissionMode { mode } => {
                if !matches!(mode.as_str(), "ask" | "auto" | "full_access") {
                    return Err("mode must be one of ask, auto, or full_access".into());
                }
            }
            Self::SetDeviceDispatchPolicy {
                accept_dispatch,
                allow_auto_approval,
            } => {
                if accept_dispatch.is_none() && allow_auto_approval.is_none() {
                    return Err(
                        "set-device-dispatch-policy requires acceptDispatch and/or allowAutoApproval"
                            .into(),
                    );
                }
            }
            Self::GetAgentDetail { agent_id, .. }
            | Self::UpdateAgent { agent_id, .. }
            | Self::DeleteAgent { agent_id, .. } => {
                if agent_id.trim().is_empty() {
                    return Err("agentId cannot be empty".into());
                }
            }
            Self::CreateAgent {
                kind,
                id,
                name,
                description,
                prompt,
                ..
            } => {
                if kind.trim().is_empty()
                    || id.trim().is_empty()
                    || name.trim().is_empty()
                    || description.trim().is_empty()
                    || prompt.trim().is_empty()
                {
                    return Err(
                        "create-agent requires non-empty kind, id, name, description, and prompt"
                            .into(),
                    );
                }
            }
            Self::SetAssistantIdentity { workspace_id, .. }
            | Self::SetPrimaryAssistant { workspace_id }
            | Self::ResetAssistant { workspace_id }
            | Self::DeleteAssistant { workspace_id } => {
                if workspace_id.trim().is_empty() {
                    return Err("workspaceId cannot be empty".into());
                }
            }
            Self::RequestOsPermission {
                kind,
                open_settings_pane,
            } => {
                if kind.as_deref().is_none_or(|v| v.trim().is_empty())
                    && open_settings_pane
                        .as_deref()
                        .is_none_or(|v| v.trim().is_empty())
                {
                    return Err("request-os-permission requires kind or openSettingsPane".into());
                }
            }
            Self::InstallMarketMiniapp { slug, .. } => {
                if slug.trim().is_empty() {
                    return Err("slug cannot be empty".into());
                }
            }
            Self::CallMiniappWorker { app_id, method, .. } => {
                if app_id.trim().is_empty() || method.trim().is_empty() {
                    return Err("call-miniapp-worker requires appId and method".into());
                }
            }
            Self::SearchSessions { query, .. } => {
                if query.trim().is_empty() {
                    return Err("query cannot be empty".into());
                }
            }
            Self::LoadInsightsReport { path } => {
                if path.trim().is_empty() {
                    return Err("path cannot be empty".into());
                }
            }
            Self::UnarchiveSession { session_id, .. } => {
                if session_id.trim().is_empty() {
                    return Err("sessionId cannot be empty".into());
                }
            }
            Self::CleanSnapshotStorage {
                workspace_id,
                period,
                ..
            } => {
                if workspace_id.trim().is_empty() || period.trim().is_empty() {
                    return Err("clean-snapshot-storage requires workspaceId and period".into());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn provider_and_operation(&self) -> (&'static str, &'static str) {
        match self {
            Self::ListWorkspaces {} => (WORKSPACE_OPS_PROVIDER, "list-workspaces"),
            Self::OpenWorkspace { .. } => (WORKSPACE_OPS_PROVIDER, "open-workspace"),
            Self::CloseWorkspace { .. } => (WORKSPACE_OPS_PROVIDER, "close-workspace"),
            Self::SetActiveWorkspace { .. } => (WORKSPACE_OPS_PROVIDER, "set-active-workspace"),
            Self::ListConnections {} => (WORKSPACE_OPS_PROVIDER, "list-connections"),
            Self::DiscoverEnvironments { .. } => (WORKSPACE_OPS_PROVIDER, "discover-environments"),
            Self::TestConnection { .. } => (WORKSPACE_OPS_PROVIDER, "test-connection"),
            Self::Connect { .. } => (WORKSPACE_OPS_PROVIDER, "connect"),
            Self::Disconnect { .. } => (WORKSPACE_OPS_PROVIDER, "disconnect"),
            Self::OpenRemoteWorkspace { .. } => (WORKSPACE_OPS_PROVIDER, "open-remote-workspace"),
            Self::TransferFile { .. } => (WORKSPACE_OPS_PROVIDER, "transfer-file"),
            Self::ListSkills { .. } => (SKILLS_OPS_PROVIDER, "list-skills"),
            Self::SearchMarket { .. } => (SKILLS_OPS_PROVIDER, "search-market"),
            Self::InstallMarketSkill { .. } => (SKILLS_OPS_PROVIDER, "install-market-skill"),
            Self::AddLocalSkill { .. } => (SKILLS_OPS_PROVIDER, "add-local-skill"),
            Self::SetSkillEnabled { .. } => (SKILLS_OPS_PROVIDER, "set-skill-enabled"),
            Self::DeleteSkill { .. } => (SKILLS_OPS_PROVIDER, "delete-skill"),
            Self::ListClients {} => (ACP_OPS_PROVIDER, "list-clients"),
            Self::ProbeClient { .. } => (ACP_OPS_PROVIDER, "probe-client"),
            Self::InstallClient { .. } => (ACP_OPS_PROVIDER, "install-client"),
            Self::SetAcpPermissionMode { .. } => (ACP_OPS_PROVIDER, "set-acp-permission-mode"),
            Self::DiscoverSources { .. } => (ECOSYSTEM_OPS_PROVIDER, "discover-sources"),
            Self::SetSourceEnabled { .. } => (ECOSYSTEM_OPS_PROVIDER, "set-source-enabled"),
            Self::PlanMcpImport { .. } => (ECOSYSTEM_OPS_PROVIDER, "plan-mcp-import"),
            Self::ApplyMcpImport { .. } => (ECOSYSTEM_OPS_PROVIDER, "apply-mcp-import"),
            Self::ListExternalSessions { .. } => (ECOSYSTEM_OPS_PROVIDER, "list-external-sessions"),
            Self::RestoreExternalSession { .. } => {
                (ECOSYSTEM_OPS_PROVIDER, "restore-external-session")
            }
            Self::LaunchDeepReview { .. } => (REVIEW_OPS_PROVIDER, "launch-deep-review"),
            Self::LaunchPrReview { .. } => (REVIEW_OPS_PROVIDER, "launch-pr-review"),
            Self::LaunchRemediation { .. } => (REVIEW_OPS_PROVIDER, "launch-remediation"),
            Self::ListReviewRecords { .. } => (REVIEW_OPS_PROVIDER, "list-review-records"),
            Self::GenerateCommitMessage { .. } => (REVIEW_OPS_PROVIDER, "generate-commit-message"),
            Self::SessionDiffStats { .. } => (REVIEW_OPS_PROVIDER, "session-diff-stats"),
            Self::AcceptOrRejectFile { .. } => (REVIEW_OPS_PROVIDER, "accept-or-reject-file"),
            Self::RollbackSessionTurn { .. } => (REVIEW_OPS_PROVIDER, "rollback-session-turn"),
            Self::ListCatalog {} => (AI_POLICY_OPS_PROVIDER, "list-catalog"),
            Self::ListModelPools { .. } => (AI_POLICY_OPS_PROVIDER, "list-model-pools"),
            Self::SaveModelPool { .. } => (AI_POLICY_OPS_PROVIDER, "save-model-pool"),
            Self::DeleteModelPool { .. } => (AI_POLICY_OPS_PROVIDER, "delete-model-pool"),
            Self::SetTaskModel { .. } => (AI_POLICY_OPS_PROVIDER, "set-task-model"),
            Self::SetDefaultModels { .. } => (AI_POLICY_OPS_PROVIDER, "set-default-models"),
            Self::GetPermissions {} => (AI_POLICY_OPS_PROVIDER, "get-permissions"),
            Self::SetPermissionMode { .. } => (AI_POLICY_OPS_PROVIDER, "set-permission-mode"),
            Self::UpsertPermissionRule { .. } => (AI_POLICY_OPS_PROVIDER, "upsert-permission-rule"),
            Self::DeletePermissionRule { .. } => (AI_POLICY_OPS_PROVIDER, "delete-permission-rule"),
            Self::SetDeviceDispatchPolicy { .. } => {
                (AI_POLICY_OPS_PROVIDER, "set-device-dispatch-policy")
            }
            Self::GetWebSearchStatus {} => (AI_POLICY_OPS_PROVIDER, "get-web-search-status"),
            Self::SetWebSearchProvider { .. } => {
                (AI_POLICY_OPS_PROVIDER, "set-web-search-provider")
            }
            Self::ListAgents { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "list-agents"),
            Self::GetAgentDetail { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "get-agent-detail"),
            Self::CreateAgent { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "create-agent"),
            Self::UpdateAgent { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "update-agent"),
            Self::DeleteAgent { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "delete-agent"),
            Self::ListAssistants {} => (AGENT_ASSISTANT_OPS_PROVIDER, "list-assistants"),
            Self::CreateAssistant { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "create-assistant"),
            Self::SetAssistantIdentity { .. } => {
                (AGENT_ASSISTANT_OPS_PROVIDER, "set-assistant-identity")
            }
            Self::SetPrimaryAssistant { .. } => {
                (AGENT_ASSISTANT_OPS_PROVIDER, "set-primary-assistant")
            }
            Self::ResetAssistant { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "reset-assistant"),
            Self::DeleteAssistant { .. } => (AGENT_ASSISTANT_OPS_PROVIDER, "delete-assistant"),
            Self::GetMemoryPaths {} => (AGENT_ASSISTANT_OPS_PROVIDER, "get-memory-paths"),
            Self::ResetMemory {} => (AGENT_ASSISTANT_OPS_PROVIDER, "reset-memory"),
            Self::ComputerUseStatus { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "computer-use-status"),
            Self::RequestOsPermission { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "request-os-permission")
            }
            Self::LaunchBrowser { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "launch-browser"),
            Self::DisconnectBrowser { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "disconnect-browser"),
            Self::ControlSessionStatus {} => {
                (AUTOMATION_DATA_OPS_PROVIDER, "control-session-status")
            }
            Self::StopControlSession { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "stop-control-session")
            }
            Self::BrowseMiniappMarket { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "browse-miniapp-market")
            }
            Self::InstallMarketMiniapp { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "install-market-miniapp")
            }
            Self::CallMiniappWorker { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "call-miniapp-worker"),
            Self::PersonalOverview { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "personal-overview"),
            Self::SearchSessions { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "search-sessions"),
            Self::ListInsights { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "list-insights"),
            Self::LoadInsightsReport { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "load-insights-report")
            }
            Self::GenerateInsights { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "generate-insights"),
            Self::CancelInsights { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "cancel-insights"),
            Self::GetUsageStats { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "get-usage-stats"),
            Self::GetActivityHeatmap { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "get-activity-heatmap")
            }
            Self::ListArchivedSessions { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "list-archived-sessions")
            }
            Self::UnarchiveSession { .. } => (AUTOMATION_DATA_OPS_PROVIDER, "unarchive-session"),
            Self::DeleteAllArchivedSessions { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "delete-all-archived-sessions")
            }
            Self::InspectSnapshotStorage { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "inspect-snapshot-storage")
            }
            Self::CleanSnapshotStorage { .. } => {
                (AUTOMATION_DATA_OPS_PROVIDER, "clean-snapshot-storage")
            }
            Self::RuntimeDiagnosticsInfo {} => {
                (AUTOMATION_DATA_OPS_PROVIDER, "runtime-diagnostics-info")
            }
            Self::ExportDiagnosticsBundle {} => {
                (AUTOMATION_DATA_OPS_PROVIDER, "export-diagnostics-bundle")
            }
        }
    }

    pub fn is_readonly(&self) -> bool {
        let (provider, op) = self.provider_and_operation();
        lookup_capability_op(provider, op).is_some_and(|(_, _, readonly)| readonly)
    }

    pub fn is_cli_available(&self) -> bool {
        let (provider, op) = self.provider_and_operation();
        lookup_capability_op(provider, op).is_some_and(|(cli, _, _)| cli)
    }

    pub fn is_peer_safe(&self) -> bool {
        let (provider, op) = self.provider_and_operation();
        lookup_capability_op(provider, op).is_some_and(|(_, peer, _)| peer)
    }

    pub fn ensure_allowed_in_dispatch_worker(&self) -> Result<(), String> {
        if self.is_readonly() {
            Ok(())
        } else {
            let (provider, op) = self.provider_and_operation();
            Err(format!(
                "product_control_dispatch_worker_readonly: A detached dispatch worker may inspect product state but cannot execute mutating operation '{provider}:{op}'"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn capability_ops_parse_validate_and_match_metadata() {
        let parsed = ProductCapabilityOpRequest::from_provider_operation(
            WORKSPACE_OPS_PROVIDER,
            "open-workspace",
            Some(&json!({"path": "/repo"})),
        )
        .unwrap();
        assert!(!parsed.is_readonly());
        assert!(parsed.is_cli_available());
        assert!(parsed.ensure_allowed_in_dispatch_worker().is_err());

        let readonly = ProductCapabilityOpRequest::from_provider_operation(
            AI_POLICY_OPS_PROVIDER,
            "list-catalog",
            None,
        )
        .unwrap();
        assert!(readonly.is_readonly());
        assert!(readonly.is_cli_available());
        assert!(readonly.ensure_allowed_in_dispatch_worker().is_ok());

        for (provider, op, args) in [
            (WORKSPACE_OPS_PROVIDER, "open-workspace", json!({})),
            (
                AI_POLICY_OPS_PROVIDER,
                "set-permission-mode",
                json!({"mode": "invalid"}),
            ),
            (AI_POLICY_OPS_PROVIDER, "set-default-models", json!({})),
            (
                REVIEW_OPS_PROVIDER,
                "accept-or-reject-file",
                json!({"decision": "accept_file", "sessionId": "s1"}),
            ),
            (
                AUTOMATION_DATA_OPS_PROVIDER,
                "request-os-permission",
                json!({}),
            ),
        ] {
            assert!(
                ProductCapabilityOpRequest::from_provider_operation(provider, op, Some(&args))
                    .is_err(),
                "{provider}:{op} {args}"
            );
        }
    }
}
