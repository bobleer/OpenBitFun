//! Process-level registration for the platform-agnostic product-control port.

use std::sync::{Arc, OnceLock};

use serde_json::Value;

pub use openbitfun_product_domains::product_control::{
    ProductControlAction, ProductControlPort,
    ProductControlRequest as OpenBitFunControlHostRequest, ProductControlSource,
};

static OPENBITFUN_CONTROL_PORT: OnceLock<Arc<dyn ProductControlPort>> = OnceLock::new();

tokio::task_local! {
    static CALLER_MODEL_ID: Option<String>;
}

/// Active model ID of the controller session currently invoking `OpenBitFunControl`,
/// when called from inside an Agent turn. Used by Fleet session orchestration to
/// inherit the controller's working model over `fleet_model_v1` instead of relying
/// on an unconfigured or unreachable peer-local model.
pub fn current_caller_model_id() -> Option<String> {
    CALLER_MODEL_ID
        .try_with(|id| id.clone())
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Run `fut` with the calling session's active model ID visible to product-control handlers.
pub async fn with_caller_model_id<F, T>(model_id: Option<String>, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    let normalized = model_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    CALLER_MODEL_ID.scope(normalized, fut).await
}

/// Register the product adapter. The first registered host owns the process.
pub fn set_openbitfun_control_port(port: Arc<dyn ProductControlPort>) {
    let _ = OPENBITFUN_CONTROL_PORT.set(port);
}

pub fn openbitfun_control_host_available() -> bool {
    OPENBITFUN_CONTROL_PORT.get().is_some()
}

pub async fn invoke_openbitfun_control(
    request: OpenBitFunControlHostRequest,
) -> Result<Value, String> {
    let Some(port) = OPENBITFUN_CONTROL_PORT.get() else {
        return Err("OpenBitFunControl host is not available on this product surface".to_string());
    };
    port.invoke(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_request_uses_the_frontend_camel_case_contract() {
        let serialized = serde_json::to_value(OpenBitFunControlHostRequest {
            action: ProductControlAction::Open,
            target: None,
            query: None,
            capability_id: Some("setting.application.input".to_string()),
            item_id: Some("shortcut-browser".to_string()),
            operation_id: None,
            option_id: None,
            arguments: None,
            value: None,
            cursor: None,
            limit: None,
            source: ProductControlSource::Agent,
        })
        .unwrap();

        assert_eq!(
            serialized["capabilityId"],
            json!("setting.application.input")
        );
        assert_eq!(serialized["itemId"], json!("shortcut-browser"));
        assert!(serialized.get("capability_id").is_none());
        assert!(serialized.get("item_id").is_none());
    }
}
