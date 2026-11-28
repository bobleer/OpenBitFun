//! Compatibility re-export for mode-aware built-in skill policy.
//!
//! The provider-neutral owner lives in `openbitfun-agent-runtime`.

pub use openbitfun_agent_runtime::skills::resolve_builtin_default_enabled;

#[cfg(test)]
mod tests {
    use super::resolve_builtin_default_enabled;

    #[test]
    fn builtin_defaults_follow_mode_policies() {
        assert_eq!(
            resolve_builtin_default_enabled("ppt-design", "Standard"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("ppt-design", "Claw"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("ppt-design", "Ultimate"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("agent-browser", "Standard"),
            Some(false)
        );
        assert_eq!(
            resolve_builtin_default_enabled("agent-browser", "Claw"),
            Some(false)
        );
        assert_eq!(
            resolve_builtin_default_enabled("agent-browser", "Ultimate"),
            Some(false)
        );
        assert_eq!(
            resolve_builtin_default_enabled("find-skills", "DeepResearch"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("ppt-design", "DeepResearch"),
            Some(false)
        );
        assert_eq!(
            resolve_builtin_default_enabled("commit-push-pr", "Claw"),
            Some(false)
        );
        assert_eq!(
            resolve_builtin_default_enabled("commit-push-pr", "Ultimate"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("ppt-design", "Other"),
            Some(false)
        );
        assert_eq!(
            resolve_builtin_default_enabled("plan", "Ultimate"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("find-skills", "Ultimate"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("agent-browser", "SwarmWorker"),
            Some(true)
        );
        assert_eq!(
            resolve_builtin_default_enabled("plan", "SwarmWorker"),
            Some(false)
        );
    }

    #[test]
    fn unknown_builtins_return_none() {
        assert_eq!(
            resolve_builtin_default_enabled("not-real", "Standard"),
            None
        );
    }
}
