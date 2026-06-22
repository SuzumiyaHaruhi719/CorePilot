//! One-click network diagnostics & repair, inspired by 360断网急救箱.
//!
//! All checks are best-effort and must never panic — a failed probe simply
//! becomes a `NetCheck { ok: false, .. }` with a human-readable detail. Probes use
//! short timeouts so the whole sweep stays responsive even when the machine is
//! offline. External tools (ipconfig / netsh / ping) run via `std::process::Command`
//! with `CREATE_NO_WINDOW` so no console window flashes in front of the GUI.
//!
//! i18n: results are produced by the BACKEND (some details interpolate live IPs, so
//! the frontend dictionary can't translate them). Each command takes `en` — the
//! app's current language — and returns English or Chinese label/detail strings.

use serde::Serialize;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

/// Hide the child console window for CLI tools we shell out to.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A single diagnostic or repair result, serialized to the front-end.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: String,
}

impl NetCheck {
    fn new(id: &str, label: &str, ok: bool, detail: impl Into<String>) -> Self {
        NetCheck {
            id: id.to_string(),
            label: label.to_string(),
            ok,
            detail: detail.into(),
        }
    }
}

/// Pick the English or Chinese variant of a fixed (compile-time) string. Callers
/// always pass string literals, which are already `&'static str` — no allocation,
/// no unsafe.
fn tr(en: bool, en_s: &'static str, zh_s: &'static str) -> &'static str {
    if en {
        en_s
    } else {
        zh_s
    }
}

/// Run a console command silently and capture stdout (lossy UTF-8). Returns
/// `None` when the process could not be spawned at all.
fn run_capture(program: &str, args: &[&str]) -> Option<std::process::Output> {
    Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
}

/// `ipconfig` emits OEM/ANSI text on localized Windows; decode leniently so we
/// can still scan for IPv4 dotted-quads regardless of code page.
fn decode_console(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// True when `s` parses as a non-empty, non-loopback, non-zero IPv4 literal.
fn is_routable_ipv4(s: &str) -> bool {
    match s.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => !ip.is_loopback() && !ip.is_unspecified(),
        Err(_) => false,
    }
}

/// Parse `ipconfig` output for the first usable IPv4 address and the first
/// non-empty default gateway. Returns `(local_ipv4, default_gateway)`.
///
/// Localized Windows prints different labels ("IPv4 地址", "IPv4 Address",
/// "默认网关", "Default Gateway"), so instead of matching the label text we key
/// off the stable English-ish substrings present in every locale's key
/// (`IPv4`, `Gateway` / 网关) and otherwise fall back to scanning dotted-quads.
fn parse_ipconfig(text: &str) -> (Option<String>, Option<String>) {
    let mut local_ip: Option<String> = None;
    let mut gateway: Option<String> = None;
    // True immediately after a "Default Gateway" label line whose value was an
    // IPv6 address; the IPv4 gateway then wraps onto the next bare-address line.
    let mut expect_gateway_continuation = false;

    for raw in text.lines() {
        let line = raw.trim();
        let Some((label, value)) = line.split_once(':') else {
            if expect_gateway_continuation && gateway.is_none() {
                let v = line.trim_matches(|c: char| c.is_whitespace() || c == '.');
                if is_routable_ipv4(v) {
                    gateway = Some(v.to_string());
                }
            }
            // Any non-key line ends the continuation window.
            expect_gateway_continuation = false;
            continue;
        };
        let value = value.trim().trim_matches('.').trim();
        let label_lower = label.to_lowercase();

        let is_gateway = label.contains("网关") || label_lower.contains("gateway");
        let is_ipv4 = (label.contains("IPv4") || label_lower.contains("ipv4"))
            && !label_lower.contains("ipv6");

        if is_gateway {
            if is_routable_ipv4(value) {
                // Keep the first routable IPv4 gateway we see.
                if gateway.is_none() {
                    gateway = Some(value.to_string());
                }
                expect_gateway_continuation = false;
            } else {
                // Label present but value isn't IPv4 (blank or IPv6) — the IPv4
                // gateway may follow on the next line.
                expect_gateway_continuation = true;
            }
        } else {
            expect_gateway_continuation = false;
            if is_ipv4 && local_ip.is_none() && is_routable_ipv4(value) {
                local_ip = Some(value.to_string());
            }
        }
    }

    (local_ip, gateway)
}

/// adapter: a non-loopback adapter must have a routable IPv4 address.
fn check_adapter(ipconfig: &str, en: bool) -> NetCheck {
    let (local_ip, _) = parse_ipconfig(ipconfig);
    let label = tr(en, "Network adapter", "网络适配器");
    match local_ip {
        Some(ip) => NetCheck::new(
            "adapter",
            label,
            true,
            if en {
                format!("IPv4 address {ip} assigned")
            } else {
                format!("已分配 IPv4 地址 {ip}")
            },
        ),
        None => NetCheck::new(
            "adapter",
            label,
            false,
            tr(
                en,
                "No valid IPv4 address — the adapter may be disabled or unplugged",
                "未检测到有效的 IPv4 地址，网卡可能被禁用或未连接",
            ),
        ),
    }
}

/// gateway: the default gateway must answer a single short ping.
fn check_gateway(ipconfig: &str, en: bool) -> NetCheck {
    let (_, gateway) = parse_ipconfig(ipconfig);
    let label = tr(en, "Default gateway", "默认网关");
    let Some(gw) = gateway else {
        return NetCheck::new(
            "gateway",
            label,
            false,
            tr(
                en,
                "No default gateway found — you may not be connected to a router",
                "未找到默认网关，可能未连接到路由器",
            ),
        );
    };

    // ping -n 1 -w 1000: one echo, 1s timeout. Success is signalled by the exit
    // code on Windows ping.
    let reachable = run_capture("ping", &["-n", "1", "-w", "1000", &gw])
        .map(|o| o.status.success())
        .unwrap_or(false);

    if reachable {
        NetCheck::new(
            "gateway",
            label,
            true,
            if en {
                format!("Gateway {gw} reachable")
            } else {
                format!("网关 {gw} 可达")
            },
        )
    } else {
        NetCheck::new(
            "gateway",
            label,
            false,
            if en {
                format!("Gateway {gw} not responding — the local network may be faulty")
            } else {
                format!("网关 {gw} 无响应，本地网络连接可能存在故障")
            },
        )
    }
}

/// dns: a known connectivity host must resolve to at least one address.
fn check_dns(en: bool) -> NetCheck {
    let resolved = ("www.msftconnecttest.com", 80)
        .to_socket_addrs()
        .map(|mut addrs| addrs.next().is_some())
        .unwrap_or(false);

    let label = tr(en, "DNS resolution", "DNS 解析");
    if resolved {
        NetCheck::new(
            "dns",
            label,
            true,
            tr(en, "Domain resolution OK", "域名解析正常"),
        )
    } else {
        NetCheck::new(
            "dns",
            label,
            false,
            tr(
                en,
                "Can't resolve domains — the DNS server may be misconfigured or down",
                "域名无法解析，DNS 服务器可能配置错误或不可用",
            ),
        )
    }
}

/// internet: a TCP handshake to a public anycast host (AliDNS 223.5.5.5:443)
/// within ~1s proves real outbound reachability past the gateway.
fn check_internet(en: bool) -> NetCheck {
    let addr: SocketAddr = "223.5.5.5:443".parse().expect("static addr");
    let label = tr(en, "Internet connection", "互联网连接");
    match TcpStream::connect_timeout(&addr, Duration::from_millis(1000)) {
        Ok(_) => NetCheck::new(
            "internet",
            label,
            true,
            tr(en, "Connected to the internet", "已成功连接到互联网"),
        ),
        Err(_) => NetCheck::new(
            "internet",
            label,
            false,
            tr(
                en,
                "Can't reach external servers — internet access may be down",
                "无法连接到外部服务器，互联网访问可能中断",
            ),
        ),
    }
}

/// proxy: report HKCU Internet Settings. ok = true means "no system proxy"
/// (the normal state); ok = false flags an enabled proxy that may break access.
fn check_proxy(en: bool) -> NetCheck {
    let label = tr(en, "Proxy settings", "代理设置");
    // `reg query` avoids a registry-crate dependency and matches the project's
    // shell-out style. ProxyEnable is a REG_DWORD (0x0 / 0x1).
    let out = run_capture(
        "reg",
        &[
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ],
    );

    let enabled = out
        .as_ref()
        .map(|o| decode_console(&o.stdout))
        .and_then(|text| {
            // Line looks like: "    ProxyEnable    REG_DWORD    0x1"
            text.lines()
                .find(|l| l.contains("ProxyEnable"))
                .and_then(|l| l.split_whitespace().last().map(str::to_string))
        })
        .map(|hex| {
            // reg prints a REG_DWORD as a hex literal, e.g. "0x1".
            let digits = hex.trim_start_matches("0x");
            u32::from_str_radix(digits, 16).unwrap_or(0) != 0
        })
        .unwrap_or(false);

    if !enabled {
        return NetCheck::new(
            "proxy",
            label,
            true,
            tr(en, "No system proxy (normal)", "未启用系统代理（正常）"),
        );
    }

    // A proxy is on — surface the server string so the user can judge it.
    let server = run_capture(
        "reg",
        &[
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ],
    )
    .map(|o| decode_console(&o.stdout))
    .and_then(|text| {
        text.lines()
            .find(|l| l.contains("ProxyServer"))
            .and_then(|l| l.split("REG_SZ").nth(1).map(|s| s.trim().to_string()))
    })
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| {
        if en {
            "unknown".to_string()
        } else {
            "未知".to_string()
        }
    });

    NetCheck::new(
        "proxy",
        label,
        false,
        if en {
            format!(
                "System proxy enabled ({server}); if you can't get online, try resetting the proxy"
            )
        } else {
            format!("已启用系统代理（{server}），若无法上网可尝试重置代理")
        },
    )
}

/// Async wrapper: the diagnostic sweep spawns `ipconfig`/`netsh`/`ping` children
/// (seconds) — run it off the main thread so it never stalls the IPC router.
#[tauri::command]
pub async fn network_diagnose(en: bool) -> Vec<NetCheck> {
    tauri::async_runtime::spawn_blocking(move || network_diagnose_impl(en))
        .await
        .unwrap_or_default()
}

/// Run the full diagnostic sweep. Best-effort, never panics. `en` selects the
/// language of the returned label/detail strings.
fn network_diagnose_impl(en: bool) -> Vec<NetCheck> {
    // One ipconfig call feeds both the adapter and gateway checks.
    let ipconfig = run_capture("ipconfig", &["/all"])
        .map(|o| decode_console(&o.stdout))
        .unwrap_or_default();

    vec![
        check_adapter(&ipconfig, en),
        check_gateway(&ipconfig, en),
        check_dns(en),
        check_internet(en),
        check_proxy(en),
    ]
}

/// Run a repair command silently and map the result to a NetCheck. `ok`
/// reflects the process exit status; `ok_detail` is the success message.
fn run_fix(
    id: &str,
    label: &str,
    ok_detail: &str,
    program: &str,
    args: &[&str],
    en: bool,
) -> NetCheck {
    match run_capture(program, args) {
        Some(out) if out.status.success() => NetCheck::new(id, label, true, ok_detail),
        Some(_) => NetCheck::new(
            id,
            label,
            false,
            tr(
                en,
                "Command failed — make sure CorePilot is running as administrator",
                "命令执行失败，请确认以管理员身份运行",
            ),
        ),
        None => NetCheck::new(
            id,
            label,
            false,
            tr(en, "Couldn't start the repair command", "无法启动修复命令"),
        ),
    }
}

/// Async wrapper: each repair spawns a `netsh`/`ipconfig` child — keep it off the
/// main thread.
#[tauri::command]
pub async fn network_repair(actions: Vec<String>, en: bool) -> Vec<NetCheck> {
    tauri::async_runtime::spawn_blocking(move || network_repair_impl(actions, en))
        .await
        .unwrap_or_default()
}

/// Apply the requested repairs. Unknown ids are ignored. Each requested id
/// yields exactly one NetCheck describing the outcome. `en` selects the language.
fn network_repair_impl(actions: Vec<String>, en: bool) -> Vec<NetCheck> {
    let mut results = Vec::with_capacity(actions.len());

    for action in actions {
        let result = match action.as_str() {
            "flushDns" => run_fix(
                "flushDns",
                tr(en, "Flush DNS cache", "刷新 DNS 缓存"),
                tr(en, "DNS cache flushed", "DNS 缓存已刷新"),
                "ipconfig",
                &["/flushdns"],
                en,
            ),
            "renewDhcp" => {
                // Release first, then renew. A release failure (e.g. static IP)
                // shouldn't abort the renew attempt; the renew status decides.
                let _ = run_capture("ipconfig", &["/release"]);
                run_fix(
                    "renewDhcp",
                    tr(en, "Renew IP", "重新获取 IP"),
                    tr(
                        en,
                        "Renewed IP address from DHCP",
                        "已重新向 DHCP 获取 IP 地址",
                    ),
                    "ipconfig",
                    &["/renew"],
                    en,
                )
            }
            "resetWinsock" => run_fix(
                "resetWinsock",
                tr(en, "Reset Winsock", "重置 Winsock"),
                tr(
                    en,
                    "Winsock catalog reset — takes effect after a reboot",
                    "Winsock 目录已重置，需重启后生效",
                ),
                "netsh",
                &["winsock", "reset"],
                en,
            ),
            "resetTcpip" => run_fix(
                "resetTcpip",
                tr(en, "Reset TCP/IP", "重置 TCP/IP"),
                tr(
                    en,
                    "TCP/IP stack reset — takes effect after a reboot",
                    "TCP/IP 协议栈已重置，需重启后生效",
                ),
                "netsh",
                &["int", "ip", "reset"],
                en,
            ),
            "resetProxy" => run_fix(
                "resetProxy",
                tr(en, "Reset proxy", "重置代理"),
                tr(
                    en,
                    "WinHTTP proxy reset to direct",
                    "WinHTTP 代理已重置为直连",
                ),
                "netsh",
                &["winhttp", "reset", "proxy"],
                en,
            ),
            // Unknown action — silently skip per spec.
            _ => continue,
        };
        results.push(result);
    }

    results
}
