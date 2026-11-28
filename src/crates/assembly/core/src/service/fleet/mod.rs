//! Fleet: this runtime host's own summary partition (the owner side).
//!
//! The replication, index and routing live in `openbitfun-obp` (feature
//! `fleet`); this module only produces the digest every other host pulls
//! with `fleet_digest`, from the existing owners (workspace catalog, session
//! store, Runtime mailbox, Detached Dispatch store), and the account-wide
//! model catalog of this host (`models`): what it publishes, and how a
//! session here runs another device's model.

#[cfg(feature = "agent-runtime")]
pub mod agent_control;
pub mod digest;
pub mod models;

#[cfg(feature = "agent-runtime")]
pub use agent_control::{execute_fleet_control, forward_product_control, FleetControlHost};
pub use digest::*;
