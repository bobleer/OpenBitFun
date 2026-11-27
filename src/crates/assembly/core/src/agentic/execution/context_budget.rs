//! Resolve product model configuration before admission to the turn engine.
pub(super) use openbitfun_agent_runtime::turn_execution::context::CompressionTriggerBudget;
use openbitfun_core_types::model_pool::ModelPoolContextBudget;
use openbitfun_core_types::token_estimate::automatic_max_output_tokens;

#[cfg(test)]
pub(super) fn request_budget(
    model: &openbitfun_core_types::AIConfig,
    pool: Option<ModelPoolContextBudget>,
) -> CompressionTriggerBudget {
    request_budget_with_override(model, pool, None)
}

pub(super) fn request_budget_with_override(
    model: &openbitfun_core_types::AIConfig,
    pool: Option<ModelPoolContextBudget>,
    context_window_override: Option<usize>,
) -> CompressionTriggerBudget {
    match pool {
        Some(pool) => CompressionTriggerBudget::for_pool(pool),
        None => {
            let context_window = context_window_override.unwrap_or(model.context_window as usize);
            model_budget(context_window, model.max_tokens)
        }
    }
}

pub(super) fn model_budget(
    context_window: usize,
    configured_output: Option<u32>,
) -> CompressionTriggerBudget {
    let output =
        configured_output.unwrap_or_else(|| automatic_max_output_tokens(context_window as u32));
    CompressionTriggerBudget::for_model(context_window, output as usize)
}

#[cfg(test)]
mod tests {
    use crate::service::config::types::AIModelConfig;

    #[test]
    fn compression_budget_follows_each_selected_model() {
        for (window, max_output, input_limit) in
            [(1_048_576, 384_000, 654_576), (64_000, 16_000, 38_000)]
        {
            let model = openbitfun_core_types::AIConfig::try_from(AIModelConfig {
                context_window: Some(window),
                max_tokens: Some(max_output),
                ..Default::default()
            })
            .unwrap();
            let budget = super::request_budget(&model, None);
            assert_eq!(budget.context_window, window as usize);
            assert_eq!(budget.input_limit, input_limit);
            assert_eq!(47_544 >= budget.input_limit, window == 64_000);
        }
    }

    #[test]
    fn session_context_window_override_replaces_model_window() {
        let model = openbitfun_core_types::AIConfig::try_from(AIModelConfig {
            context_window: Some(200_000),
            max_tokens: Some(16_000),
            ..Default::default()
        })
        .unwrap();
        let default_budget = super::request_budget_with_override(&model, None, None);
        assert_eq!(default_budget.context_window, 200_000);

        for tokens in [128_000, 256_000, 300_000, 500_000, 1_000_000] {
            let overridden = super::request_budget_with_override(&model, None, Some(tokens));
            assert_eq!(overridden.context_window, tokens);
            assert!(overridden.input_limit < tokens);
        }
    }
}
