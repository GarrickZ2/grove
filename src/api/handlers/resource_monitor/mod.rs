//! User-facing, on-demand resource inventory. Independent of dev perf tracing.
pub mod processes;
pub mod storage;

use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Inventory {
    pub projects: HashMap<String, Project>,
    pub tasks: HashMap<(String, String), Task>,
}

pub(super) struct Project {
    pub name: String,
    pub path: String,
}

pub(super) struct Task {
    pub name: String,
    pub worktree: String,
}

impl Inventory {
    pub fn load() -> rusqlite::Result<Self> {
        // Use persisted keys (including archived projects/tasks), not path hashes
        // recomputed under possibly different normalization rules.
        let db = crate::storage::database::connection();
        let projects = db
            .prepare("SELECT hash, name, path FROM projects")?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    Project {
                        name: row.get(1)?,
                        path: row.get(2)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let tasks = db
            .prepare("SELECT project, id, name, worktree_path FROM tasks")?
            .query_map([], |row| {
                Ok((
                    (row.get(0)?, row.get(1)?),
                    Task {
                        name: row.get(2)?,
                        worktree: row.get(3)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self { projects, tasks })
    }

    pub fn project_name(&self, key: &str) -> String {
        self.projects
            .get(key)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| format!("Unregistered project · {key}"))
    }

    pub fn task_name(&self, project: &str, task: &str) -> String {
        self.tasks
            .get(&(project.to_owned(), task.to_owned()))
            .map(|t| t.name.clone())
            .unwrap_or_else(|| task.to_owned())
    }
}
