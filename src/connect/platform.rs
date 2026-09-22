use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct PlatformDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub available: bool,
    pub setup_modes: Vec<String>,
    pub config_fields: Vec<ConfigField>,
    pub capabilities: PlatformCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct PlatformCapabilities {
    #[serde(default)]
    pub private_chat: bool,
    #[serde(default)]
    pub group_chat: bool,
    #[serde(default)]
    pub reactions: bool,
    #[serde(default)]
    pub cards: bool,
    #[serde(default)]
    pub qr_registration: bool,
}

const FEISHU_CAPABILITIES: PlatformCapabilities = PlatformCapabilities {
    private_chat: true,
    group_chat: false,
    reactions: true,
    // Interactive cards with form callbacks are implemented (lark-channel
    // card.action.trigger over the WebSocket event connection).
    cards: true,
    qr_registration: true,
};

fn feishu_config_fields() -> Vec<ConfigField> {
    vec![
        ConfigField {
            key: "app_id".into(),
            label: "App ID".into(),
            secret: false,
            required: true,
            placeholder: "cli_...".into(),
        },
        ConfigField {
            key: "app_secret".into(),
            label: "App Secret".into(),
            secret: true,
            required: true,
            placeholder: "App secret".into(),
        },
    ]
}

pub fn list() -> Vec<PlatformDefinition> {
    vec![
        PlatformDefinition {
            id: "feishu".into(),
            name: "Feishu".into(),
            description: "For China accounts".into(),
            available: true,
            setup_modes: vec!["qr".into(), "manual".into()],
            config_fields: feishu_config_fields(),
            capabilities: FEISHU_CAPABILITIES,
        },
        PlatformDefinition {
            id: "lark".into(),
            name: "Lark".into(),
            description: "For global accounts".into(),
            available: true,
            setup_modes: vec!["qr".into(), "manual".into()],
            config_fields: feishu_config_fields(),
            capabilities: FEISHU_CAPABILITIES,
        },
        unavailable("telegram", "Telegram"),
        unavailable("slack", "Slack"),
        unavailable("discord", "Discord"),
    ]
}

fn unavailable(id: &str, name: &str) -> PlatformDefinition {
    PlatformDefinition {
        id: id.into(),
        name: name.into(),
        description: "Adapter coming later".into(),
        available: false,
        setup_modes: Vec::new(),
        config_fields: Vec::new(),
        capabilities: PlatformCapabilities {
            private_chat: false,
            group_chat: false,
            reactions: false,
            cards: false,
            qr_registration: false,
        },
    }
}
