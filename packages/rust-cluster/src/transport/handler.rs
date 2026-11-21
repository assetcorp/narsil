use std::future::Future;
use std::sync::Arc;

use super::BoxFuture;
use crate::error::ClusterResult;
use crate::message::TransportMessage;

pub(crate) trait ReplySink: Send + Sync {
    fn reply(&self, message: TransportMessage) -> BoxFuture<'_, ()>;
}

/// Sends the answers of one request back to the node that sent it.
///
/// The first answer goes out as the reply to the request, and each later one goes out as the next chunk of a
/// streamed answer. Each call returns once the transport has taken the answer, so a handler that streams many
/// answers and awaits each one cannot outrun a slow receiver.
#[derive(Clone)]
pub struct Respond {
    sink: Arc<dyn ReplySink>,
}

impl Respond {
    pub(crate) fn new(sink: Arc<dyn ReplySink>) -> Respond {
        Respond { sink }
    }

    /// Sends `message` and returns once the transport has taken it. An answer to a peer whose connection has
    /// closed goes nowhere.
    pub async fn send(&self, message: TransportMessage) {
        self.sink.reply(message).await;
    }
}

/// Handles one request that a peer sent, answering through [`Respond`], where an error makes the carrier send its
/// `error` message in place of an answer.
pub type ListenHandler =
    Arc<dyn Fn(TransportMessage, Respond) -> BoxFuture<'static, ClusterResult<()>> + Send + Sync>;

/// Returns a [`ListenHandler`] that runs `handler` for each request.
pub fn listen_handler<F, Fut>(handler: F) -> ListenHandler
where
    F: Fn(TransportMessage, Respond) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ClusterResult<()>> + Send + 'static,
{
    Arc::new(move |message, respond| Box::pin(handler(message, respond)))
}
