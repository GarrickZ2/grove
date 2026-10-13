//! Observe the SDK lifecycle while retaining its heartbeat/reconnect policy.
use std::time::Duration;

use lark_channel::event::{EventConnection, EventConnectionItem, EventStreamConnector};
use lark_channel::lark_openapi::{
    WebSocketClientConfig, WebSocketEvent, WebSocketEventAck, WebSocketEventFrame,
};

use super::feishu::set_status;
use super::feishu_transport::{log_error, safe};

pub(super) async fn retry_credentials<T: lark_channel::lark_openapi::OpenApiTransport>(
    client: &lark_channel::lark_openapi::OpenApiClient<T>,
    on_retry: impl FnMut(String) + Send,
) -> lark_channel::Result<()> {
    retry_credentials_with_delays(
        client,
        on_retry,
        [Duration::from_secs(2), Duration::from_secs(5)],
    )
    .await
}

async fn retry_credentials_with_delays<T: lark_channel::lark_openapi::OpenApiTransport>(
    client: &lark_channel::lark_openapi::OpenApiClient<T>,
    mut on_retry: impl FnMut(String) + Send,
    delays: [Duration; 2],
) -> lark_channel::Result<()> {
    for (attempt, delay) in delays
        .into_iter()
        .map(Some)
        .chain(std::iter::once(None))
        .enumerate()
    {
        match client.tenant_access_token().await {
            Ok(_) => return Ok(()),
            Err(error) => {
                // Authentication/configuration failures require user action;
                // only transport and transient server failures are retried.
                let transient = matches!(
                    &error,
                    lark_channel::Error::Transport(_)
                        | lark_channel::Error::HttpStatus {
                            status: 429 | 500..=599
                        }
                );
                if !transient {
                    return Err(error);
                }
                let Some(delay) = delay else {
                    return Err(error);
                };
                let seconds = delay.as_secs();
                on_retry(format!(
                    "Credential verification failed; retry {}/3 in {seconds}s: {}",
                    attempt + 2,
                    safe(&error.to_string())
                ));
                tokio::time::sleep(delay).await;
            }
        }
    }
    unreachable!()
}

pub(super) struct ObservedConnector<C> {
    pub inner: C,
    pub id: String,
}

impl<C: EventStreamConnector + Send> EventStreamConnector for ObservedConnector<C>
where
    C::Connection: Send,
{
    type Connection = ObservedConnection<C::Connection>;

    async fn connect_event_stream(&mut self) -> lark_channel::Result<Self::Connection> {
        set_status(
            &self.id,
            "connecting",
            Some("Establishing long connection".into()),
        );
        let result =
            tokio::time::timeout(Duration::from_secs(40), self.inner.connect_event_stream())
                .await
                .unwrap_or_else(|_| {
                    Err(lark_channel::Error::Transport(
                        "Long connection timed out after 40s".into(),
                    ))
                });
        match result {
            Ok(inner) => {
                set_status(&self.id, "online", None);
                Ok(ObservedConnection {
                    inner,
                    id: self.id.clone(),
                })
            }
            Err(error) => {
                log_error(&self.id, "WebSocket connection", &error.to_string());
                set_status(
                    &self.id,
                    "connecting",
                    Some(format!(
                        "Long connection failed; retry pending: {}",
                        safe(&error.to_string())
                    )),
                );
                Err(error)
            }
        }
    }

    fn websocket_client_config(&self) -> Option<WebSocketClientConfig> {
        self.inner.websocket_client_config()
    }
}

pub(super) struct ObservedConnection<C> {
    inner: C,
    id: String,
}

impl<C> ObservedConnection<C> {
    fn failed(&self, error: &lark_channel::Error) {
        log_error(&self.id, "WebSocket stream", &error.to_string());
        set_status(
            &self.id,
            "connecting",
            Some(format!(
                "Connection interrupted: {}",
                safe(&error.to_string())
            )),
        );
    }
    fn closed(&self) {
        log_error(
            &self.id,
            "WebSocket stream",
            "Connection closed unexpectedly",
        );
        set_status(
            &self.id,
            "connecting",
            Some("Connection closed; retry pending".into()),
        );
    }
}

impl<C: EventConnection + Send> EventConnection for ObservedConnection<C> {
    async fn next_websocket_event(
        &mut self,
    ) -> lark_channel::Result<Option<(WebSocketEventFrame, WebSocketEvent)>> {
        let result = self.inner.next_websocket_event().await;
        match &result {
            Ok(None) => self.closed(),
            Err(error) => self.failed(error),
            _ => {}
        }
        result
    }
    async fn next_websocket_item(&mut self) -> lark_channel::Result<EventConnectionItem> {
        let result = self.inner.next_websocket_item().await;
        match &result {
            Ok(EventConnectionItem::Closed) => self.closed(),
            Err(error) => self.failed(error),
            _ => {}
        }
        result
    }
    async fn ack_websocket_event(
        &mut self,
        frame: &WebSocketEventFrame,
        ack: WebSocketEventAck,
    ) -> lark_channel::Result<()> {
        let result = self.inner.ack_websocket_event(frame, ack).await;
        if let Err(error) = &result {
            self.failed(error);
        }
        result
    }
    fn heartbeat_interval(&self) -> Option<Duration> {
        self.inner.heartbeat_interval()
    }
    fn websocket_client_config(&self) -> Option<WebSocketClientConfig> {
        self.inner.websocket_client_config()
    }
    async fn send_heartbeat(&mut self) -> lark_channel::Result<()> {
        let result = self.inner.send_heartbeat().await;
        if let Err(error) = &result {
            self.failed(error);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lark_channel::lark_openapi::{
        BoxFuture, HttpRequest, HttpResponse, OpenApiClient, OpenApiTransport,
    };
    use lark_channel::ChannelConfig;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[derive(Clone)]
    struct TokenTransport {
        calls: Arc<AtomicUsize>,
        failures: usize,
        permanent: bool,
    }
    impl OpenApiTransport for TokenTransport {
        fn send_json(
            &self,
            _: HttpRequest,
        ) -> BoxFuture<'static, lark_channel::Result<HttpResponse>> {
            let index = self.calls.fetch_add(1, Ordering::SeqCst);
            let permanent = self.permanent;
            let failures = self.failures;
            Box::pin(async move {
                if permanent {
                    return Err(lark_channel::Error::Api {
                        code: 10003,
                        message: "invalid credentials".into(),
                    });
                }
                if index < failures {
                    return Err(lark_channel::Error::Transport("connection refused".into()));
                }
                Ok(HttpResponse::json(
                    200,
                    serde_json::json!({"code":0,"tenant_access_token":"test-token","expire":7200}),
                ))
            })
        }
    }

    async fn credential_case(failures: usize, permanent: bool) -> (bool, usize, Vec<String>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let transport = TokenTransport {
            calls: calls.clone(),
            failures,
            permanent,
        };
        let client = OpenApiClient::new(ChannelConfig::new("test", "secret"), transport);
        let mut retries = Vec::new();
        let result = retry_credentials_with_delays(
            &client,
            |message| retries.push(message),
            [Duration::ZERO; 2],
        )
        .await;
        (result.is_ok(), calls.load(Ordering::SeqCst), retries)
    }

    #[tokio::test]
    async fn startup_recovers_from_transient_failures() {
        let (ok, calls, retries) = credential_case(2, false).await;
        assert!(ok);
        assert_eq!(calls, 3);
        assert_eq!(retries.len(), 2);
        assert!(retries[1].contains("retry 3/3"));
    }

    #[tokio::test]
    async fn startup_stops_after_three_attempts_and_never_retries_invalid_credentials() {
        let (ok, calls, retries) = credential_case(usize::MAX, false).await;
        assert!(!ok);
        assert_eq!((calls, retries.len()), (3, 2));
        let (ok, calls, retries) = credential_case(0, true).await;
        assert!(!ok);
        assert_eq!((calls, retries.len()), (1, 0));
    }

    struct FakeConnection;
    impl EventConnection for FakeConnection {
        async fn next_websocket_event(
            &mut self,
        ) -> lark_channel::Result<Option<(WebSocketEventFrame, WebSocketEvent)>> {
            Ok(None)
        }
        async fn ack_websocket_event(
            &mut self,
            _: &WebSocketEventFrame,
            _: WebSocketEventAck,
        ) -> lark_channel::Result<()> {
            Ok(())
        }
        fn heartbeat_interval(&self) -> Option<Duration> {
            Some(Duration::from_secs(120))
        }
    }

    struct PendingConnector {
        started: Arc<tokio::sync::Notify>,
        result: tokio::sync::oneshot::Receiver<bool>,
    }
    impl EventStreamConnector for PendingConnector {
        type Connection = FakeConnection;
        async fn connect_event_stream(&mut self) -> lark_channel::Result<Self::Connection> {
            self.started.notify_one();
            if (&mut self.result).await.is_ok_and(|ok| ok) {
                Ok(FakeConnection)
            } else {
                Err(lark_channel::Error::Transport("handshake failed".into()))
            }
        }
    }

    #[tokio::test]
    async fn online_requires_successful_connect_and_closed_stream_returns_to_connecting() {
        let id = "test-observed-success";
        let started = Arc::new(tokio::sync::Notify::new());
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mut connector = ObservedConnector {
            id: id.into(),
            inner: PendingConnector {
                started: started.clone(),
                result: receiver,
            },
        };
        let task = tokio::spawn(async move { connector.connect_event_stream().await });
        started.notified().await;
        assert_eq!(super::super::feishu::statuses()[id].state, "connecting");
        sender.send(true).unwrap();
        let mut connection = task.await.unwrap().unwrap();
        assert_eq!(super::super::feishu::statuses()[id].state, "online");
        assert_eq!(
            connection.heartbeat_interval(),
            Some(Duration::from_secs(120))
        );
        assert!(matches!(
            connection.next_websocket_item().await.unwrap(),
            EventConnectionItem::Closed
        ));
        assert_eq!(super::super::feishu::statuses()[id].state, "connecting");
        super::super::feishu::stop(id);
    }

    #[tokio::test]
    async fn failed_connect_never_reports_online() {
        let id = "test-observed-failure";
        let (sender, receiver) = tokio::sync::oneshot::channel();
        sender.send(false).unwrap();
        let mut connector = ObservedConnector {
            id: id.into(),
            inner: PendingConnector {
                started: Arc::new(tokio::sync::Notify::new()),
                result: receiver,
            },
        };
        assert!(connector.connect_event_stream().await.is_err());
        let status = super::super::feishu::statuses().remove(id).unwrap();
        assert_eq!(status.state, "connecting");
        assert!(status.detail.unwrap().contains("handshake failed"));
        super::super::feishu::stop(id);
    }
}
