use std::io::Write;
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

enum Message {
    Line(String),
    Finish,
}

#[derive(Clone)]
pub struct Output {
    lines: Sender<Message>,
    writer: Arc<Mutex<Option<JoinHandle<()>>>>,
}

fn write_lines(lines: Receiver<Message>) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    while let Ok(message) = lines.recv() {
        let mut next = Some(message);
        while let Some(message) = next.take() {
            match message {
                Message::Line(line) => {
                    let _ = out.write_all(line.as_bytes());
                    let _ = out.write_all(b"\n");
                }
                Message::Finish => {
                    let _ = out.flush();
                    return;
                }
            }
            next = match lines.try_recv() {
                Ok(message) => Some(message),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => {
                    let _ = out.flush();
                    return;
                }
            };
        }
        let _ = out.flush();
    }
}

impl Output {
    pub fn start() -> Output {
        let (lines, receiver) = channel();
        let writer = std::thread::Builder::new()
            .name("narsil-stdout".to_string())
            .spawn(move || write_lines(receiver))
            .ok();
        Output {
            lines,
            writer: Arc::new(Mutex::new(writer)),
        }
    }

    pub fn event(&self, line: String) {
        let _ = self.lines.send(Message::Line(line));
    }

    pub fn notice(&self, line: &str) {
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "{line}");
    }

    pub fn finish(&self) {
        let _ = self.lines.send(Message::Finish);
        let writer = match self.writer.lock() {
            Ok(mut writer) => writer.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(writer) = writer {
            let _ = writer.join();
        }
    }
}
