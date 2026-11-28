//! Resolve product model configuration before admission to the turn engine.
pub(super) use openbitfun_agent_runtime::turn_execution::context::CompressionTriggerBudget;
use openbitfun_core_types::model_pool::ModelPoolContextBudget;
use openbitfun_core_types::token_estimate::{automatic_max_output_tokens, input_safety_reserve};

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
            let model_window = model.context_window as usize;
            let Some(override_window) = context_window_override else {
                return model_budget(model_window, model.max_tokens);
            };
            if override_window < model_window {
                // `model.max_tokens` was sized for `model.context_window`, not a
                // narrower session override. Scale output reserve to the override
                // window so a 1M model overridden to 128k still reaches its 80%
                // target, while never exceeding the underlying model's physical
                // input capacity.
                let auto_override_output =
                    automatic_max_output_tokens(override_window.min(u32::MAX as usize) as u32);
                let effective_output = model
                    .max_tokens
                    .map(|configured| configured.min(auto_override_output));
                let mut budget = model_budget(override_window, effective_output);
                let model_output = model
                    .max_tokens
                    .unwrap_or_else(|| automatic_max_output_tokens(model.context_window))
                    as usize;
                let model_hard_input_limit = model_window.saturating_sub(
                    model_output.saturating_add(input_safety_reserve(model_window)),
                );
                budget.input_limit = budget.input_limit.min(model_hard_input_limit);
                budget
            } else {
                model_budget(override_window, model.max_tokens)
            }
        }
    }
}

pub(super) fn model_budget(
    context_window: usize,
    configured_output: Option<u32>,
) -> CompressionTriggerBudget {
    let output = configured_output.unwrap_or_else(|| {
        automatic_max_output_tokens(context_window.min(u32::MAX as usize) as u32)
    });
    CompressionTriggerBudget::for_model(context_window, output as usize)
}

#[cfg(test)]
mod tests {
    use crate::service::config::types::AIModelConfig;

    #[test]
    fn compression_budget_follows_each_selected_model() {
        for (window, max_output, input_limit) in
            [(1_048_576, 384_000, 524_288), (64_000, 16_000, 44_800)]
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
            context_window: Some(1_000_000),
            max_tokens: None,
            ..Default::default()
        })
        .unwrap();
        let default_budget = super::request_budget_with_override(&model, None, None);
        assert_eq!(default_budget.context_window, 1_000_000);
        assert_eq!(default_budget.input_limit, 500_000);

        // Narrowing a 1M model (64k auto output) down to 128k must still reach
        // the 80% target instead of subtracting 64k from 128k.
        let narrowed = super::request_budget_with_override(&model, None, Some(128_000));
        assert_eq!(narrowed.context_window, 128_000);
        assert_eq!(narrowed.input_limit, 102_400);

        let mut prev = 0usize;
        for tokens in [128_000, 256_000, 300_000, 500_000, 1_000_000] {
            let overridden = super::request_budget_with_override(&model, None, Some(tokens));
            assert_eq!(overridden.context_window, tokens);
            assert!(overridden.input_limit < tokens);
            assert!(overridden.input_limit > prev);
            prev = overridden.input_limit;
        }

        // Narrowing an override must never exceed the underlying model's hard capacity.
        let tight_model = openbitfun_core_types::AIConfig::try_from(AIModelConfig {
            context_window: Some(128_000),
            max_tokens: Some(48_000),
            ..Default::default()
        })
        .unwrap();
        let capped = super::request_budget_with_override(&tight_model, None, Some(100_000));
        assert_eq!(capped.input_limit, 73_600);
    }
}
