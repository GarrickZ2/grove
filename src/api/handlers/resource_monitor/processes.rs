use super::Inventory;
use axum::{http::StatusCode, Json};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use sysinfo::{CpuRefreshKind, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

type Owner = Option<(String, String)>; // None = Grove's shared runtime.

#[derive(Clone, Serialize)]
pub struct ProcessNode {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub detail: String,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: u64,
    pub children: Vec<ProcessNode>,
}

#[derive(Clone, Serialize)]
pub struct ProcessSnapshot {
    pub sampled_at: String,
    pub logical_cpus: usize,
    pub cpu_percent: Option<f32>,
    pub memory_bytes: u64,
    pub process_count: usize,
    pub groups: Vec<ProcessNode>,
}

#[derive(Default)]
struct Sampler {
    system: System,
    last: Option<Instant>,
    snapshot: Option<ProcessSnapshot>,
    // Keep ownership when a managed child is reparented, but never across PID reuse.
    owners: HashMap<(u32, u64), Owner>,
}

static SAMPLER: Lazy<Mutex<Sampler>> = Lazy::new(|| Mutex::new(Sampler::default()));

struct Process {
    pid: u32,
    parent: Option<u32>,
    started: u64,
    name: String,
    cpu: f32,
    memory: u64,
    task: Owner,
    session: Option<SessionLabel>,
}

#[derive(Clone)]
struct SessionLabel {
    id: String,
    title: String,
    agent: String,
}

type SessionKey = (String, String, String);

fn load_session_labels() -> rusqlite::Result<HashMap<SessionKey, SessionLabel>> {
    let db = crate::storage::database::connection();
    let mut statement =
        db.prepare("SELECT project, task_id, session_id, title, agent FROM session")?;
    let labels = statement
        .query_map([], |row| {
            let id: String = row.get(2)?;
            Ok((
                (row.get(0)?, row.get(1)?, id.clone()),
                SessionLabel {
                    id,
                    title: row.get(3)?,
                    agent: row.get(4)?,
                },
            ))
        })?
        .collect();
    labels
}

fn env_value<'a>(environ: &'a [std::ffi::OsString], prefix: &str) -> Option<&'a str> {
    environ
        .iter()
        .filter_map(|value| value.to_str())
        .find_map(|value| value.strip_prefix(prefix))
}

fn session_label(
    owner: &Owner,
    chat: Option<&str>,
    agent: Option<&str>,
    sessions: &HashMap<SessionKey, SessionLabel>,
    names: &HashMap<String, String>,
) -> Option<SessionLabel> {
    let (project, task) = owner.as_ref()?;
    let mut session = sessions
        .get(&(project.clone(), task.clone(), chat?.to_owned()))?
        .clone();
    let agent = agent.unwrap_or(&session.agent);
    let canonical = crate::storage::installed_agents::canonicalize_agent_id(agent);
    session.agent = names
        .get(&canonical)
        .cloned()
        .unwrap_or_else(|| agent.to_owned());
    Some(session)
}

fn env_task(environ: &[std::ffi::OsString], inventory: &Inventory) -> Owner {
    let mut project_key = None;
    let mut project_path = None;
    let mut task = None;
    for value in environ {
        let Some(value) = value.to_str() else {
            continue;
        };
        if let Some(value) = value.strip_prefix("GROVE_PROJECT_KEY=") {
            project_key = Some(value);
        }
        if let Some(value) = value.strip_prefix("GROVE_PROJECT=") {
            project_path = Some(value);
        }
        if let Some(value) = value.strip_prefix("GROVE_TASK_ID=") {
            task = Some(value);
        }
    }
    let task = task?;
    let key = project_key
        .filter(|key| inventory.projects.contains_key(*key))
        .or_else(|| {
            project_path.and_then(|path| {
                inventory
                    .projects
                    .iter()
                    .find(|(_, p)| p.path == path)
                    .map(|(key, _)| key.as_str())
            })
        })?;
    inventory
        .tasks
        .contains_key(&(key.to_owned(), task.to_owned()))
        .then(|| (key.to_owned(), task.to_owned()))
}

fn owners(
    processes: &[Process],
    own_pid: u32,
    previous: &HashMap<(u32, u64), Owner>,
) -> HashMap<u32, Owner> {
    let mut result = HashMap::new();
    let started: HashMap<_, _> = processes.iter().map(|p| (p.pid, p.started)).collect();
    for process in processes {
        if process.pid == own_pid {
            result.insert(process.pid, None);
        } else if process.task.is_some() {
            result.insert(process.pid, process.task.clone());
        } else if let Some(owner) = previous.get(&(process.pid, process.started)) {
            result.insert(process.pid, owner.clone());
        }
    }
    // Parent order is unspecified. Resolve descendants until no more can be
    // attributed; unrelated siblings/ancestors and same-named agents stay out.
    loop {
        let mut changed = false;
        for process in processes {
            if result.contains_key(&process.pid) {
                continue;
            }
            // Windows retains the original parent PID even after that parent
            // exits. A newer process reusing it is not this process's parent.
            if let Some(owner) = process
                .parent
                .filter(|pid| {
                    started
                        .get(pid)
                        .is_some_and(|time| *time <= process.started)
                })
                .and_then(|pid| result.get(&pid))
                .cloned()
            {
                result.insert(process.pid, owner);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    result
}

fn group(id: String, name: String, kind: &'static str, detail: String) -> ProcessNode {
    ProcessNode {
        id,
        name,
        kind,
        detail,
        cpu_percent: None,
        memory_bytes: 0,
        children: vec![],
    }
}

fn totals(node: &mut ProcessNode, ready: bool) {
    node.memory_bytes = node.children.iter().map(|n| n.memory_bytes).sum();
    node.cpu_percent = ready.then(|| node.children.iter().filter_map(|n| n.cpu_percent).sum());
}

// Keep only the first process in each ownership group. Descendants contribute
// usage to that row, but never cross a task boundary or appear a second time.
fn rollup_processes(
    processes: &[Process],
    attribution: &HashMap<u32, Owner>,
    previous: &HashMap<(u32, u64), Owner>,
    ready: bool,
) -> Vec<(Owner, ProcessNode)> {
    let by_pid: HashMap<_, _> = processes
        .iter()
        .filter(|p| attribution.contains_key(&p.pid))
        .map(|p| (p.pid, p))
        .collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut pending = vec![];
    for process in by_pid.values() {
        let parent = process
            .parent
            .and_then(|pid| by_pid.get(&pid))
            .filter(|parent| {
                parent.pid != process.pid
                    && parent.started <= process.started
                    && attribution.get(&parent.pid) == attribution.get(&process.pid)
                        && !matches!((&parent.session, &process.session), (Some(a), Some(b)) if a.id != b.id)
            });
        if let Some(parent) = parent {
            children.entry(parent.pid).or_default().push(process.pid);
        } else {
            pending.push((process.pid, process.pid));
        }
    }
    let mut roots = HashMap::new();
    while let Some((pid, root)) = pending.pop() {
        if roots.insert(pid, root).is_none() {
            if let Some(children) = children.get(&pid) {
                pending.extend(children.iter().map(|&child| (child, root)));
            }
        }
    }
    let mut rows: HashMap<u32, (ProcessNode, usize)> = HashMap::new();
    for process in by_pid.values() {
        // Missing parents become roots. An inconsistent/cyclic OS snapshot
        // also keeps every measured process, rather than dropping its usage.
        let root_pid = roots.get(&process.pid).copied().unwrap_or(process.pid);
        let root = by_pid[&root_pid];
        let (row, count) = rows.entry(root_pid).or_insert_with(|| {
            let mut row = group(
                format!("pid:{}:{}", root.pid, root.started),
                root.session
                    .as_ref()
                    .map_or_else(|| root.name.clone(), |session| session.agent.clone()),
                "process",
                format!("PID {}", root.pid),
            );
            if let Some(session) = &root.session {
                row.detail = format!("{} · {} · {}", session.title, session.id, row.detail);
            }
            (row, 0)
        });
        row.memory_bytes = row.memory_bytes.saturating_add(process.memory);
        if ready
            && previous.contains_key(&(process.pid, process.started))
            && process.cpu.is_finite()
        {
            row.cpu_percent = Some(row.cpu_percent.unwrap_or(0.0) + process.cpu);
        }
        *count += 1;
    }
    rows.into_iter()
        .map(|(pid, (mut row, count))| {
            if count > 1 {
                let descendants = count - 1;
                row.detail = format!(
                    "{} · includes {descendants} {}",
                    row.detail,
                    if descendants == 1 {
                        "subprocess"
                    } else {
                        "subprocesses"
                    }
                );
            }
            (attribution[&pid].clone(), row)
        })
        .collect()
}

fn sample() -> Result<ProcessSnapshot, StatusCode> {
    let mut sampler = SAMPLER
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if sampler
        .last
        .is_some_and(|at| at.elapsed() < Duration::from_millis(1500))
    {
        if let Some(snapshot) = &sampler.snapshot {
            return Ok(snapshot.clone());
        }
    }
    let inventory = Inventory::load().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let ready = sampler
        .last
        .is_some_and(|at| at.elapsed() < Duration::from_secs(60));
    if sampler.system.cpus().is_empty() {
        sampler.system.refresh_cpu_list(CpuRefreshKind::new());
    }
    sampler.system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new()
            .with_memory()
            .with_cpu()
            .with_environ(UpdateKind::OnlyIfNotSet),
    );
    // sysinfo initializes the logical CPU list on CPU refresh. Use that count,
    // not physical cores, to express CPU as a percentage of host capacity.
    let cpu_count = sampler.system.cpus().len().max(1);
    let sessions = load_session_labels().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let names: HashMap<_, _> = crate::storage::agent_registry::get()
        .agents
        .into_iter()
        .map(|agent| (agent.id, agent.name))
        .collect();
    let live_sessions: HashMap<_, _> = crate::acp::resource_process_sessions()
        .into_iter()
        .map(|session| (session.pid, session))
        .collect();
    let processes: Vec<_> = sampler
        .system
        .processes()
        .iter()
        .map(|(pid, p)| {
            // Validate start time as well as PID to reject stale/reused identities.
            let live = live_sessions
                .get(&pid.as_u32())
                .filter(|session| p.start_time().abs_diff(session.spawned_at) <= 2);
            let task = live
                .map(|session| Some((session.project.clone(), session.task.clone())))
                .unwrap_or_else(|| env_task(p.environ(), &inventory));
            let session = session_label(
                &task,
                live.and_then(|session| session.chat.as_deref())
                    .or_else(|| env_value(p.environ(), "GROVE_CHAT_ID=")),
                live.map(|session| session.agent.as_str())
                    .or_else(|| env_value(p.environ(), "GROVE_AGENT_ID=")),
                &sessions,
                &names,
            );
            Process {
                pid: pid.as_u32(),
                parent: p.parent().map(|p| p.as_u32()),
                started: p.start_time(),
                name: p.name().to_string_lossy().into_owned(),
                cpu: p.cpu_usage() / cpu_count as f32,
                memory: p.memory(),
                task,
                session,
            }
        })
        .collect();
    let attribution = owners(&processes, std::process::id(), &sampler.owners);
    let mut project_groups: HashMap<String, HashMap<String, Vec<ProcessNode>>> = HashMap::new();
    let mut shared = group(
        "shared".into(),
        "Grove runtime".into(),
        "shared",
        "Server and shared child processes".into(),
    );
    for (owner, node) in rollup_processes(&processes, &attribution, &sampler.owners, ready) {
        if let Some((project, task)) = owner {
            project_groups
                .entry(project)
                .or_default()
                .entry(task)
                .or_default()
                .push(node);
        } else {
            shared.children.push(node);
        }
    }
    let mut groups = vec![];
    for (project_key, tasks) in project_groups {
        let mut project = group(
            format!("project:{project_key}"),
            inventory.project_name(&project_key),
            "project",
            String::new(),
        );
        for (task_key, processes) in tasks {
            let mut task = group(
                format!("task:{project_key}:{task_key}"),
                inventory.task_name(&project_key, &task_key),
                "task",
                String::new(),
            );
            task.children = processes;
            totals(&mut task, ready);
            project.children.push(task);
        }
        totals(&mut project, ready);
        groups.push(project);
    }
    totals(&mut shared, ready);
    if !shared.children.is_empty() {
        groups.push(shared);
    }
    let snapshot = ProcessSnapshot {
        sampled_at: chrono::Utc::now().to_rfc3339(),
        logical_cpus: cpu_count,
        cpu_percent: ready.then(|| groups.iter().filter_map(|g| g.cpu_percent).sum()),
        memory_bytes: groups.iter().map(|g| g.memory_bytes).sum(),
        process_count: attribution.len(),
        groups,
    };
    sampler.owners = processes
        .iter()
        .filter_map(|p| {
            attribution
                .get(&p.pid)
                .map(|owner| ((p.pid, p.started), owner.clone()))
        })
        .collect();
    sampler.last = Some(Instant::now());
    sampler.snapshot = Some(snapshot.clone());
    Ok(snapshot)
}

pub async fn snapshot() -> Result<Json<ProcessSnapshot>, StatusCode> {
    tokio::task::spawn_blocking(sample)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::super::{Project, Task};
    use super::*;

    #[test]
    fn requires_a_known_project_and_task_for_environment_attribution() {
        let inventory = Inventory {
            projects: HashMap::from([(
                "key".into(),
                Project {
                    name: "Project".into(),
                    path: "/repo".into(),
                },
            )]),
            tasks: HashMap::from([(
                ("key".into(), "task".into()),
                Task {
                    name: "Task".into(),
                    worktree: "/worktree".into(),
                },
            )]),
        };
        for project in ["GROVE_PROJECT_KEY=key", "GROVE_PROJECT=/repo"] {
            let env = [
                project.into(),
                "GROVE_TASK_ID=task".into(),
                "TOKEN=private".into(),
            ];
            assert_eq!(
                env_task(&env, &inventory),
                Some(("key".into(), "task".into()))
            );
        }
        assert!(env_task(
            &[
                "GROVE_PROJECT_KEY=key".into(),
                "GROVE_TASK_ID=unknown".into()
            ],
            &inventory
        )
        .is_none());
        assert!(env_task(&["GROVE_TASK_ID=task".into()], &inventory).is_none());
    }

    fn process(pid: u32, parent: Option<u32>, task: Owner) -> Process {
        Process {
            pid,
            parent,
            task,
            started: 100,
            name: "agent".into(),
            cpu: 0.0,
            memory: 0,
            session: None,
        }
    }

    #[test]
    fn labels_agents_by_exact_session_and_preserves_same_named_sessions_as_separate_rows() {
        let owner = Some(("p".into(), "t".into()));
        let sessions = HashMap::from([
            (
                ("p".into(), "t".into(), "chat-a".into()),
                SessionLabel {
                    id: "chat-a".into(),
                    title: "Fix login".into(),
                    agent: "codex".into(),
                },
            ),
            (
                ("p".into(), "t".into(), "chat-b".into()),
                SessionLabel {
                    id: "chat-b".into(),
                    title: "Review login".into(),
                    agent: "codex".into(),
                },
            ),
        ]);
        let names = HashMap::from([
            ("codex-acp".into(), "Codex".into()),
            ("traex".into(), "TraeX".into()),
        ]);
        let a = session_label(&owner, Some("chat-a"), None, &sessions, &names).unwrap();
        assert_eq!(a.agent, "Codex");
        assert!(session_label(
            &Some(("wrong".into(), "t".into())),
            Some("chat-a"),
            None,
            &sessions,
            &names
        )
        .is_none());
        assert!(session_label(&owner, Some("unknown"), None, &sessions, &names).is_none());
        assert_eq!(
            session_label(&owner, Some("chat-a"), Some("traex"), &sessions, &names)
                .unwrap()
                .agent,
            "TraeX"
        );
        let mut first = process(2, None, owner.clone());
        first.name = "node".into();
        first.session = Some(a.clone());
        let mut child = process(3, Some(2), owner.clone());
        child.session = Some(a);
        let mut second = process(4, Some(2), owner.clone());
        second.name = "node".into();
        second.session = session_label(&owner, Some("chat-b"), None, &sessions, &names);
        let processes = [first, child, second];
        let attribution = owners(&processes, 1, &HashMap::new());
        let rows = rollup_processes(&processes, &attribution, &HashMap::new(), false);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|(_, row)| row.name == "Codex"));
        assert!(rows
            .iter()
            .any(|(_, row)| row.detail == "Fix login · chat-a · PID 2 · includes 1 subprocess"));
        assert!(rows
            .iter()
            .any(|(_, row)| row.detail == "Review login · chat-b · PID 4"));
    }

    #[test]
    fn rolls_up_descendants_once_without_merging_siblings_or_other_tasks() {
        let task = Some(("p".into(), "t".into()));
        let other = Some(("p".into(), "other".into()));
        let mut processes = vec![
            process(1, None, None),
            process(2, Some(1), task.clone()),
            process(3, Some(2), None),
            process(4, Some(3), None),
            process(5, Some(1), task.clone()),
            process(6, Some(3), other.clone()),
            process(7, Some(6), None),
            process(8, None, None), // unrelated and excluded
        ];
        for process in &mut processes {
            process.cpu = process.pid as f32;
            process.memory = u64::from(process.pid) * 100;
        }
        processes.reverse(); // OS enumeration need not put parents first.
        let attribution = owners(&processes, 1, &HashMap::new());
        let previous = attribution
            .iter()
            .map(|(&pid, owner)| ((pid, 100), owner.clone()))
            .collect();
        let rows: HashMap<_, _> = rollup_processes(&processes, &attribution, &previous, true)
            .into_iter()
            .map(|(owner, node)| (node.id.clone(), (owner, node)))
            .collect();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows["pid:2:100"].0, task);
        assert_eq!(rows["pid:2:100"].1.cpu_percent, Some(9.0));
        assert_eq!(rows["pid:2:100"].1.memory_bytes, 900);
        assert_eq!(
            rows["pid:2:100"].1.detail,
            "PID 2 · includes 2 subprocesses"
        );
        assert_eq!(rows["pid:5:100"].1.memory_bytes, 500);
        assert_eq!(rows["pid:6:100"].0, other);
        assert_eq!(rows["pid:6:100"].1.memory_bytes, 1300);
        assert_eq!(rows["pid:1:100"].1.memory_bytes, 100);
        assert_eq!(
            rows.values().map(|(_, row)| row.memory_bytes).sum::<u64>(),
            2800
        );
        assert_eq!(
            rows.values()
                .filter_map(|(_, row)| row.cpu_percent)
                .sum::<f32>(),
            28.0
        );
        assert!(rows.values().all(|(_, row)| row.children.is_empty()));
    }

    #[test]
    fn rollup_keeps_orphans_and_rejects_reused_parent_pids() {
        let task = Some(("p".into(), "t".into()));
        let mut newer_parent = process(2, None, task.clone());
        newer_parent.started = 200;
        let mut processes = vec![
            newer_parent,
            process(3, Some(2), task.clone()),
            process(4, Some(99), task.clone()),
            process(5, Some(4), task),
        ];
        for process in &mut processes {
            process.memory = 100;
        }
        let attribution = owners(&processes, 1, &HashMap::new());
        let rows: HashMap<_, _> =
            rollup_processes(&processes, &attribution, &HashMap::new(), false)
                .into_iter()
                .map(|(_, node)| (node.id.clone(), node))
                .collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows["pid:2:200"].memory_bytes, 100);
        assert_eq!(rows["pid:3:100"].memory_bytes, 100);
        assert_eq!(rows["pid:4:100"].memory_bytes, 200);
        assert!(rows.values().all(|row| row.cpu_percent.is_none()));
    }

    #[test]
    fn rollup_only_adds_valid_cpu_samples_from_existing_processes() {
        let task = Some(("p".into(), "t".into()));
        let mut processes = vec![
            process(2, None, task),
            process(3, Some(2), None),
            process(4, Some(2), None),
        ];
        processes[0].cpu = 2.0;
        processes[1].cpu = 99.0; // first sample for this child is unavailable
        processes[2].cpu = f32::NAN;
        let attribution = owners(&processes, 1, &HashMap::new());
        let previous = HashMap::from([
            ((2, 100), attribution[&2].clone()),
            ((4, 100), attribution[&4].clone()),
        ]);
        let rows = rollup_processes(&processes, &attribution, &previous, true);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1.cpu_percent, Some(2.0));
        assert_eq!(rows[0].1.detail, "PID 2 · includes 2 subprocesses");
    }

    #[test]
    fn attributes_tasks_and_children_but_not_unrelated_agents() {
        let task = Some(("p".into(), "t".into()));
        let processes = vec![
            process(4, Some(3), None),
            process(3, Some(2), task.clone()),
            process(2, Some(1), None),
            process(1, None, task.clone()),
            process(9, None, None),
            process(10, None, task.clone()),
        ];
        let result = owners(&processes, 1, &HashMap::new());
        assert_eq!(result.get(&1), Some(&None));
        assert_eq!(result.get(&2), Some(&None));
        assert_eq!(result.get(&3), Some(&task));
        assert_eq!(result.get(&4), Some(&task));
        assert_eq!(result.get(&10), Some(&task)); // detached tmux task
        assert!(!result.contains_key(&9));
    }

    #[test]
    fn preserves_reparented_children_but_rejects_reused_pids() {
        let task = Some(("p".into(), "t".into()));
        let previous = HashMap::from([((2, 100), task.clone()), ((3, 99), task.clone())]);
        let result = owners(
            &[process(2, None, None), process(3, None, None)],
            1,
            &previous,
        );
        assert_eq!(result.get(&2), Some(&task));
        assert!(!result.contains_key(&3));
    }

    #[test]
    fn does_not_adopt_an_older_process_through_a_reused_parent_pid() {
        let mut parent = process(1, None, None);
        parent.started = 200;
        let result = owners(&[parent, process(2, Some(1), None)], 1, &HashMap::new());
        assert!(!result.contains_key(&2));
    }
}
