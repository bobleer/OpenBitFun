//! Product HostInvoke command handlers for CLI Peer Host.

mod agents;
mod btw;
mod config;
mod cron;
mod dialog;
mod external_sources;
mod filesystem;
mod git;
mod goal;
mod mcp;
mod model_pools;
mod models;
mod permission;
mod product_control;
mod session;
mod settings_mutations;
mod skills;
mod snapshot;
mod soft;
mod system;
mod terminal;
mod terminal_profiles;
mod tools;
mod view_models;
mod workspace;

use serde_json::Value;

use super::state::PeerHostState;

// Select the handler before polling it. A monolithic async match retains every
// handler's construction temporaries in its poll frame (900 KiB in a debug
// build), exhausting the worker stack when a handler starts the runtime.
// Returning a selected future releases dispatch's stack before execution.
pub(crate) fn dispatch<'a>(
    command: &'a str,
    args: &'a Value,
    state: &'a PeerHostState,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>> {
    match command {
        "probe_magpie_gateway" => Box::pin(models::probe_magpie_gateway(args)),
        "list_ai_models_by_config" => Box::pin(models::list_ai_models_by_config(args)),
        "list_visible_subagents" | "list_subagents" | "list_manageable_subagents" => Box::pin(tools::list_subagents(command, args)),
        "get_session_permission_mode" => Box::pin(permission::session_permission_mode(state, args, false, false)),
        "update_session_permission_mode" => Box::pin(permission::session_permission_mode(state, args, true, false)),
        "update_active_turn_permission_mode" => Box::pin(permission::session_permission_mode(state, args, true, true)),
        "retry_model_pool_member" | "get_model_pools" => Box::pin(model_pools::dispatch(command, state, args)),
        "save_model_pool" => Box::pin(model_pools::dispatch(command, state, args)),
        "delete_model_pool" => Box::pin(model_pools::dispatch(command, state, args)),
        "get_model_pool_status" => Box::pin(model_pools::dispatch(command, state, args)),
        "get_session_model_target" => Box::pin(model_pools::dispatch(command, state, args)),
        "update_session_model_target" => Box::pin(model_pools::dispatch(command, state, args)),
        "get_ai_model_catalog" => Box::pin(models::get_ai_model_catalog()),
        "project_ai_model_reasoning_catalog" => Box::pin(models::project_ai_model_reasoning_catalog(args)),
        "get_model_configs" => Box::pin(models::get_model_configs()),
        "get_models_dev_catalog_status" => Box::pin(models::get_models_dev_catalog_status()),
        "refresh_models_dev_catalog_now" => Box::pin(models::refresh_models_dev_catalog_now()),
        "test_ai_config_connection" => Box::pin(models::test_ai_config_connection(args)),
        // Workspace / assistant / config
        "initialize_workspace_startup_state" => {
            Box::pin(workspace::initialize_workspace_startup_state(state))
        }
        "get_assistant_workspaces" => Box::pin(workspace::get_assistant_workspaces(state)),
        "get_primary_assistant_workspace" => {
            Box::pin(workspace::get_primary_assistant_workspace(state))
        }
        "create_assistant_workspace" => Box::pin(workspace::create_assistant_workspace(state, args)),
        "set_assistant_identity" => Box::pin(workspace::set_assistant_identity(state, args)),
        "set_primary_assistant_workspace" => {
            Box::pin(workspace::set_primary_assistant_workspace(state, args))
        }
        "delete_assistant_workspace" => Box::pin(workspace::delete_assistant_workspace(state, args)),
        "reset_assistant_workspace" => Box::pin(workspace::reset_assistant_workspace(state, args)),
        "reset_workspace_persona_files" => {
            Box::pin(workspace::reset_workspace_persona_files(state, args))
        }
        "get_workspace_icon" => Box::pin(workspace::get_workspace_icon(state, args)),
        "set_workspace_icon" => Box::pin(workspace::set_workspace_icon(state, args)),
        "get_opened_workspaces" => Box::pin(workspace::get_opened_workspaces(state)),
        "get_recent_workspaces" => Box::pin(workspace::get_recent_workspaces(state)),
        "get_current_workspace" => Box::pin(workspace::get_current_workspace(state)),
        "close_workspace" => Box::pin(workspace::close_workspace(state, args)),
        "remove_recent_workspace" => Box::pin(workspace::remove_recent_workspace(state, args)),
        "update_workspace_info" => Box::pin(workspace::update_workspace_info(state, args)),
        "set_active_workspace" => Box::pin(workspace::set_active_workspace(state, args)),
        "reorder_opened_workspaces" => Box::pin(workspace::reorder_opened_workspaces(state, args)),
        "open_workspace" => Box::pin(workspace::open_workspace(state, args)),
        "ssh_list_saved_connections" => Box::pin(workspace::ssh_list_saved_connections()),
        "open_remote_workspace" => Box::pin(workspace::open_remote_workspace(state, args)),
        "cleanup_invalid_workspaces" => Box::pin(workspace::cleanup_invalid_workspaces(state)),
        "reload_config" => Box::pin(workspace::reload_config()),
        "get_config" => Box::pin(config::get_config(args)),
        "get_configs" => Box::pin(config::get_configs(args)),
        "set_config" => Box::pin(config::set_config(state, args)),
        "export_config" => Box::pin(config::export_config()),
        "import_config" => Box::pin(config::import_config(args)),
        // Custom agents, subagents, and profiles
        "list_agent_tool_names" => Box::pin(agents::list_agent_tool_names()),
        "get_custom_agent_detail" => Box::pin(agents::get_custom_agent_detail(state, args)),
        "create_custom_agent" => Box::pin(agents::create_custom_agent(state, args)),
        "update_custom_agent" => Box::pin(agents::update_custom_agent(state, args)),
        "delete_custom_agent" => Box::pin(agents::delete_custom_agent(state, args)),
        "reload_custom_agents" => Box::pin(agents::reload_custom_agents(state, args)),
        "get_subagent_detail" => Box::pin(agents::get_subagent_detail(state, args)),
        "create_subagent" => Box::pin(agents::create_subagent(state, args)),
        "update_subagent" => Box::pin(agents::update_subagent(state, args)),
        "delete_subagent" => Box::pin(agents::delete_subagent(state, args)),
        "reload_subagents" => Box::pin(agents::reload_subagents(state, args)),
        "update_subagent_config" => Box::pin(agents::update_subagent_config(state, args)),
        "set_agent_profile_config" => Box::pin(agents::set_agent_profile_config(args)),
        "reset_agent_profile_config" => Box::pin(agents::reset_agent_profile_config(args)),
        // Typed settings mutations (wave 3 config).
        "ai_model_upsert" => Box::pin(settings_mutations::ai_model_upsert(args)),
        "ai_model_delete" => Box::pin(settings_mutations::ai_model_delete(args)),
        "set_task_model" => Box::pin(settings_mutations::set_task_model(args)),
        "set_permission_mode" => Box::pin(settings_mutations::set_permission_mode(args)),
        "upsert_permission_rule" => Box::pin(settings_mutations::upsert_permission_rule(args)),
        "delete_permission_rule" => Box::pin(settings_mutations::delete_permission_rule(args)),
        "set_approval_settings" => Box::pin(settings_mutations::set_approval_settings(args)),
        "set_web_search_provider" => Box::pin(settings_mutations::set_web_search_provider(args)),
        "set_superagent_settings" => Box::pin(settings_mutations::set_superagent_settings(args)),
        "get_settings_schema" => Box::pin(settings_mutations::get_settings_schema(args)),
        "get_permission_settings" => Box::pin(settings_mutations::get_permission_settings()),
        "get_web_search_credential_status" => Box::pin(config::get_web_search_credential_status(args)),
        "save_web_search_credential" => Box::pin(config::save_web_search_credential(args)),
        "clear_web_search_credential" => Box::pin(config::clear_web_search_credential(args)),
        "get_decision_model_credential_status" => Box::pin(config::get_decision_model_credential_status(args)),
        "save_decision_model_credential" => Box::pin(config::save_decision_model_credential(args)),
        "clear_decision_model_credential" => Box::pin(config::clear_decision_model_credential(args)),
        "product_control_invoke" => Box::pin(product_control::invoke(state, args)),
        "get_agent_profile_config" => Box::pin(config::get_agent_profile_config(args)),
        "get_agent_profile_configs" => Box::pin(config::get_agent_profile_configs()),
        "get_external_source_snapshot"
        | "get_external_source_control_snapshot"
        | "get_external_source_discovery_snapshot"
        | "reveal_external_source_location"
        | "apply_external_source_control_action_command"
        | "set_external_source_enabled_command"
        | "set_external_source_conflict_choice_command"
        | "set_external_tool_target_decision_command"
        | "set_external_tool_targets_enabled_command"
        | "set_external_tool_conflict_choice_command"
        | "set_external_subagent_activation_command"
        | "set_external_subagents_enabled_command"
        | "set_external_subagent_model_binding_command"
        | "choose_external_subagent_conflict_command"
        | "set_external_mcp_server_decision_command"
        | "set_external_mcp_servers_enabled_command"
        | "choose_external_mcp_conflict_command"
        | "update_external_integration_policy_command" => {
            Box::pin(external_sources::dispatch(command, args, state))
        }
        "plan_external_mcp_import_command" => {
            Box::pin(external_sources::plan_external_mcp_import_command(state, args))
        }
        "apply_external_mcp_import_command" => {
            Box::pin(external_sources::apply_external_mcp_import_command(state, args))
        }
        "list_removed_external_sessions" => {
            Box::pin(external_sources::list_removed_external_sessions(args))
        }
        "restore_removed_external_session" => {
            Box::pin(external_sources::restore_removed_external_session(args))
        }
        // MCP servers, prompts, resources, and remote auth
        "get_mcp_servers" => Box::pin(mcp::get_mcp_servers()),
        "start_mcp_server" => Box::pin(mcp::start_mcp_server(args)),
        "stop_mcp_server" => Box::pin(mcp::stop_mcp_server(args)),
        "restart_mcp_server" => Box::pin(mcp::restart_mcp_server(args)),
        "get_mcp_server_status" => Box::pin(mcp::get_mcp_server_status(args)),
        "load_mcp_json_config" => Box::pin(mcp::load_mcp_json_config()),
        "save_mcp_json_config" => Box::pin(mcp::save_mcp_json_config(args)),
        "delete_mcp_server" => Box::pin(mcp::delete_mcp_server(args)),
        "list_mcp_prompts" => Box::pin(mcp::list_mcp_prompts(args)),
        "get_mcp_prompt" => Box::pin(mcp::get_mcp_prompt(args)),
        "list_mcp_resources" => Box::pin(mcp::list_mcp_resources(args)),
        "read_mcp_resource" => Box::pin(mcp::read_mcp_resource(args)),
        "update_mcp_remote_auth" => Box::pin(mcp::update_mcp_remote_auth(args)),
        "clear_mcp_remote_auth" => Box::pin(mcp::clear_mcp_remote_auth(args)),
        "start_mcp_remote_oauth" => Box::pin(mcp::start_mcp_remote_oauth(args)),
        "get_mcp_remote_oauth_session" => Box::pin(mcp::get_mcp_remote_oauth_session(args)),
        "cancel_mcp_remote_oauth" => Box::pin(mcp::cancel_mcp_remote_oauth(args)),

        // The web UI bundle a browser loads from this host (wave 10).
        "ui_bundle_manifest" => Box::pin(system::ui_bundle_manifest()),
        "terminal_execute" => Box::pin(terminal::execute(args)),
        "terminal_create" => Box::pin(terminal::create(state, args)),
        "terminal_write" => Box::pin(terminal::write(args)),
        "terminal_resize" => Box::pin(terminal::resize(args)),
        "terminal_close" => Box::pin(terminal::close(args)),
        "terminal_get_history" => Box::pin(terminal::history(args)),
        "terminal_list" => Box::pin(terminal::list()),
        "terminal_get" => Box::pin(terminal::get(args)),
        "terminal_get_shells" => Box::pin(terminal::shells()),
        "terminal_signal" => Box::pin(terminal::signal(args)),
        "terminal_ack" => Box::pin(terminal::acknowledge(args)),
        "terminal_has_shell_integration" => Box::pin(terminal::has_shell_integration(args)),
        "terminal_send_command" => Box::pin(terminal::send_command(args)),
        "terminal_shutdown_all" => Box::pin(terminal::shutdown_all()),
        // Saved terminal profiles (wave 4 remote link + terminal profiles).
        "get_terminal_profiles" => Box::pin(terminal_profiles::get(args)),
        "upsert_terminal_profile" => Box::pin(terminal_profiles::upsert(args)),
        "delete_terminal_profile" => Box::pin(terminal_profiles::delete(args)),
        "import_terminal_profiles" => Box::pin(terminal_profiles::import(args)),
        // Filesystem
        "workspace_file_upload" => Box::pin(filesystem::workspace_file_upload(state, args)),
        "html_preview_read_resource" => Box::pin(filesystem::html_preview_read_resource(args)),
        "get_directory_children" | "explorer_get_children" => {
            Box::pin(filesystem::get_directory_children(&state.filesystem_service, &state.workspace_service, args))
        }
        "get_directory_children_paginated" | "explorer_get_children_paginated" => {
            Box::pin(filesystem::get_directory_children_paginated(&state.filesystem_service, &state.workspace_service, args))
        }
        "get_file_tree" | "explorer_get_file_tree" => {
            Box::pin(filesystem::get_file_tree(&state.filesystem_service, &state.workspace_service, args))
        }
        "get_file_metadata" => Box::pin(filesystem::get_file_metadata(state, args)),
        "get_file_editor_sync_hash" => {
            Box::pin(filesystem::get_file_editor_sync_hash(state, args))
        }
        "create_file" => Box::pin(filesystem::create_file(state, args)),
        "start_file_watch" => Box::pin(filesystem::start_file_watch(state, args)),
        "stop_file_watch" => Box::pin(filesystem::stop_file_watch(state, args)),
        "get_watched_paths" => Box::pin(filesystem::get_watched_paths()),
        "retry_file_watch" => Box::pin(filesystem::retry_file_watch()),
        "check_path_exists" => Box::pin(filesystem::check_path_exists(state, args)),
        "create_directory" => Box::pin(filesystem::create_directory(state, args)),
        "read_file_content" => Box::pin(filesystem::read_file_content(state, args)),
        "write_file_content" => Box::pin(filesystem::write_file_content(state, args)),
        "rename_file" => Box::pin(filesystem::rename_file(state, args)),
        "delete_file" => Box::pin(filesystem::delete_path(state, args, false)),
        "delete_directory" => Box::pin(filesystem::delete_path(state, args, true)),
        "list_directory_files" => Box::pin(filesystem::list_directory_files(state, args)),

        // Tools catalog — read-only tool listing for Agents / Assistant
        // Defaults UI. CLI Host assembles the same Core tool registry as
        // Desktop and returns the identical DTO shape, so a controller cannot
        // tell "CLI Host doesn't support catalog query" from "the runtime
        // really has no tools". Without this the call fell into the unsupported
        // dispatch branch and the UI silently rendered an empty tool list.
        "get_all_tools_info" => Box::pin(tools::get_all_tools_info()),
        "get_chat_mcp_catalog" => Box::pin(tools::get_chat_mcp_catalog(args)),

        "get_model_routing_status" => Box::pin(session::get_model_routing_status(state, args)),
        // Sessions
        "list_persisted_sessions" => Box::pin(session::list_persisted_sessions(state, args)),
        "list_persisted_sessions_page" => Box::pin(session::list_persisted_sessions_page(state, args)),
        "save_session_metadata" => Box::pin(session::save_session_metadata(state, args)),
        "mark_session_seen" => Box::pin(session::mark_session_seen(state, args)),
        "load_persisted_session_metadata" => {
            Box::pin(session::load_persisted_session_metadata(state, args))
        }
        "search_session_content" => Box::pin(session::search_session_content(state, args)),
        "load_session_trajectory" => Box::pin(session::load_session_trajectory(state, args)),
        "load_session_turn_window" => Box::pin(session::load_session_turn_window(state, args)),
        "load_session_turns" => Box::pin(session::load_session_turns(state, args)),
        "get_session_transcript_view" => Box::pin(session::get_session_transcript_view(state, args)),
        "load_session_event_backfill" => Box::pin(std::future::ready(session::load_session_event_backfill(state, args))),
        "restore_session_view" => Box::pin(session::restore_session_view(state, args)),
        "restore_session_with_turns" => Box::pin(session::restore_session_with_turns(state, args)),
        "restore_session" => Box::pin(session::restore_session(state, args)),
        "ensure_control_conversation" => Box::pin(session::ensure_control_conversation(state, args)),
        "create_control_conversation" => Box::pin(session::create_control_conversation(state, args)),
        "record_voice_exchange" => Box::pin(session::record_voice_exchange(state, args)),
        "create_session" => Box::pin(session::create_session(state, args)),
        "delete_session" => Box::pin(session::delete_session(state, args)),
        // Desktop answers both names through the same session deletion.
        "delete_persisted_session" => Box::pin(session::delete_session(state, args)),
        "delete_all_archived_sessions" => {
            Box::pin(session::delete_all_archived_sessions(state, args))
        }
        "update_session_title" => Box::pin(session::update_session_title(state, args)),
        "export_session_transcript" => Box::pin(session::export_session_transcript(state, args)),
        "archive_session" => Box::pin(session::archive_session(state, args)),
        "unarchive_session" => Box::pin(session::unarchive_session(state, args)),
        "list_archived_sessions" => Box::pin(session::list_archived_sessions(state, args)),
        "get_session_lineage" => Box::pin(session::get_session_lineage(state, args)),
        "fork_session" => Box::pin(session::fork_session(state, args)),
        "copy_session" => Box::pin(session::copy_session(state, args)),
        "touch_session_activity" => Box::pin(session::touch_session_activity(state, args)),
        "get_session_thread_goal" => Box::pin(session::get_session_thread_goal(state, args)),
        "activate_session_goal" => Box::pin(goal::activate_session_goal(state, args)),
        "set_session_thread_goal_status" => {
            Box::pin(goal::set_session_thread_goal_status(state, args))
        }
        "update_session_thread_goal_objective" => {
            Box::pin(goal::update_session_thread_goal_objective(state, args))
        }
        "clear_session_thread_goal" => Box::pin(goal::clear_session_thread_goal(state, args)),
        "update_session_mode" => Box::pin(session::update_session_mode(state, args)),
        "update_session_model" => Box::pin(session::update_session_model(state, args)),
        "ensure_coordinator_session" => Box::pin(session::ensure_coordinator_session(state, args)),
        "get_session_mode_catalog" => Box::pin(session::get_session_mode_catalog(state, args)),
        "get_available_modes" => Box::pin(session::get_available_modes(state, args)),
        "get_session_stats" => Box::pin(session::get_session_stats(state, args)),
        "get_session_usage_report" => Box::pin(session::get_session_usage_report(state, args)),
        "save_session_turn" => Box::pin(session::save_session_turn(state, args)),

        // Snapshot / rollback
        "rollback_session_to_turn" => Box::pin(snapshot::rollback_session_to_turn(state, args)),
        "get_session_files" => Box::pin(snapshot::get_session_files(state, args)),
        "get_session_file_diff_stats" => {
            Box::pin(snapshot::get_session_file_diff_stats(state, args))
        }
        "get_operation_diff" => Box::pin(snapshot::get_operation_diff(state, args)),

        // Dialog / tools
        "manage_dialog_queue" => Box::pin(dialog::manage_dialog_queue(state, args)),
        "submit_user_message" => Box::pin(dialog::submit_user_message(state, args)),
        "steer_dialog_turn" => Box::pin(dialog::steer_dialog_turn(state, args)),
        "stop_dialog_turn" => Box::pin(dialog::stop_dialog_turn(state, args)),
        "list_session_commands" => Box::pin(dialog::list_session_commands(state, args)),
        "execute_session_command" => Box::pin(dialog::execute_session_command(state, args)),
        "start_dialog_turn" => Box::pin(dialog::start_dialog_turn(state, args)),
        "cancel_dialog_turn" => Box::pin(dialog::cancel_dialog_turn(state, args)),
        "cancel_session" => Box::pin(dialog::cancel_session(state, args)),
        "compact_session" => Box::pin(dialog::compact_session(state, args)),
        "interrupt_dialog_turn" => Box::pin(dialog::interrupt_dialog_turn(state, args)),
        "recover_interrupted_dialog_turn" => {
            Box::pin(dialog::recover_interrupted_dialog_turn(state, args))
        }
        "start_user_question_interaction" => Box::pin(dialog::start_user_question_interaction(state, args)),
        "submit_user_answers" => Box::pin(dialog::submit_user_answers(state, args)),
        // Per-tool interrupt. The controller renders Terminal cards for Turns
        // this host owns, so it must be able to stop a running tool here —
        // same owner as cancel_dialog_turn, one level finer. Reaches the Core
        // coordinator via the compatibility surface both CLI and Desktop Peer
        // Hosts share.
        "cancel_tool" => Box::pin(dialog::cancel_tool(state, args)),
        "btw_ask_stream" => Box::pin(btw::btw_ask_stream(state, args)),
        "btw_cancel" => Box::pin(btw::btw_cancel(args)),
        "get_session_interaction_mailbox" => Box::pin(std::future::ready(permission::get_session_interaction_mailbox(state, args))),
        "list_pending_permission_requests" => Box::pin(std::future::ready(permission::list_pending_permission_requests(state))),
        "subscribe_permission_requests" => Box::pin(std::future::ready(permission::subscribe_permission_requests())),
        "respond_permission" => Box::pin(permission::respond_permission(state, args)),
        "respond_permission_batch" => Box::pin(permission::respond_permission_batch(state, args)),
        "list_project_permission_grants" => {
            Box::pin(permission::list_project_permission_grants(state, args))
        }
        "remove_project_permission_grant" => {
            Box::pin(permission::remove_project_permission_grant(state, args))
        }
        "clear_project_permission_grants" => {
            Box::pin(permission::clear_project_permission_grants(state, args))
        }
        "list_project_permission_audit" => {
            Box::pin(permission::list_project_permission_audit(state, args))
        }

        // Git (local workspace only)
        "git_is_repository" => Box::pin(git::git_is_repository(args)),
        "git_get_repository_trust" => Box::pin(git::git_get_repository_trust(args)),
        "git_get_repository"
        | "git_get_repository_basic"
        | "git_get_status"
        | "git_get_tracked_change_count"
        | "git_get_branches"
        | "git_get_enhanced_branches"
        | "git_get_commits"
        | "git_get_diff"
        | "git_get_changed_files"
        | "git_resolve_revision" => Box::pin(git::read(command, args)),

        // Scheduled jobs (routines)
        "list_cron_jobs" => Box::pin(cron::list_cron_jobs(state, args)),
        "create_cron_job" => Box::pin(cron::create_cron_job(args)),
        "update_cron_job" => Box::pin(cron::update_cron_job(args)),
        "delete_cron_job" => Box::pin(cron::delete_cron_job(args)),
        "notify_cron_host_ready" => Box::pin(cron::notify_cron_host_ready()),
        "validate_cron_job_draft" => Box::pin(cron::validate_draft(args)),
        "preview_cron_occurrences" => Box::pin(cron::preview_occurrences(args)),

        // Soft empty / no-op for Desktop-only subsystems
        "list_miniapps" => Box::pin(soft::list_miniapps()),
        "miniapp_worker_list_running" => Box::pin(soft::miniapp_worker_list_running()),
        "get_acp_clients" => Box::pin(soft::get_acp_clients()),
        "list_background_command_activities" => Box::pin(soft::list_background_command_activities()),

        // Skills
        "get_skill_configs" => Box::pin(skills::get_skill_configs(args)),
        "get_mode_skill_configs" => Box::pin(skills::get_mode_skill_configs(args)),
        "get_global_skill_settings" => Box::pin(skills::get_global_skill_settings(args)),
        "set_global_skill_disabled" => Box::pin(skills::set_global_skill_disabled(args)),
        "validate_skill_path" => Box::pin(skills::validate_skill_path(args)),
        "add_skill" => Box::pin(skills::add_skill(args)),
        "delete_skill" => Box::pin(skills::delete_skill(args)),
        "replace_mode_skill_selection" => Box::pin(skills::replace_mode_skill_selection(args)),
        "reset_mode_skill_selection" => Box::pin(skills::reset_mode_skill_selection(args)),

        // System / memory
        "get_app_version" => Box::pin(system::get_app_version()),
        "get_memory_paths" => Box::pin(system::get_memory_paths(state)),
        "reset_memory" => Box::pin(system::reset_memory(state)),
        "get_system_info" => Box::pin(system::get_system_info()),
        "get_runtime_logging_info" => Box::pin(system::get_runtime_logging_info()),
        "get_token_usage_statistics" => Box::pin(system::get_token_usage_statistics(state, args)),
        // View models (wave 4)
        "get_token_usage_activity" => Box::pin(view_models::get_token_usage_activity(state, args)),
        "get_workspace_navigator" => Box::pin(view_models::get_workspace_navigator(state, args)),
        "get_personal_overview" => Box::pin(view_models::get_personal_overview(state, args)),

        // Only reachable if the registry marks a command Handled without a
        // matching arm above; the closure test below fails first.
        other => Box::pin(std::future::ready(Err(format!(
            "command '{other}' is registered as handled on the CLI peer host but this build has no handler for it"
        )))),
    }
}

/// Product commands the `dispatch` match above answers with a real handler.
/// The closure tests below keep this list, the match arms, and the Product
/// Operation Registry's `cli_peer == Handled` rows identical, so a command
/// cannot be advertised as runnable here without a handler (or vice versa).
#[cfg(test)]
pub(crate) const HANDLED_COMMANDS: &[&str] = &[
    "ui_bundle_manifest",
    "btw_ask_stream",
    "btw_cancel",
    "get_skill_configs",
    "get_mode_skill_configs",
    "get_global_skill_settings",
    "get_runtime_logging_info",
    "terminal_execute",
    "terminal_get",
    "terminal_get_shells",
    "terminal_signal",
    "terminal_ack",
    "terminal_has_shell_integration",
    "terminal_send_command",
    "terminal_shutdown_all",
    // Saved terminal profiles (wave 4 remote link + terminal profiles).
    "get_terminal_profiles",
    "upsert_terminal_profile",
    "delete_terminal_profile",
    "import_terminal_profiles",
    "terminal_create",
    "terminal_write",
    "terminal_resize",
    "terminal_close",
    "terminal_get_history",
    "terminal_list",
    "ssh_list_saved_connections",
    "open_remote_workspace",
    "read_file_content",
    "write_file_content",
    "rename_file",
    "delete_file",
    "delete_directory",
    "list_directory_files",
    "create_file",
    "explorer_get_children",
    "explorer_get_children_paginated",
    "explorer_get_file_tree",
    "get_file_tree",
    "get_file_metadata",
    "get_file_editor_sync_hash",
    "get_watched_paths",
    "start_file_watch",
    "stop_file_watch",
    "list_subagents",
    "list_manageable_subagents",
    "test_ai_config_connection",
    "refresh_models_dev_catalog_now",
    "get_models_dev_catalog_status",
    "get_model_configs",
    "get_model_routing_status",
    "project_ai_model_reasoning_catalog",
    "retry_model_pool_member",
    "get_model_pools",
    "save_model_pool",
    "delete_model_pool",
    "get_model_pool_status",
    "get_session_model_target",
    "update_session_model_target",
    "get_ai_model_catalog",
    "update_active_turn_permission_mode",
    "update_session_permission_mode",
    "get_session_permission_mode",
    "list_visible_subagents",
    "list_ai_models_by_config",
    "probe_magpie_gateway",
    "apply_external_source_control_action_command",
    "archive_session",
    "cancel_dialog_turn",
    "cancel_session",
    "fork_session",
    "delete_persisted_session",
    "delete_all_archived_sessions",
    "activate_session_goal",
    "set_session_thread_goal_status",
    "update_session_thread_goal_objective",
    "clear_session_thread_goal",
    "compact_session",
    "unarchive_session",
    "list_archived_sessions",
    "get_session_lineage",
    "interrupt_dialog_turn",
    "recover_interrupted_dialog_turn",
    "get_session_file_diff_stats",
    "load_persisted_session_metadata",
    "copy_session",
    "cancel_tool",
    "check_path_exists",
    "choose_external_mcp_conflict_command",
    "choose_external_subagent_conflict_command",
    "cleanup_invalid_workspaces",
    "clear_project_permission_grants",
    "clear_web_search_credential",
    "clear_decision_model_credential",
    "create_directory",
    "create_session",
    "ensure_control_conversation",
    "create_control_conversation",
    "record_voice_exchange",
    "delete_session",
    "ensure_coordinator_session",
    "get_agent_profile_config",
    "get_agent_profile_configs",
    "get_all_tools_info",
    "get_chat_mcp_catalog",
    "get_available_modes",
    "get_session_mode_catalog",
    "get_config",
    "get_configs",
    "get_current_workspace",
    "workspace_file_upload",
    "html_preview_read_resource",
    "get_directory_children",
    "get_directory_children_paginated",
    "get_file_tree",
    "explorer_get_children",
    "explorer_get_children_paginated",
    "explorer_get_file_tree",
    "get_external_source_control_snapshot",
    "get_external_source_discovery_snapshot",
    "get_external_source_snapshot",
    "get_workspace_icon",
    "set_workspace_icon",
    "get_opened_workspaces",
    "get_recent_workspaces",
    "get_session_files",
    "get_session_stats",
    "get_session_usage_report",
    "get_session_thread_goal",
    "get_system_info",
    "get_token_usage_statistics",
    "get_token_usage_activity",
    "get_workspace_navigator",
    "get_personal_overview",
    "get_web_search_credential_status",
    "get_decision_model_credential_status",
    "git_get_repository_trust",
    "git_is_repository",
    "git_get_repository",
    "git_get_repository_basic",
    "git_get_status",
    "git_get_tracked_change_count",
    "git_get_branches",
    "git_get_enhanced_branches",
    "git_get_commits",
    "git_get_diff",
    "git_get_changed_files",
    "git_resolve_revision",
    "initialize_workspace_startup_state",
    "get_session_interaction_mailbox",
    "list_pending_permission_requests",
    "list_persisted_sessions",
    "list_persisted_sessions_page",
    "list_project_permission_audit",
    "list_project_permission_grants",
    "load_session_event_backfill",
    "load_session_turn_window",
    "load_session_trajectory",
    "load_session_turns",
    "get_session_transcript_view",
    "mark_session_seen",
    "open_workspace",
    "product_control_invoke",
    "reload_config",
    "remove_project_permission_grant",
    "reorder_opened_workspaces",
    "respond_permission",
    "respond_permission_batch",
    "restore_session",
    "restore_session_view",
    "restore_session_with_turns",
    "reveal_external_source_location",
    "rollback_session_to_turn",
    "save_session_metadata",
    "save_session_turn",
    "save_web_search_credential",
    "save_decision_model_credential",
    "search_session_content",
    "set_config",
    "ai_model_upsert",
    "ai_model_delete",
    "set_task_model",
    "set_permission_mode",
    "upsert_permission_rule",
    "delete_permission_rule",
    "set_approval_settings",
    "set_web_search_provider",
    "set_superagent_settings",
    "get_settings_schema",
    "get_permission_settings",
    "validate_cron_job_draft",
    "preview_cron_occurrences",
    "set_external_mcp_server_decision_command",
    "set_external_mcp_servers_enabled_command",
    "set_external_source_conflict_choice_command",
    "set_external_source_enabled_command",
    "set_external_subagent_activation_command",
    "set_external_subagent_model_binding_command",
    "set_external_subagents_enabled_command",
    "set_external_tool_conflict_choice_command",
    "set_external_tool_target_decision_command",
    "set_external_tool_targets_enabled_command",
    "set_active_workspace",
    "start_dialog_turn",
    "manage_dialog_queue",
    "submit_user_answers",
    "start_user_question_interaction",
    "subscribe_permission_requests",
    "touch_session_activity",
    "update_external_integration_policy_command",
    "update_session_mode",
    "update_session_model",
    // Assistants & workspace lifecycle
    "get_assistant_workspaces",
    "get_primary_assistant_workspace",
    "create_assistant_workspace",
    "set_assistant_identity",
    "set_primary_assistant_workspace",
    "delete_assistant_workspace",
    "reset_assistant_workspace",
    "reset_workspace_persona_files",
    "close_workspace",
    "update_workspace_info",
    "remove_recent_workspace",
    // Scheduled jobs (routines)
    "list_cron_jobs",
    "create_cron_job",
    "update_cron_job",
    "delete_cron_job",
    "notify_cron_host_ready",
    // Custom agents, subagents, and profiles
    "list_agent_tool_names",
    "get_custom_agent_detail",
    "create_custom_agent",
    "update_custom_agent",
    "delete_custom_agent",
    "reload_custom_agents",
    "get_subagent_detail",
    "create_subagent",
    "update_subagent",
    "delete_subagent",
    "reload_subagents",
    "update_subagent_config",
    "set_agent_profile_config",
    "reset_agent_profile_config",
    // Skills management
    "set_global_skill_disabled",
    "validate_skill_path",
    "add_skill",
    "delete_skill",
    "replace_mode_skill_selection",
    "reset_mode_skill_selection",
    // Session interactive controls, diff, and transcript export
    "submit_user_message",
    "stop_dialog_turn",
    "steer_dialog_turn",
    "list_session_commands",
    "execute_session_command",
    "update_session_title",
    "get_operation_diff",
    "export_session_transcript",
    // MCP servers, prompts, resources, and remote auth
    "get_mcp_servers",
    "start_mcp_server",
    "stop_mcp_server",
    "restart_mcp_server",
    "get_mcp_server_status",
    "load_mcp_json_config",
    "save_mcp_json_config",
    "delete_mcp_server",
    "list_mcp_prompts",
    "get_mcp_prompt",
    "list_mcp_resources",
    "read_mcp_resource",
    "update_mcp_remote_auth",
    "clear_mcp_remote_auth",
    "start_mcp_remote_oauth",
    "get_mcp_remote_oauth_session",
    "cancel_mcp_remote_oauth",
    // External MCP / session import
    "plan_external_mcp_import_command",
    "apply_external_mcp_import_command",
    "list_removed_external_sessions",
    "restore_removed_external_session",
    // Memory, config export/import, app version, file watch recovery
    "get_memory_paths",
    "reset_memory",
    "export_config",
    "import_config",
    "get_app_version",
    "retry_file_watch",
];

/// Commands answered by `soft.rs` with a declared empty or no-op success.
#[cfg(test)]
pub(crate) const SOFT_EMPTY_COMMANDS: &[&str] = &[
    "get_acp_clients",
    "list_background_command_activities",
    "list_miniapps",
    "miniapp_worker_list_running",
];

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{HANDLED_COMMANDS, SOFT_EMPTY_COMMANDS};

    /// Parses the string arms of the `dispatch` match in this file and splits
    /// them by whether they route to `soft::`. The match body ends at the
    /// catch-all `other =>` arm, so the test module below is never scanned.
    fn dispatch_arms() -> (BTreeSet<String>, BTreeSet<String>) {
        let source = include_str!("mod.rs");
        let start = source
            .find("match command {")
            .expect("commands::dispatch must match on the command name");
        let end = source[start..]
            .find("other =>")
            .map(|offset| start + offset)
            .expect("commands::dispatch must end with the `other =>` arm");
        let body = &source[start..end];
        let mut handled = BTreeSet::new();
        let mut soft = BTreeSet::new();
        // Arms may span lines (`"a" | "b" => { module::f(..) }`), so scan
        // token-wise: quoted names accumulate until the next `module::` target.
        let mut pending: Vec<String> = Vec::new();
        for raw in body.lines() {
            let line = raw.trim();
            if line.starts_with("//") || line.is_empty() {
                continue;
            }
            let mut rest = line;
            while let Some(open) = rest.find('"') {
                let after = &rest[open + 1..];
                let Some(close) = after.find('"') else { break };
                pending.push(after[..close].to_string());
                rest = &after[close + 1..];
            }
            let target = match line.find("=>") {
                Some(arrow) => line[arrow + 2..].trim(),
                None => line,
            };
            let target = target.trim_start_matches('{').trim();
            if pending.is_empty() || !target.contains("::") {
                continue;
            }
            let is_soft = target.trim_start_matches("Box::pin(").starts_with("soft::");
            for name in pending.drain(..) {
                if is_soft {
                    soft.insert(name);
                } else {
                    handled.insert(name);
                }
            }
        }
        assert!(
            pending.is_empty(),
            "unclassified dispatch arms: {pending:?}"
        );
        (handled, soft)
    }

    fn as_set(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn handled_commands_match_dispatch_arms() {
        let (handled, soft) = dispatch_arms();
        assert!(
            handled.len() > 50,
            "dispatch arm parsing looks broken: {}",
            handled.len()
        );
        assert_eq!(
            handled,
            as_set(HANDLED_COMMANDS),
            "HANDLED_COMMANDS must list exactly the match arms"
        );
        assert_eq!(
            soft,
            as_set(SOFT_EMPTY_COMMANDS),
            "SOFT_EMPTY_COMMANDS must list exactly the soft:: arms"
        );
    }

    #[test]
    fn handled_commands_match_registry() {
        use openbitfun_product_domains::remote_surface::{
            cli_handled_commands, soft_empty_commands,
        };
        let registry_handled: BTreeSet<String> = cli_handled_commands()
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            registry_handled,
            as_set(HANDLED_COMMANDS),
            "registry rows with cli_peer == Handled must equal the CLI dispatch table; \
             add or remove the row in product-domains remote_surface/table.rs together with the handler"
        );
        let registry_soft: BTreeSet<String> = soft_empty_commands()
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            registry_soft,
            as_set(SOFT_EMPTY_COMMANDS),
            "registry SoftEmpty rows must equal the soft:: dispatch arms"
        );
    }
}
