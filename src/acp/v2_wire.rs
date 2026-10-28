//! Version-specific v2 session setup. Local history is never sent to an Agent.

use std::path::PathBuf;

use agent_client_protocol::{
    schema::{v2, ProtocolVersion},
    Agent, InitializeOutcome, V2ConnectionTo,
};

use super::acp;

pub struct OpenedSession {
    pub id: v2::SessionId,
    pub config_options: Vec<v2::SessionConfigOption>,
    pub commands: Vec<v2::AvailableCommand>,
}

/// Translate Grove's MCP launch descriptions into the explicitly tagged v2
/// forms. Do not send transports that the Agent did not advertise.
pub fn mcp_servers(
    servers: Vec<acp::McpServer>,
    capabilities: Option<&v2::McpCapabilities>,
) -> acp::Result<Vec<v2::McpServer>> {
    let mut result = Vec::with_capacity(servers.len());
    for server in servers {
        match server {
            acp::McpServer::Stdio(server) => {
                if !capabilities.is_some_and(|capabilities| capabilities.stdio.is_some()) {
                    continue;
                }
                let env = server
                    .env
                    .into_iter()
                    .map(|item| v2::EnvVariable::new(item.name, item.value).meta(item.meta))
                    .collect();
                result.push(v2::McpServer::Stdio(
                    v2::McpServerStdio::new(server.name, server.command)
                        .args(server.args)
                        .env(env)
                        .meta(server.meta),
                ));
            }
            acp::McpServer::Http(server) => {
                if !capabilities.is_some_and(|capabilities| capabilities.http.is_some()) {
                    continue;
                }
                let headers = server
                    .headers
                    .into_iter()
                    .map(|item| v2::HttpHeader::new(item.name, item.value).meta(item.meta))
                    .collect();
                result.push(v2::McpServer::Http(
                    v2::McpServerHttp::new(server.name, server.url)
                        .headers(headers)
                        .meta(server.meta),
                ));
            }
            _ => continue,
        }
    }
    Ok(result)
}

pub async fn initialize(
    connection: &V2ConnectionTo<Agent>,
    local: bool,
) -> acp::Result<v2::InitializeResponse> {
    let mut capabilities = v2::ClientCapabilities::new().elicitation(
        v2::ElicitationCapabilities::new()
            .form(v2::ElicitationFormCapabilities::new())
            .url(v2::ElicitationUrlCapabilities::new()),
    );
    if local {
        capabilities = capabilities
            .auth(v2::AuthCapabilities::new().terminal(v2::TerminalAuthCapabilities::new()));
    }
    let request = v2::InitializeRequest::new(
        ProtocolVersion::V2,
        v2::Implementation::new("grove", env!("CARGO_PKG_VERSION")).title("Grove"),
    )
    .capabilities(capabilities);
    match connection.send_initialize(request).block_task().await? {
        InitializeOutcome::Initialized(response) => Ok(response),
        InitializeOutcome::LowerVersion(mismatch) => Err(acp::Error::new(
            -32022,
            format!(
                "ACP v2 was selected, but the Agent selected version {}",
                mismatch.selected.as_u16()
            ),
        )
        .data(serde_json::json!({"requested": 2, "supported": [mismatch.selected.as_u16()], "grove_lower_version": true}))),
        _ => Err(acp::Error::internal_error().data("Unsupported ACP initialization outcome")),
    }
}

pub async fn open_session(
    connection: &V2ConnectionTo<Agent>,
    cwd: PathBuf,
    saved_id: Option<String>,
    replay: bool,
    servers: Vec<v2::McpServer>,
    directories: Vec<PathBuf>,
    system_prompt: Option<v2::SystemPrompt>,
) -> acp::Result<OpenedSession> {
    if let Some(id) = saved_id {
        let session_id = v2::SessionId::new(id);
        let mut request = v2::ResumeSessionRequest::new(session_id.clone(), cwd)
            .mcp_servers(servers)
            .additional_directories(directories)
            .system_prompt(system_prompt);
        if replay {
            request = request.replay_from(v2::ReplayFrom::Start(v2::ReplayFromStart::new()));
        }
        let response = connection.send_request(request).block_task().await?;
        Ok(OpenedSession {
            id: session_id,
            config_options: response.config_options,
            commands: response.available_commands,
        })
    } else {
        let response = connection
            .send_request(
                v2::NewSessionRequest::new(cwd)
                    .mcp_servers(servers)
                    .additional_directories(directories)
                    .system_prompt(system_prompt),
            )
            .block_task()
            .await?;
        Ok(OpenedSession {
            id: response.session_id,
            config_options: response.config_options,
            commands: response.available_commands,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_transports_advertised_by_the_agent_are_sent() {
        let configured = vec![
            acp::McpServer::Stdio(acp::McpServerStdio::new("local", "/bin/echo")),
            acp::McpServer::Http(acp::McpServerHttp::new(
                "remote",
                "https://example.invalid/mcp",
            )),
        ];
        let caps = v2::McpCapabilities::new().http(v2::McpHttpCapabilities::new());
        let result = mcp_servers(configured, Some(&caps)).unwrap();
        assert_eq!(result.len(), 1);
        assert!(matches!(&result[0], v2::McpServer::Http(server) if server.name == "remote"));
        assert!(mcp_servers(
            vec![acp::McpServer::Stdio(acp::McpServerStdio::new(
                "local",
                "/bin/echo"
            ))],
            None
        )
        .unwrap()
        .is_empty());
    }
}
