//! Input budgets and emergency history trimming for model requests.
use openbitfun_core_types::model_pool::ModelPoolContextBudget;
use openbitfun_core_types::token_estimate::input_safety_reserve;

const COMPRESSION_CURVE_MIN_WINDOW: f64 = 128_000.0;
const COMPRESSION_CURVE_MAX_WINDOW: f64 = 1_000_000.0;
const COMPRESSION_CURVE_MAX_RATIO: f64 = 0.80;
const COMPRESSION_CURVE_MIN_RATIO: f64 = 0.50;

/// Target automatic-compression trigger ratio for a given context window.
///
/// Larger windows suffer from attention dilution, latency, and cost growth long
/// before the hard provider limit is reached, while smaller windows need high
/// utilization before compacting. Interpolates smoothly on a logarithmic scale
/// from 80% at 128k down to 50% at 1M (~10% drop per context doubling), while
/// keeping absolute trigger tokens strictly monotonically increasing.
pub fn target_compression_ratio(context_window: usize) -> f64 {
    if context_window == 0 {
        return COMPRESSION_CURVE_MAX_RATIO;
    }
    let window = context_window as f64;
    if window <= COMPRESSION_CURVE_MIN_WINDOW {
        return COMPRESSION_CURVE_MAX_RATIO;
    }
    if window >= COMPRESSION_CURVE_MAX_WINDOW {
        return COMPRESSION_CURVE_MIN_RATIO;
    }
    let progress = (window / COMPRESSION_CURVE_MIN_WINDOW).ln()
        / (COMPRESSION_CURVE_MAX_WINDOW / COMPRESSION_CURVE_MIN_WINDOW).ln();
    COMPRESSION_CURVE_MAX_RATIO
        - (COMPRESSION_CURVE_MAX_RATIO - COMPRESSION_CURVE_MIN_RATIO) * progress
}

/// Target automatic-compression token threshold before applying hard window reserves.
pub fn target_compression_input_limit(context_window: usize) -> usize {
    let ratio = target_compression_ratio(context_window);
    (((context_window as f64) * ratio).round() as usize).min(context_window)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompressionTriggerBudget {
    pub context_window: usize,
    pub input_limit: usize,
    pub output_reserve_tokens: usize,
    pub safety_reserve_tokens: usize,
}

impl CompressionTriggerBudget {
    pub fn for_model(context_window: usize, output_reserve_tokens: usize) -> Self {
        let safety_reserve_tokens = input_safety_reserve(context_window);
        let hard_input_limit = context_window
            .saturating_sub(output_reserve_tokens.saturating_add(safety_reserve_tokens));
        let target_input_limit = target_compression_input_limit(context_window);
        Self {
            context_window,
            input_limit: hard_input_limit.min(target_input_limit),
            output_reserve_tokens,
            safety_reserve_tokens,
        }
    }

    pub fn for_pool(budget: ModelPoolContextBudget) -> Self {
        let context_window = budget.context_window as usize;
        let input_limit =
            (budget.input_limit as usize).min(target_compression_input_limit(context_window));
        let safety_reserve_tokens = input_safety_reserve(context_window);
        Self {
            context_window,
            input_limit,
            // This is an equivalent reserve for the common window, not a new
            // max_tokens setting for any member's provider request.
            output_reserve_tokens: context_window
                .saturating_sub(input_limit.saturating_add(safety_reserve_tokens)),
            safety_reserve_tokens,
        }
    }
}

/// Preserve the complete head through the first user message. Drop the oldest
/// exchanges as units so a retained assistant call keeps its tool replies.
pub fn trim_history<M>(
    messages: Vec<M>,
    context_window: usize,
    is_user: impl Fn(&M) -> bool,
    is_tool: impl Fn(&M) -> bool,
    token_count: impl Fn(&M) -> usize,
    request_overhead: impl FnOnce() -> usize,
) -> Vec<M> {
    // Separate preserved head (system + first user) from droppable body.
    let mut preserved: Vec<M> = Vec::new();
    let mut droppable: Vec<M> = Vec::new();
    let mut seen_first_user = false;

    for msg in messages {
        if !seen_first_user {
            let is_user = is_user(&msg);
            preserved.push(msg);
            if is_user {
                seen_first_user = true;
            }
        } else {
            droppable.push(msg);
        }
    }

    if droppable.is_empty() {
        return preserved;
    }

    // Group droppable messages into API rounds.
    // An API round starts with an Assistant message and includes all
    // following Tool messages until the next Assistant or User message.
    let mut rounds: Vec<Vec<M>> = Vec::new();
    for msg in droppable {
        if is_tool(&msg) {
            if let Some(previous) = rounds.last_mut() {
                previous.push(msg);
                continue;
            }
        }
        rounds.push(vec![msg]);
    }

    // Drop rounds from the front until we fit.
    let preserved_tokens = preserved.iter().map(&token_count).sum::<usize>() + request_overhead();

    let mut kept_start = 0;
    let mut total_tokens = preserved_tokens
        + rounds
            .iter()
            .flat_map(|r| r.iter())
            .map(&token_count)
            .sum::<usize>();

    while total_tokens > context_window && kept_start < rounds.len() {
        let round_tokens: usize = rounds[kept_start].iter().map(&token_count).sum();
        total_tokens -= round_tokens;
        kept_start += 1;
    }

    if kept_start > 0 {
        log::warn!(
            "Emergency truncation dropped {} API round(s) from context head",
            kept_start
        );
    }

    let mut result = preserved;
    for round in rounds.into_iter().skip(kept_start) {
        result.extend(round);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{
        target_compression_input_limit, target_compression_ratio, trim_history,
        CompressionTriggerBudget,
    };
    use openbitfun_core_types::model_pool::ModelPoolContextBudget;
    use openbitfun_core_types::token_estimate::automatic_max_output_tokens;

    #[test]
    fn compression_curve_maps_128k_to_80_percent_and_1m_to_50_percent() {
        assert_eq!(target_compression_input_limit(128_000), 102_400);
        assert_eq!(target_compression_input_limit(1_000_000), 500_000);
        assert_eq!(target_compression_input_limit(1_048_576), 524_288);
        assert_eq!(target_compression_input_limit(64_000), 51_200);

        let b128 = CompressionTriggerBudget::for_model(
            128_000,
            automatic_max_output_tokens(128_000) as usize,
        );
        assert_eq!(b128.input_limit, 102_400);
        assert_eq!(b128.output_reserve_tokens, 16_000);
        assert_eq!(b128.safety_reserve_tokens, 6_400);

        let b1m = CompressionTriggerBudget::for_model(
            1_000_000,
            automatic_max_output_tokens(1_000_000) as usize,
        );
        assert_eq!(b1m.input_limit, 500_000);
        assert_eq!(b1m.output_reserve_tokens, 64_000);
        assert_eq!(b1m.safety_reserve_tokens, 10_000);
    }

    #[test]
    fn compression_curve_decreases_ratio_and_increases_tokens_monotonically() {
        let windows = [
            32_000, 64_000, 128_000, 150_000, 200_000, 256_000, 300_000, 400_000, 500_000, 750_000,
            1_000_000, 1_048_576, 2_000_000,
        ];
        let mut prev_ratio = f64::INFINITY;
        let mut prev_tokens = 0usize;
        for window in windows {
            let ratio = target_compression_ratio(window);
            let output = automatic_max_output_tokens(window as u32) as usize;
            let budget = CompressionTriggerBudget::for_model(window, output);
            assert!(
                ratio <= prev_ratio + f64::EPSILON,
                "ratio should not increase at window={window}: {ratio} > {prev_ratio}"
            );
            assert!(
                budget.input_limit > prev_tokens,
                "input_limit should strictly increase at window={window}: {} <= {prev_tokens}",
                budget.input_limit
            );
            assert!(
                budget.input_limit + budget.output_reserve_tokens + budget.safety_reserve_tokens
                    <= window,
                "hard safety invariant violated at window={window}"
            );
            if window >= 128_000 {
                assert_eq!(budget.input_limit, target_compression_input_limit(window));
            }
            prev_ratio = ratio;
            prev_tokens = budget.input_limit;
        }
    }

    #[test]
    fn explicit_large_output_reserve_still_caps_hard_input_limit() {
        let budget = CompressionTriggerBudget::for_model(128_000, 48_000);
        assert_eq!(budget.safety_reserve_tokens, 6_400);
        assert_eq!(budget.input_limit, 73_600);
    }

    #[test]
    fn pool_budget_applies_curve_to_legacy_high_input_limits_and_keeps_tight_members() {
        let legacy_1m = CompressionTriggerBudget::for_pool(ModelPoolContextBudget {
            context_window: 1_000_000,
            input_limit: 926_000,
        });
        assert_eq!(legacy_1m.input_limit, 500_000);
        assert_eq!(legacy_1m.safety_reserve_tokens, 10_000);

        let tight = CompressionTriggerBudget::for_pool(ModelPoolContextBudget {
            context_window: 128_000,
            input_limit: 88_000,
        });
        assert_eq!(tight.input_limit, 88_000);
        assert_eq!(tight.safety_reserve_tokens, 6_400);
        assert_eq!(
            tight.input_limit + tight.output_reserve_tokens + tight.safety_reserve_tokens,
            128_000
        );
    }

    #[test]
    fn truncation_keeps_the_first_user_message_and_never_orphans_a_tool_result() {
        let history = vec![
            "system",
            "user",
            "assistant A",
            "tool A",
            "tool B",
            "assistant B",
            "tool C",
        ];
        let retained = trim_history(
            history,
            5,
            |m| *m == "user",
            |m| m.starts_with("tool"),
            |_| 1,
            || 1,
        );
        assert_eq!(retained, ["system", "user", "assistant B", "tool C"]);
    }
}
