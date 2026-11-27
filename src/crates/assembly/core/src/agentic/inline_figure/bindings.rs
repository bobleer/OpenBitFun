//! Project figure data from immutable producer receipts during an exact transcript read.
use openbitfun_agent_tools::effective_tool_invocation;
use openbitfun_services_core::session::{
    DialogTurnData, DialogTurnKind, PublishedFigure, ToolItemData, TurnStatus,
};
use openbitfun_services_integrations::remote_connect::TranscriptFigureBindingRefreshRequest;
use serde_json::{json, Map, Value};

use super::MAX_SOURCE_BYTES;

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_FILE_BYTES: usize = 256 * 1024;

struct Receipt<'a> {
    name: &'a str,
    args: &'a Value,
    result: &'a Value,
    item: &'a ToolItemData,
}

fn receipt(item: &ToolItemData) -> Option<Receipt<'_>> {
    if item.is_subagent_item == Some(true)
        || item.subagent_session_id.is_some()
        || item
            .status
            .as_deref()
            .is_some_and(|status| status != "completed")
    {
        return None;
    }
    let result = &item
        .tool_result
        .as_ref()
        .filter(|result| result.success)?
        .result;
    let (name, args) = effective_tool_invocation(&item.tool_name, &item.tool_call.input);
    Some(Receipt {
        name,
        args,
        result,
        item,
    })
}

fn recorded_write<'a>(receipt: &Receipt<'a>) -> Option<&'a str> {
    let path = receipt.result.get("file_path")?.as_str()?;
    let (header, text) = receipt.args.get("payload")?.as_str()?.split_once('\n')?;
    let bytes = receipt
        .result
        .get("content_bytes")
        .or_else(|| receipt.result.get("bytes_written"))
        .and_then(Value::as_u64);
    (header.trim_end_matches('\r').strip_prefix("+++ ") == Some(path)
        && bytes == Some(text.len() as u64))
    .then_some(text)
}

fn is_revision(receipt: &Receipt<'_>, uri: &str) -> bool {
    matches!(receipt.name, "Write" | "Edit")
        && (receipt
            .result
            .get("visualization_uri")
            .and_then(Value::as_str)
            == Some(uri)
            || receipt.result.get("file_path").and_then(Value::as_str) == Some(uri))
}

fn proves_source(receipt: &Receipt<'_>, snapshot: &PublishedFigure) -> bool {
    if receipt.result["visualization_checked"] == false {
        return false;
    }
    if receipt.result["visualization_checked"] == true
        && receipt
            .result
            .get("visualization_rendered_source")
            .is_some()
    {
        return receipt.result["visualization_rendered_source"].as_str()
            == Some(snapshot.source.as_str())
            && receipt.result["visualization_rendered_bytes"].as_u64()
                == Some(snapshot.content_bytes as u64);
    }
    if receipt.name == "Write" {
        return recorded_write(receipt) == Some(snapshot.source.as_str());
    }
    receipt.args["file_path"].as_str().is_some()
        && receipt.args["file_path"] == receipt.result["file_path"]
        && receipt.result["visualization_source"].as_str() == Some(snapshot.source.as_str())
        && receipt.result["content_bytes"].as_u64() == Some(snapshot.content_bytes as u64)
}

fn relative_file(path: &str) -> Option<&str> {
    let tail = path.strip_prefix("./").filter(|_| path.len() <= 512)?;
    tail.split('/')
        .all(|part| {
            part.as_bytes()
                .first()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
                && part
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-' | b'.'))
        })
        .then_some(tail)
}

fn project_value(binding: &Value, recorded: &[Receipt<'_>], uri: &str) -> Option<Value> {
    match binding["type"].as_str()? {
        "tool" => {
            let name = binding["tool"]
                .as_str()
                .filter(|name| !name.is_empty() && name.len() <= 256)?;
            let args = binding.get("arguments")?.as_object()?;
            let result = recorded
                .iter()
                .rev()
                .find(|call| call.name == name && call.args.as_object() == Some(args))?
                .result;
            (serde_json::to_vec(result).ok()?.len() <= MAX_HEADER_BYTES)
                .then(|| json!({ "kind": "json", "value": result }))
        }
        "file" | "library" => {
            let path = if binding["type"] == "file" {
                let name = relative_file(binding["path"].as_str()?)?;
                format!("{}/{}", uri.rsplit_once('/')?.0, name)
            } else {
                let id = binding["libraryFileId"].as_str()?;
                let suffix = id.strip_prefix("libfile_")?;
                if suffix.is_empty()
                    || suffix.len() > 128
                    || !suffix
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
                {
                    return None;
                }
                format!("openbitfun://current-session/artifacts/library/{id}")
            };
            let write = recorded.iter().rev().find(|call| {
                call.name == "Write" && call.result["file_path"].as_str() == Some(path.as_str())
            })?;
            let text = recorded_write(write).filter(|text| text.len() <= MAX_FILE_BYTES)?;
            let name = path.rsplit_once('/')?.1;
            let mime = match name.rsplit_once('.').map(|(_, ext)| ext) {
                Some("json") => "application/json",
                Some("csv") => "text/csv",
                Some("tsv") => "text/tab-separated-values",
                Some("txt") => "text/plain",
                Some("md") => "text/markdown",
                _ => "application/octet-stream",
            };
            Some(
                json!({ "kind": "file", "value": { "name": name, "text": text, "mimeType": mime } }),
            )
        }
        _ => None,
    }
}

fn declarations(snapshot: &PublishedFigure) -> Option<Map<String, Value>> {
    let (header, _) = snapshot
        .source
        .strip_prefix("<!-- vis-bindings\n")?
        .split_once("\n-->\n")?;
    if header
        .len()
        .saturating_add("<!-- vis-bindings\n\n-->\n".len())
        > MAX_HEADER_BYTES
        || header.contains(['<', '>'])
    {
        return None;
    }
    let declarations: Map<String, Value> = serde_json::from_str(header).ok()?;
    (declarations.len() <= 8).then_some(declarations)
}

fn valid_binding_name(name: &str) -> bool {
    name.len() <= 64
        && name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
        && !matches!(name, "prototype" | "constructor")
}

fn recover_bindings(
    turn: &DialogTurnData,
    uri: &str,
    snapshot: &PublishedFigure,
    bindings: &mut Map<String, Value>,
) -> Option<()> {
    let declarations = declarations(snapshot)?;
    if declarations.iter().all(|(name, declaration)| {
        bindings.contains_key(name)
            || !matches!(
                declaration["type"].as_str(),
                Some("file" | "library" | "tool")
            )
    }) {
        return None;
    }

    let mut recorded: Vec<_> = turn
        .model_rounds
        .iter()
        .flat_map(|round| &round.tool_items)
        .filter_map(receipt)
        .collect();
    let index = recorded.iter().rposition(|call| is_revision(call, uri))?;
    let revision = &recorded[index];
    if !proves_source(revision, snapshot) {
        return None;
    }
    let started = revision.item.start_time;
    recorded.truncate(index);
    if started != 0 {
        recorded.retain(|call| {
            call.item
                .end_time
                .map_or(call.item.start_time <= started, |end| end <= started)
        });
    }
    for (name, declaration) in declarations {
        if !valid_binding_name(&name) || bindings.contains_key(&name) {
            continue;
        }
        if let Some(value) = project_value(&declaration, &recorded, uri) {
            bindings.insert(name, value);
        }
    }
    Some(())
}

/// A live value comes from a later persisted turn of the same session. The
/// sealed source supplies the declaration and an optional reader token must
/// appear in the submitted user message, never in the model's response.
pub(crate) fn refreshed_figure_binding(
    original: &DialogTurnData,
    candidate: &DialogTurnData,
    uri: &str,
    snapshot: &PublishedFigure,
    request: &TranscriptFigureBindingRefreshRequest,
) -> Option<Value> {
    if original.session_id != candidate.session_id
        || original.turn_index >= candidate.turn_index
        || candidate.turn_id != request.turn_id
        || candidate.turn_index != request.turn_index
        || candidate.kind != DialogTurnKind::UserDialog
        || candidate.status == TurnStatus::InProgress
        || candidate.recovery.is_some()
        || !valid_binding_name(&request.name)
    {
        return None;
    }
    if let Some(token) = &request.request_token {
        let id = token.strip_prefix("[visualize:")?.strip_suffix(']')?;
        if id.len() != 32
            || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !candidate.user_message.content.contains(token)
        {
            return None;
        }
    }
    let declarations = declarations(snapshot)?;
    let binding = declarations.get(&request.name)?;
    if !matches!(binding["type"].as_str(), Some("tool" | "library")) {
        return None;
    }
    let recorded: Vec<_> = candidate
        .model_rounds
        .iter()
        .flat_map(|round| &round.tool_items)
        .filter_map(receipt)
        .collect();
    project_value(binding, &recorded, uri)
}

pub(crate) fn sealed_figure_bindings(
    turn: &DialogTurnData,
    uri: &str,
    snapshot: &PublishedFigure,
) -> Option<Map<String, Value>> {
    let mut bindings = snapshot.bindings.clone().unwrap_or_default();
    let _ = recover_bindings(turn, uri, snapshot, &mut bindings);
    let remaining = MAX_SOURCE_BYTES.checked_sub(snapshot.content_bytes)?;
    (!bindings.is_empty()
        && bindings.len() <= 8
        && serde_json::to_vec(&bindings).ok()?.len() <= remaining)
        .then_some(bindings)
}
