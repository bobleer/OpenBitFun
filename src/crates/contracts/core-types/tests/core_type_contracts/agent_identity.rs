use openbitfun_core_types::agent_identity::{
    canonical_agent_config_id, canonical_agent_id, HarnessId,
};

#[test]
fn legacy_harness_ids_read_as_canonical_and_write_only_canonical_ids() {
    for (legacy, canonical) in [
        ("minimal", "Minimal"),
        ("balanced", "Standard"),
        ("agentic", "Standard"),
        ("Agentic", "Standard"),
        ("Ultra", "Ultimate"),
        ("ultimate", "Ultimate"),
        ("creative", "Creative"),
    ] {
        let parsed: HarnessId = serde_json::from_value(serde_json::json!(legacy)).unwrap();
        assert_eq!(parsed.as_str(), canonical);
        assert_eq!(serde_json::to_value(parsed).unwrap(), canonical);
        assert_eq!(
            HarnessId::from_legacy_id(parsed.legacy_wire_id()),
            Some(parsed)
        );
    }
}

#[test]
fn unknown_and_source_qualified_agent_identity_survives_normalization() {
    for id in [
        "Claw",
        "DeepResearch",
        "custom::agentic",
        "external::Ultra",
        "FutureHarness",
    ] {
        assert_eq!(canonical_agent_id(id), id);
    }
    assert_eq!(canonical_agent_config_id("coding_shared"), "Standard");
    assert_eq!(canonical_agent_id("coding_shared"), "coding_shared");
}
