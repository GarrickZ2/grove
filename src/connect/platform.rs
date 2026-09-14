use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PlatformDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub available: bool,
    pub setup_modes: &'static [&'static str],
    pub config_fields: &'static [ConfigField],
    pub capabilities: PlatformCapabilities,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigField {
    pub key: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub required: bool,
    pub placeholder: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct PlatformCapabilities {
    pub private_chat: bool,
    pub group_chat: bool,
    pub reactions: bool,
    pub cards: bool,
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

const FEISHU_CONFIG_FIELDS: &[ConfigField] = &[
    ConfigField {
        key: "app_id",
        label: "App ID",
        secret: false,
        required: true,
        placeholder: "cli_...",
    },
    ConfigField {
        key: "app_secret",
        label: "App Secret",
        secret: true,
        required: true,
        placeholder: "App secret",
    },
];

pub fn list() -> Vec<PlatformDefinition> {
    vec![
        PlatformDefinition {
            id: "feishu",
            name: "Feishu",
            description: "For China accounts",
            available: true,
            setup_modes: &["qr", "manual"],
            config_fields: FEISHU_CONFIG_FIELDS,
            capabilities: FEISHU_CAPABILITIES,
        },
        PlatformDefinition {
            id: "lark",
            name: "Lark",
            description: "For global accounts",
            available: true,
            setup_modes: &["qr", "manual"],
            config_fields: FEISHU_CONFIG_FIELDS,
            capabilities: FEISHU_CAPABILITIES,
        },
        unavailable("telegram", "Telegram"),
        unavailable("slack", "Slack"),
        unavailable("discord", "Discord"),
    ]
}

fn unavailable(id: &'static str, name: &'static str) -> PlatformDefinition {
    PlatformDefinition {
        id,
        name,
        description: "Adapter coming later",
        available: false,
        setup_modes: &[],
        config_fields: &[],
        capabilities: PlatformCapabilities {
            private_chat: false,
            group_chat: false,
            reactions: false,
            cards: false,
            qr_registration: false,
        },
    }
}
