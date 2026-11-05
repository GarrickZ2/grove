//! Session tools shared by the Buddy and Agent Graph MCP servers. Both expose
//! the same names, schemas and behaviour; each passes its own scope. `#[tool]`
//! takes only string literals, so the descriptions are spelled out on both
//! servers and a test keeps them identical.

use super::buddy_mcp::success;
use crate::buddy::tools::{ManageQueueInput, ReadSessionInput, SearchSessionsInput};
use crate::session_scope::SessionScope;
use rmcp::model::{CallToolResult, Content};
use rmcp::ErrorData as McpError;

fn failed(error: impl std::fmt::Display) -> CallToolResult {
    CallToolResult::error(vec![Content::text(error.to_string())])
}

pub(super) fn read_session(
    scope: &SessionScope,
    input: ReadSessionInput,
) -> Result<CallToolResult, McpError> {
    let page = match crate::buddy::tools::read_session(scope, input) {
        Ok(page) => page,
        Err(error) => return Ok(failed(error)),
    };
    let mut result = success(page.value)?;
    result.content.extend(
        page.images
            .into_iter()
            .map(|(data, mime_type)| Content::image(data, mime_type)),
    );
    Ok(result)
}

pub(super) fn search_sessions(
    scope: &SessionScope,
    input: SearchSessionsInput,
) -> Result<CallToolResult, McpError> {
    match crate::buddy::tools::search_sessions(scope, input) {
        Ok(value) => success(value),
        Err(error) => Ok(failed(error)),
    }
}

pub(super) async fn manage_queue(
    scope: &SessionScope,
    input: ManageQueueInput,
) -> Result<CallToolResult, McpError> {
    match crate::buddy::tools::manage_queue(scope, input).await {
        Ok(value) => success(value),
        Err(error) => Ok(failed(error)),
    }
}
