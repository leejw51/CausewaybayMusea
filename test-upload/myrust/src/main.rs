//! Aperture — Rust/axum backend for the 4 GB resumable upload gallery.
//!
//! Nothing is buffered in memory: chunk bodies stream straight to a `.part`
//! file, and reads stream back out with byte-range support so iOS Safari can
//! scrub a multi-gigabyte video without downloading it first.
//!
//! Layout under `./data`:
//!   tmp/<id>.part   in-flight upload, its length *is* the resume offset
//!   tmp/<id>.json   the declared name/size/type for that upload
//!   blobs/<id>.<ext>  finished file
//!   meta/<id>.json    finished metadata

use std::collections::HashMap;
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio_util::io::ReaderStream;

// 1 TB per file. Chunks stream straight to the .part file, so file size is a
// disk question, not a memory one — but each individual PUT must stay small:
// the client sends 1–4 MB chunks, and anything over MAX_CHUNK_BYTES is
// rejected mid-stream so a buggy or hostile client cannot tie up a connection
// with one giant request.
const MAX_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
// The client sends fixed 500 KB chunks (CHUNK_HINT). MAX_CHUNK_BYTES is only
// the abuse guard — a single PUT may not tie up a connection with an enormous
// body — so it sits far above the working size and must stay above anything a
// legitimate client or the protocol suite sends.
const MAX_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const CHUNK_HINT: u64 = 500 * 1024;
const READ_BUF: usize = 256 * 1024;
// How long a chunk upload may sit with nothing arriving before we give up on
// it. A phone that backgrounds, loses wifi or drops off the tailnet leaves the
// socket OPEN and simply stops sending: no FIN, no reset, nothing to notice.
// Without this the handler waits forever *while holding the per-id lock*, so
// every retry for that upload queues behind a request that will never finish
// and the transfer only recovers when the page is reloaded and the OS finally
// tears the old socket down. Bail out instead, release the lock, and let the
// client resume from the bytes we did commit.
const CHUNK_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

// ── model ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Item {
    id: String,
    name: String,
    size: u64,
    #[serde(rename = "type")]
    mime: String,
    kind: String,
    ext: String,
    ctime: u64,
}

struct AppState {
    root: PathBuf,
    tmp: PathBuf,
    blobs: PathBuf,
    meta: PathBuf,
    backend: String,
    port: u16,
    started: Instant,
    /// one lock per upload id so concurrent chunk PUTs cannot interleave
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl AppState {
    async fn lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        let mut map = self.locks.lock().await;
        map.entry(id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn part(&self, id: &str) -> PathBuf {
        self.tmp.join(format!("{id}.part"))
    }
    fn part_meta(&self, id: &str) -> PathBuf {
        self.tmp.join(format!("{id}.json"))
    }
    fn meta_path(&self, id: &str) -> PathBuf {
        self.meta.join(format!("{id}.json"))
    }
    fn blob(&self, item: &Item) -> PathBuf {
        self.blobs.join(if item.ext.is_empty() {
            item.id.clone()
        } else {
            format!("{}.{}", item.id, item.ext)
        })
    }
}

type ApiResult<T> = Result<T, ApiError>;

struct ApiError(StatusCode, serde_json::Value);

impl ApiError {
    fn new(code: StatusCode, msg: impl Into<String>) -> Self {
        ApiError(code, json!({ "error": msg.into() }))
    }
    fn with(code: StatusCode, body: serde_json::Value) -> Self {
        ApiError(code, body)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, msg)
}

fn oops(ctx: &str, e: impl std::fmt::Display) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("{ctx}: {e}"))
}

// ── helpers ─────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// HH:MM:SS in KST, for log lines — enough to correlate client behaviour.
fn ts() -> String {
    let s = (now_ms() / 1000 + 9 * 3600) % 86400;
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

/// Log every request with method, path and duration. The iPhone stall hunt
/// died repeatedly for lack of this: chunk PUTs alone cannot show whether a
/// client is re-initing per chunk or reloading the page between chunks.
async fn log_requests(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    // peer address answers which path the client took: 192.168.x = LAN,
    // 100.x = tailscale, 127.0.0.1 = local/simulator
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().to_string())
        .unwrap_or_else(|| "?".into());
    if uri.path() == "/api/dlog" {
        return next.run(req).await; // phone log lines are printed by the sink itself
    }
    let t0 = Instant::now();
    let res = next.run(req).await;
    println!(
        "{} [{}] {} {} -> {} in {}ms",
        ts(),
        peer,
        method,
        uri,
        res.status().as_u16(),
        t0.elapsed().as_millis()
    );
    res
}

/// Upload ids come from the client (a hash of name|size|mtime, so uploads can
/// resume across reloads). Only accept ids that cannot escape the data dir.
fn clean_id(id: &str) -> ApiResult<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id.to_string())
    } else {
        Err(bad("invalid upload id"))
    }
}

fn clean_ext(name: &str) -> String {
    FsPath::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            e.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(8)
                .collect::<String>()
                .to_ascii_lowercase()
        })
        .unwrap_or_default()
}

fn kind_of(mime: &str, name: &str) -> String {
    if mime.starts_with("video/") {
        return "video".into();
    }
    if mime.starts_with("image/") {
        return "image".into();
    }
    let ext = clean_ext(name);
    if matches!(ext.as_str(), "mp4" | "mov" | "m4v" | "webm" | "avi" | "mkv" | "hevc") {
        "video".into()
    } else {
        "image".into()
    }
}

fn content_type(item: &Item) -> String {
    if item.mime.starts_with("image/") || item.mime.starts_with("video/") {
        return item.mime.clone();
    }
    match item.ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        _ => "application/octet-stream",
    }
    .to_string()
}

async fn file_len(p: &FsPath) -> u64 {
    fs::metadata(p).await.map(|m| m.len()).unwrap_or(0)
}

async fn read_item(state: &AppState, id: &str) -> ApiResult<Item> {
    let raw = fs::read(state.meta_path(id))
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "not found"))?;
    serde_json::from_slice(&raw).map_err(|e| oops("corrupt metadata", e))
}

// ── handlers ────────────────────────────────────────────────────────

async fn health(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    let items = list_items(&st).await;
    let stored: u64 = items.iter().map(|i| i.size).sum();
    Json(json!({
        "ok": true,
        "backend": st.backend,
        "language": "rust",
        "port": st.port,
        "items": items.len(),
        "storedBytes": stored,
        "maxBytes": MAX_BYTES,
        "uptime": st.started.elapsed().as_secs(),
    }))
}

async fn list_items(st: &AppState) -> Vec<Item> {
    let mut out = Vec::new();
    let Ok(mut rd) = fs::read_dir(&st.meta).await else {
        return out;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read(entry.path()).await {
            if let Ok(item) = serde_json::from_slice::<Item>(&raw) {
                out.push(item);
            }
        }
    }
    out.sort_by(|a, b| b.ctime.cmp(&a.ctime));
    out
}

async fn media_list(State(st): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({ "items": list_items(&st).await }))
}

#[derive(Deserialize)]
struct InitReq {
    id: String,
    name: String,
    size: u64,
    #[serde(rename = "type", default)]
    mime: String,
}

/// The phone's on-page debug log, forwarded here so client-side stalls are
/// visible next to the server's own request timeline.
async fn phone_log(body: String) -> StatusCode {
    for line in body.lines().take(50) {
        // strip control chars so a client cannot forge log lines or splice ANSI
        let clean: String = line.chars().filter(|c| !c.is_control()).take(300).collect();
        println!("{} [phone] {}", ts(), clean);
    }
    StatusCode::NO_CONTENT
}

async fn upload_init(
    State(st): State<Arc<AppState>>,
    Json(req): Json<InitReq>,
) -> ApiResult<impl IntoResponse> {
    let id = clean_id(&req.id)?;
    if req.size == 0 {
        return Err(bad("file is empty"));
    }
    if req.size > MAX_BYTES {
        return Err(bad(format!("file exceeds the {} TB limit", MAX_BYTES >> 40)));
    }

    let guard = st.lock_for(&id).await;
    let _g = guard.lock().await;

    // already finished? report it as fully received so the client just completes
    if st.meta_path(&id).exists() {
        let item = read_item(&st, &id).await?;
        return Ok(Json(json!({ "id": id, "received": item.size, "chunkSize": CHUNK_HINT, "maxChunk": MAX_CHUNK_BYTES, "done": true })));
    }

    let name: String = req.name.chars().filter(|c| *c != '/' && *c != '\\').take(255).collect();
    let name = if name.trim().is_empty() { format!("upload-{id}") } else { name };

    let meta = json!({
        "id": id, "name": name, "size": req.size, "type": req.mime,
        "kind": kind_of(&req.mime, &name), "ext": clean_ext(&name),
    });
    fs::write(st.part_meta(&id), serde_json::to_vec(&meta).unwrap())
        .await
        .map_err(|e| oops("write upload metadata", e))?;

    let part = st.part(&id);
    if !part.exists() {
        fs::File::create(&part).await.map_err(|e| oops("create part file", e))?;
    }
    let received = file_len(&part).await.min(req.size);

    Ok(Json(json!({ "id": id, "received": received, "chunkSize": CHUNK_HINT, "maxChunk": MAX_CHUNK_BYTES })))
}

async fn upload_status(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let id = clean_id(&id)?;
    if st.meta_path(&id).exists() {
        let item = read_item(&st, &id).await?;
        return Ok(Json(json!({ "received": item.size, "done": true })));
    }
    Ok(Json(json!({ "received": file_len(&st.part(&id)).await, "done": false })))
}

// Keep-alive is deliberately left on. An earlier revision answered every
// chunk with `Connection: close` while hunting a Safari stall; the real
// causes turned out to be elsewhere (a bfcache-resurrected second uploader
// and replies lost in the tunnel), and at a 100 KB chunk size a fresh TCP
// handshake per chunk would dominate the transfer. Sequential chunk PUTs on
// one reused connection are covered by the protocol test.
async fn upload_chunk(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    body: Body,
) -> ApiResult<impl IntoResponse> {
    let id = clean_id(&id)?;
    let offset: u64 = q
        .get("offset")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| bad("missing ?offset="))?;
    let t0 = Instant::now();

    let guard = st.lock_for(&id).await;
    let _g = guard.lock().await;

    let part = st.part(&id);
    if !part.exists() {
        return Err(ApiError::new(StatusCode::CONFLICT, "no upload in progress — call /init first"));
    }
    let have = file_len(&part).await;
    if offset != have {
        // client and server disagree; hand back the truth so it can re-sync
        return Err(ApiError::with(
            StatusCode::CONFLICT,
            json!({ "error": format!("offset mismatch: server has {have}"), "received": have }),
        ));
    }

    let declared: u64 = fs::read(st.part_meta(&id))
        .await
        .ok()
        .and_then(|r| serde_json::from_slice::<serde_json::Value>(&r).ok())
        .and_then(|v| v.get("size").and_then(|s| s.as_u64()))
        .unwrap_or(MAX_BYTES);

    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(&part)
        .await
        .map_err(|e| oops("open part file", e))?;
    file.seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| oops("seek", e))?;

    let mut written = offset;
    let mut stream = body.into_data_stream();
    loop {
        let next = match tokio::time::timeout(CHUNK_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(n)) => n,
            Ok(None) => break, // body finished normally
            Err(_) => {
                // Silent socket. Commit what arrived and let go of the lock so
                // the client's retry is not queued behind a dead request.
                let _ = file.flush().await;
                println!(
                    "{} [chunk] {id} idle {}s @{written} — abandoning so the lock frees",
                    ts(),
                    CHUNK_IDLE_TIMEOUT.as_secs()
                );
                return Err(ApiError::with(
                    StatusCode::REQUEST_TIMEOUT,
                    json!({
                        "error": format!("no data for {}s — resume from {written}", CHUNK_IDLE_TIMEOUT.as_secs()),
                        "received": written
                    }),
                ));
            }
        };
        let bytes = match next {
            Ok(b) => b,
            Err(e) => {
                // flush what arrived — the client will resume from here
                let _ = file.flush().await;
                return Err(ApiError::with(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": format!("stream interrupted: {e}"), "received": written }),
                ));
            }
        };
        if written - offset + bytes.len() as u64 > MAX_CHUNK_BYTES {
            let _ = file.flush().await;
            let _ = file.set_len(offset).await;
            return Err(ApiError::with(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({
                    "error": format!("chunk too large — send at most {} MB per PUT", MAX_CHUNK_BYTES >> 20),
                    "received": offset
                }),
            ));
        }
        if written + bytes.len() as u64 > declared.min(MAX_BYTES) {
            let _ = file.flush().await;
            let _ = file.set_len(written).await;
            return Err(bad("chunk would exceed the declared file size"));
        }
        file.write_all(&bytes).await.map_err(|e| oops("write chunk", e))?;
        written += bytes.len() as u64;
    }
    file.flush().await.map_err(|e| oops("flush", e))?;
    drop(file);

    let ms = t0.elapsed().as_millis().max(1) as u64;
    let got = written - offset;
    println!(
        "{} [chunk] {id} +{got}B @{offset} in {ms}ms ({:.1} MB/s) -> {written}",
        ts(),
        (got as f64 / 1048576.0) / (ms as f64 / 1000.0)
    );
    Ok(Json(json!({ "received": written })))
}

async fn upload_complete(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let id = clean_id(&id)?;
    let guard = st.lock_for(&id).await;
    let _g = guard.lock().await;

    if st.meta_path(&id).exists() {
        return Ok(Json(json!({ "item": read_item(&st, &id).await? })));
    }

    let raw = fs::read(st.part_meta(&id))
        .await
        .map_err(|_| ApiError::new(StatusCode::CONFLICT, "no upload in progress"))?;
    let m: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| oops("bad upload metadata", e))?;

    let part = st.part(&id);
    let have = file_len(&part).await;
    let declared = m["size"].as_u64().unwrap_or(0);
    if have != declared {
        return Err(ApiError::with(
            StatusCode::CONFLICT,
            json!({ "error": format!("incomplete: {have} of {declared} bytes"), "received": have }),
        ));
    }

    let item = Item {
        id: id.clone(),
        name: m["name"].as_str().unwrap_or("upload").to_string(),
        size: declared,
        mime: m["type"].as_str().unwrap_or("").to_string(),
        kind: m["kind"].as_str().unwrap_or("image").to_string(),
        ext: m["ext"].as_str().unwrap_or("").to_string(),
        ctime: now_ms(),
    };

    fs::rename(&part, st.blob(&item)).await.map_err(|e| oops("move into place", e))?;
    fs::write(st.meta_path(&id), serde_json::to_vec(&item).unwrap())
        .await
        .map_err(|e| oops("write metadata", e))?;
    let _ = fs::remove_file(st.part_meta(&id)).await;

    println!("[upload] {} · {} bytes · {}", item.name, item.size, item.kind);
    Ok(Json(json!({ "item": item })))
}

async fn upload_abort(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let id = clean_id(&id)?;
    let guard = st.lock_for(&id).await;
    let _g = guard.lock().await;
    let _ = fs::remove_file(st.part(&id)).await;
    let _ = fs::remove_file(st.part_meta(&id)).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn media_delete(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let id = clean_id(&id)?;
    let item = read_item(&st, &id).await?;
    let _ = fs::remove_file(st.blob(&item)).await;
    let _ = fs::remove_file(st.meta_path(&id)).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` → inclusive (start, end)
fn parse_range(raw: &str, size: u64) -> Option<(u64, u64)> {
    let spec = raw.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", "") => return None,
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (size.saturating_sub(n.min(size)), size - 1)
        }
        (s, "") => (s.parse().ok()?, size - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(size - 1)),
    };
    if start > end || start >= size {
        None
    } else {
        Some((start, end))
    }
}

async fn media_serve(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let id = clean_id(&id)?;
    let item = read_item(&st, &id).await?;
    let path = st.blob(&item);
    let size = file_len(&path).await;
    let ctype = content_type(&item);

    let mut file = fs::File::open(&path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "file missing"))?;

    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| parse_range(r, size));

    let mut resp = Response::builder()
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");

    let (status, start, len) = match range {
        Some((s, e)) => {
            resp = resp.header(header::CONTENT_RANGE, format!("bytes {s}-{e}/{size}"));
            (StatusCode::PARTIAL_CONTENT, s, e - s + 1)
        }
        None => (StatusCode::OK, 0, size),
    };

    file.seek(SeekFrom::Start(start)).await.map_err(|e| oops("seek", e))?;
    let stream = ReaderStream::with_capacity(file.take(len), READ_BUF);

    resp.status(status)
        .header(header::CONTENT_LENGTH, len)
        .body(Body::from_stream(stream))
        .map_err(|e| oops("build response", e))
}

// ── static frontend ─────────────────────────────────────────────────

async fn asset(path: &str, ctype: &str) -> Response {
    match fs::read(FsPath::new("public").join(path)).await {
        Ok(bytes) => {
            let mut r = Response::new(Body::from(bytes));
            r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(ctype).unwrap());
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            r
        }
        Err(e) => (StatusCode::NOT_FOUND, format!("missing public/{path}: {e}")).into_response(),
    }
}

async fn index() -> Response {
    asset("index.html", "text/html; charset=utf-8").await
}
async fn styles() -> Response {
    asset("styles.css", "text/css; charset=utf-8").await
}
async fn script() -> Response {
    asset("app.js", "text/javascript; charset=utf-8").await
}

// ── main ────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8701);
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let backend = std::env::var("APERTURE_BACKEND").unwrap_or_else(|_| "Rust · axum".into());

    let root = PathBuf::from("data");
    let st = Arc::new(AppState {
        tmp: root.join("tmp"),
        blobs: root.join("blobs"),
        meta: root.join("meta"),
        root,
        backend: backend.clone(),
        port,
        started: Instant::now(),
        locks: Mutex::new(HashMap::new()),
    });
    for d in [&st.root, &st.tmp, &st.blobs, &st.meta] {
        fs::create_dir_all(d).await.expect("create data dirs");
    }

    let app = Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/styles.css", get(styles))
        .route("/app.js", get(script))
        .route("/api/health", get(health))
        .route("/api/media", get(media_list))
        .route("/api/media/{id}", delete(media_delete))
        .route("/media/{id}", get(media_serve))
        .route("/api/dlog", post(phone_log))
        .route("/api/upload/init", post(upload_init))
        .route("/api/upload/{id}/status", get(upload_status))
        .route("/api/upload/{id}/complete", post(upload_complete))
        // Only the chunk PUT may carry an unbounded body (it streams to disk);
        // everything else is small JSON/text and gets a hard in-memory cap,
        // otherwise a single huge POST to /init or /api/dlog would be
        // buffered wholesale into RAM.
        .route(
            "/api/upload/{id}",
            put(upload_chunk).delete(upload_abort).layer(DefaultBodyLimit::disable()),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(axum::middleware::from_fn(log_requests))
        .with_state(st.clone());

    let addr: SocketAddr = format!("{host}:{port}").parse().expect("bad HOST/PORT");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
        eprintln!("cannot bind {addr}: {e}");
        std::process::exit(1);
    });

    println!("aperture [{backend}] listening on http://{addr}");
    println!("storage: {}", st.root.display());

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown())
        .await
        .expect("server error");

    println!("aperture stopped");
}

async fn shutdown() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = int.recv() => {}
    }
    println!("shutting down …");
}
