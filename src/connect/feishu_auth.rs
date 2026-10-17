//! Outbound token recovery, without modifying the SDK's private cache.
use async_trait::async_trait;
use lark_channel::lark_openapi::{OpenApiClient, OpenApiTransport};
use tokio::sync::Mutex;

// async_trait emits #[must_use] on boxed futures; Clippy 1.99 treats the
// future's own #[must_use] as sufficient.
#[allow(clippy::double_must_use)]
#[async_trait]
pub(super) trait TenantTokens: Send + Sync {
    async fn token(&self) -> Result<String, String>;
    async fn refresh(&self, rejected: &str) -> Result<String, String>;
}

pub(super) struct SdkTokens<T> {
    client: Mutex<OpenApiClient<T>>,
    transport: T,
}

impl<T: OpenApiTransport> SdkTokens<T> {
    pub fn new(client: OpenApiClient<T>, transport: T) -> Self {
        Self {
            client: Mutex::new(client),
            transport,
        }
    }
}

#[async_trait]
impl<T: OpenApiTransport> TenantTokens for SdkTokens<T> {
    async fn token(&self) -> Result<String, String> {
        self.client
            .lock()
            .await
            .tenant_access_token()
            .await
            .map_err(|error| error.to_string())
    }

    async fn refresh(&self, rejected: &str) -> Result<String, String> {
        let mut client = self.client.lock().await;
        let current = client
            .tenant_access_token()
            .await
            .map_err(|error| error.to_string())?;
        if current != rejected {
            // Another request (or expiry-based refresh) already replaced it.
            return Ok(current);
        }
        *client = OpenApiClient::new(client.config().clone(), self.transport.clone());
        client
            .tenant_access_token()
            .await
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use lark_channel::lark_openapi::{BoxFuture, HttpRequest, HttpResponse};
    use lark_channel::ChannelConfig;
    use serde_json::json;

    use super::*;

    #[derive(Clone)]
    struct TokenTransport(Arc<AtomicUsize>);

    impl OpenApiTransport for TokenTransport {
        fn send_json(
            &self,
            request: HttpRequest,
        ) -> BoxFuture<'static, lark_channel::Result<HttpResponse>> {
            let calls = self.0.clone();
            Box::pin(async move {
                assert_eq!(
                    request.url.path(),
                    "/open-apis/auth/v3/tenant_access_token/internal"
                );
                let index = calls.fetch_add(1, Ordering::SeqCst);
                Ok(HttpResponse::json(
                    200,
                    json!({
                        "code": 0, "tenant_access_token": format!("token-{index}"), "expire": 7200
                    }),
                ))
            })
        }
    }

    #[tokio::test]
    async fn invalid_token_refresh_replaces_sdk_cache_and_coalesces_concurrent_refreshes() {
        let calls = Arc::new(AtomicUsize::new(0));
        let transport = TokenTransport(calls.clone());
        let client = OpenApiClient::new(ChannelConfig::new("app", "secret"), transport.clone());
        let tokens = SdkTokens::new(client, transport);
        assert_eq!(tokens.token().await.unwrap(), "token-0");
        assert_eq!(tokens.token().await.unwrap(), "token-0");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let (a, b) = tokio::join!(tokens.refresh("token-0"), tokens.refresh("token-0"));
        assert_eq!(a.unwrap(), "token-1");
        assert_eq!(b.unwrap(), "token-1");
        assert_eq!(tokens.token().await.unwrap(), "token-1");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
