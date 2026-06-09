//! OpenCode multi-provider quota dispatcher.
//!
//! Reads credentials from OpenCode's `~/.local/share/opencode/auth.json`.
//! Key names here are OpenCode-specific and must NOT be shared with other agents.

use super::super::opencode_auth::read_opencode_token;
use super::super::providers::zai;
use super::super::{AcpQuotaProvider, AgentUsage};
use super::{classify_model, dispatch_upstream, Upstream};

// OpenCode auth.json key names (flat map in ~/.local/share/opencode/auth.json).
// NOTE: OpenCode stores MiniMax under "minimax-coding-plan" (verified against a
// real auth.json), NOT the bare "minimax" used by Hermes/standalone providers.
// Do NOT "align" this to "minimax" — that would break OpenCode MiniMax quota.
const KEY_MINIMAX: &str = "minimax-coding-plan";
const KEY_KIMI: &str = "kimi-for-coding";
const KEY_SYNTHETIC: &str = "synthetic";
const KEY_COPILOT: &str = "github-copilot";

pub struct OpencodeProvider;

impl AcpQuotaProvider for OpencodeProvider {
    fn provider_id(&self) -> &str {
        "opencode"
    }

    fn quota_id(&self, model: Option<&str>) -> String {
        let upstream = model.map(classify_model).unwrap_or(Upstream::Unknown);
        format!("opencode:{}", upstream.as_str())
    }

    fn fetch_usage(&self, model: Option<&str>) -> Result<AgentUsage, String> {
        let upstream = model.map(classify_model).unwrap_or(Upstream::Unknown);
        dispatch_upstream(upstream, "opencode", |up| match up {
            Upstream::MiniMax => read_opencode_token(KEY_MINIMAX),
            Upstream::Kimi => read_opencode_token(KEY_KIMI),
            Upstream::Synthetic => read_opencode_token(KEY_SYNTHETIC),
            Upstream::Copilot => read_opencode_token(KEY_COPILOT),
            Upstream::Zai => zai::resolve_token(),
            Upstream::Unknown => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_known_prefixes() {
        assert_eq!(
            classify_model("synthetic/gpt-oss-120b"),
            Upstream::Synthetic
        );
        assert_eq!(classify_model("moonshotai/kimi-k2"), Upstream::Kimi);
        assert_eq!(classify_model("zai/glm-4.5"), Upstream::Zai);
        assert_eq!(classify_model("zhipuai/glm-4-plus"), Upstream::Zai);
        assert_eq!(classify_model("github-copilot/gpt-4o"), Upstream::Copilot);
        assert_eq!(classify_model("minimax/MiniMax-M*"), Upstream::MiniMax);
        assert_eq!(classify_model("minimaxi/MiniMax-M2"), Upstream::MiniMax);
        assert_eq!(
            classify_model("anthropic/claude-sonnet-4"),
            Upstream::Unknown
        );
    }

    #[test]
    fn classify_loose_keyword() {
        assert_eq!(classify_model("some-kimi-variant"), Upstream::Kimi);
        assert_eq!(classify_model("custom-glm-model"), Upstream::Zai);
        assert_eq!(classify_model("my-zai-custom"), Upstream::Zai);
        assert_eq!(classify_model("vendor-z-ai-plan"), Upstream::Zai);
    }
}
