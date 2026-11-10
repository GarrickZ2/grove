//! The tools Grove needs from the computer: Node.js (agents run through
//! `npx`) and Git (coding projects). Whether each is there, how it gets
//! installed here, and running that install where it needs no password.
//!
//! Only presence is checked, never a version. An install command is always
//! one of the fixed commands below; nothing a client sends is ever run.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Node,
    Git,
}

impl Tool {
    pub const ALL: [Tool; 2] = [Tool::Node, Tool::Git];

    pub fn parse(id: &str) -> Option<Tool> {
        match id {
            "node" => Some(Tool::Node),
            "git" => Some(Tool::Git),
            _ => None,
        }
    }

    fn installed(self) -> bool {
        match self {
            Tool::Node => crate::check::command_exists("npx"),
            Tool::Git => git_installed(),
        }
    }
}

/// macOS ships `/usr/bin/git` as a stub that only asks to install the Command
/// Line Tools, so that one counts only once the tools are there.
fn git_installed() -> bool {
    let Some(path) = crate::check::resolve_program("git") else {
        return false;
    };
    if cfg!(target_os = "macos") && path == std::path::Path::new("/usr/bin/git") {
        return Command::new("xcode-select")
            .arg("-p")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Os {
    Mac,
    Windows,
    Linux,
}

fn current_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Linux
    }
}

/// How a missing tool gets installed on this computer.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Recipe {
    argv: Vec<&'static str>,
    /// Grove may run it: it asks for no password in a terminal.
    run: bool,
    /// The command only opens the system's own installer and returns.
    hands_over: bool,
    /// Where to get the tool when there is no command for it.
    url: Option<&'static str>,
}

impl Recipe {
    fn command(argv: &[&'static str], run: bool) -> Self {
        Recipe {
            argv: argv.to_vec(),
            run,
            hands_over: false,
            url: None,
        }
    }

    fn download(url: &'static str) -> Self {
        Recipe {
            argv: Vec::new(),
            run: false,
            hands_over: false,
            url: Some(url),
        }
    }
}

const NODE_URL: &str = "https://nodejs.org/en/download";
const GIT_URL: &str = "https://git-scm.com/downloads";

fn recipe(tool: Tool, os: Os, has: &dyn Fn(&str) -> bool) -> Recipe {
    match (os, tool) {
        (Os::Mac, Tool::Node) if has("brew") => Recipe::command(&["brew", "install", "node"], true),
        (Os::Mac, Tool::Git) if has("brew") => Recipe::command(&["brew", "install", "git"], true),
        (Os::Mac, Tool::Git) => Recipe {
            hands_over: true,
            ..Recipe::command(&["xcode-select", "--install"], true)
        },
        (Os::Windows, Tool::Node) if has("winget") => Recipe::command(
            &[
                "winget",
                "install",
                "-e",
                "--id",
                "OpenJS.NodeJS.LTS",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            true,
        ),
        (Os::Windows, Tool::Git) if has("winget") => Recipe::command(
            &[
                "winget",
                "install",
                "-e",
                "--id",
                "Git.Git",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
            true,
        ),
        // `sudo` asks for a password in a terminal: shown to copy, never run.
        (Os::Linux, Tool::Node) if has("apt-get") => Recipe::command(
            &["sudo", "apt-get", "install", "-y", "nodejs", "npm"],
            false,
        ),
        (Os::Linux, Tool::Git) if has("apt-get") => {
            Recipe::command(&["sudo", "apt-get", "install", "-y", "git"], false)
        }
        (Os::Linux, Tool::Node) if has("dnf") => {
            Recipe::command(&["sudo", "dnf", "install", "-y", "nodejs"], false)
        }
        (Os::Linux, Tool::Git) if has("dnf") => {
            Recipe::command(&["sudo", "dnf", "install", "-y", "git"], false)
        }
        (Os::Linux, Tool::Node) if has("pacman") => {
            Recipe::command(&["sudo", "pacman", "-S", "nodejs", "npm"], false)
        }
        (Os::Linux, Tool::Git) if has("pacman") => {
            Recipe::command(&["sudo", "pacman", "-S", "git"], false)
        }
        (_, Tool::Node) => Recipe::download(NODE_URL),
        (_, Tool::Git) => Recipe::download(GIT_URL),
    }
}

fn current_recipe(tool: Tool) -> Recipe {
    recipe(tool, current_os(), &crate::check::command_exists)
}

/// An install Grove started, kept after it ends so its outcome can be read.
#[derive(Debug, Clone, Default)]
struct Job {
    running: bool,
    /// The installer's latest line of output.
    line: String,
    error: Option<String>,
    /// The command handed over to the system's installer, which is still open.
    handed_over: bool,
}

static JOBS: Lazy<Mutex<HashMap<Tool, Job>>> = Lazy::new(Mutex::default);

fn job(tool: Tool) -> Job {
    JOBS.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&tool)
        .cloned()
        .unwrap_or_default()
}

fn update_job(tool: Tool, change: impl FnOnce(&mut Job)) {
    let mut jobs = JOBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    change(jobs.entry(tool).or_default());
}

#[derive(Debug, Serialize)]
pub struct ToolStatus {
    pub id: Tool,
    pub installed: bool,
    /// The install command, as the person would type it.
    pub command: Option<String>,
    /// Grove can run `command` itself.
    pub run: bool,
    /// Where to download the tool when there is no command.
    pub url: Option<&'static str>,
    pub installing: bool,
    pub line: String,
    pub error: Option<String>,
    /// The system's own installer was opened and has to be finished there.
    pub handed_over: bool,
}

/// Every tool, checked now. Spawns at most one short process; call off the async runtime.
pub fn status() -> Vec<ToolStatus> {
    add_installed_dirs_to_path();
    Tool::ALL
        .into_iter()
        .map(|tool| {
            let installed = tool.installed();
            let recipe = current_recipe(tool);
            let job = job(tool);
            ToolStatus {
                id: tool,
                installed,
                command: (!recipe.argv.is_empty()).then(|| recipe.argv.join(" ")),
                run: recipe.run,
                url: recipe.url,
                installing: job.running,
                line: job.line,
                error: if installed { None } else { job.error },
                handed_over: !installed && job.handed_over,
            }
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallError {
    /// There is no command Grove may run for this tool here.
    NotRunnable,
}

/// Start installing `tool` in the background; `status` reports how it goes.
/// A tool already there, or already being installed, is left alone.
pub fn install(tool: Tool) -> Result<(), InstallError> {
    if tool.installed() {
        return Ok(());
    }
    let recipe = current_recipe(tool);
    if !recipe.run || recipe.argv.is_empty() {
        return Err(InstallError::NotRunnable);
    }
    {
        let mut jobs = JOBS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let job = jobs.entry(tool).or_default();
        if job.running {
            return Ok(());
        }
        *job = Job {
            running: true,
            ..Job::default()
        };
    }
    std::thread::spawn(move || {
        let outcome = run(tool, &recipe);
        add_installed_dirs_to_path();
        let installed = tool.installed();
        update_job(tool, |job| {
            job.running = false;
            match outcome {
                Ok(()) if installed => {}
                Ok(()) if recipe.hands_over => job.handed_over = true,
                Ok(()) => {
                    job.error = Some("The install finished, but the tool is not found yet.".into())
                }
                Err(error) if installed => drop(error),
                Err(error) => job.error = Some(error),
            }
        });
    });
    Ok(())
}

/// Run the install to its end, keeping the job's line on its latest output.
fn run(tool: Tool, recipe: &Recipe) -> Result<(), String> {
    let mut command = Command::new(crate::check::program_path(recipe.argv[0]));
    command
        .args(&recipe.argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let follow = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let Some(stream) = stream else { return };
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                // Progress bars redraw one line with carriage returns: keep the last draw.
                let line = line
                    .rsplit('\r')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if !line.is_empty() {
                    update_job(tool, |job| job.line = line);
                }
            }
        })
    };
    let out = follow(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let err = follow(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    );
    let status = child.wait().map_err(|error| error.to_string())?;
    let _ = out.join();
    let _ = err.join();
    if status.success() {
        return Ok(());
    }
    let last = job(tool).line;
    Err(if last.is_empty() {
        format!("{} failed ({status}).", recipe.argv[0])
    } else {
        last
    })
}

/// A running process keeps the PATH it started with, so a tool installed
/// since would stay unseen. Windows installers put these tools in fixed
/// places: add the ones that now exist.
fn add_installed_dirs_to_path() {
    #[cfg(windows)]
    {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        for (base, tail) in [
            ("ProgramFiles", "nodejs"),
            ("ProgramFiles", "Git\\cmd"),
            ("LOCALAPPDATA", "Programs\\Git\\cmd"),
        ] {
            if let Some(base) = std::env::var_os(base) {
                candidates.push(std::path::PathBuf::from(base).join(tail));
            }
        }
        let current = std::env::var_os("PATH").unwrap_or_default();
        let mut dirs: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
        let before = dirs.len();
        for dir in candidates {
            if dir.is_dir() && !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        if dirs.len() != before {
            if let Ok(joined) = std::env::join_paths(dirs) {
                // SAFETY: the same process-wide PATH update the GUI start does.
                #[allow(unused_unsafe)]
                unsafe {
                    std::env::set_var("PATH", joined);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(found: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |command| found.contains(&command)
    }

    #[test]
    fn homebrew_installs_both_on_macos() {
        let has = with(&["brew"]);
        let node = recipe(Tool::Node, Os::Mac, &has);
        assert_eq!(node.argv, ["brew", "install", "node"]);
        assert!(node.run);
        assert_eq!(
            recipe(Tool::Git, Os::Mac, &has).argv,
            ["brew", "install", "git"]
        );
    }

    #[test]
    fn macos_without_homebrew_uses_the_system_installer_for_git_and_a_download_for_node() {
        let has = with(&[]);
        let git = recipe(Tool::Git, Os::Mac, &has);
        assert_eq!(git.argv, ["xcode-select", "--install"]);
        assert!(git.run && git.hands_over);
        let node = recipe(Tool::Node, Os::Mac, &has);
        assert!(node.argv.is_empty() && !node.run);
        assert_eq!(node.url, Some(NODE_URL));
    }

    #[test]
    fn a_command_that_needs_a_password_is_never_run() {
        for manager in ["apt-get", "dnf", "pacman"] {
            let found = [manager];
            let has = |command: &str| found.contains(&command);
            for tool in Tool::ALL {
                let plan = recipe(tool, Os::Linux, &has);
                assert_eq!(plan.argv[0], "sudo");
                assert!(!plan.run, "{manager} {tool:?}");
            }
        }
    }

    #[test]
    fn with_no_package_manager_there_is_only_a_download() {
        for os in [Os::Windows, Os::Linux] {
            for tool in Tool::ALL {
                let plan = recipe(tool, os, &with(&[]));
                assert!(plan.argv.is_empty() && !plan.run && plan.url.is_some());
            }
        }
    }

    #[test]
    fn winget_installs_both_on_windows() {
        let has = with(&["winget"]);
        assert!(recipe(Tool::Node, Os::Windows, &has)
            .argv
            .contains(&"OpenJS.NodeJS.LTS"));
        let git = recipe(Tool::Git, Os::Windows, &has);
        assert!(git.argv.contains(&"Git.Git") && git.run);
    }

    #[test]
    fn only_known_tools_parse() {
        assert_eq!(Tool::parse("node"), Some(Tool::Node));
        assert_eq!(Tool::parse("git"), Some(Tool::Git));
        assert_eq!(Tool::parse("rm -rf"), None);
    }
}
