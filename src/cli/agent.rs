use std::env;

use clap::Subcommand;

use crate::storage::workspace::project_hash;
use crate::storage::{ai_data, notes};

#[derive(Subcommand)]
pub enum AgentCommands {
    /// Check if running inside a Grove task
    Status,
    /// Read or write cumulative work summary
    Summary {
        /// The complete summary text (omit to read)
        text: Option<String>,
    },
    /// Read or write TODO list
    Todo {
        /// Pending TODO items (replaces all)
        #[arg(long = "todo", num_args = 1..)]
        todo_items: Option<Vec<String>>,
        /// Completed items (replaces all)
        #[arg(long = "done", num_args = 1..)]
        done_items: Option<Vec<String>>,
    },
    /// Read user-written notes
    Notes,
}

/// Execute `grove agent <subcommand>`
pub fn execute(cmd: AgentCommands) {
    match cmd {
        AgentCommands::Status => cmd_status(),
        AgentCommands::Summary { text } => cmd_summary(text),
        AgentCommands::Todo {
            todo_items,
            done_items,
        } => cmd_todo(todo_items, done_items),
        AgentCommands::Notes => cmd_notes(),
    }
}

fn get_task_context() -> Option<(String, String)> {
    let task_id = env::var("GROVE_TASK_ID").ok()?;
    let project_path = env::var("GROVE_PROJECT").ok()?;
    if task_id.is_empty() || project_path.is_empty() {
        return None;
    }
    Some((task_id, project_path))
}

fn cmd_status() {
    match get_task_context() {
        Some((task_id, _project_path)) => {
            let task_name = env::var("GROVE_TASK_NAME").unwrap_or_default();
            let branch = env::var("GROVE_BRANCH").unwrap_or_default();
            let target = env::var("GROVE_TARGET").unwrap_or_default();
            let project_name = env::var("GROVE_PROJECT_NAME").unwrap_or_default();

            // Check if GROVE.md exists in the current worktree directory
            let grove_md_exists = env::current_dir()
                .map(|cwd| cwd.join("GROVE.md").exists())
                .unwrap_or(false);

            println!("task_id={}", task_id);
            println!("task_name={}", task_name);
            println!("branch={}", branch);
            println!("target={}", target);
            println!("project={}", project_name);
            println!("grove_md={}", grove_md_exists);
        }
        None => {
            println!("not_in_grove_task");
        }
    }
}

fn cmd_summary(text: Option<String>) {
    let Some((task_id, project_path)) = get_task_context() else {
        eprintln!("Error: not in a Grove task (GROVE_TASK_ID / GROVE_PROJECT not set)");
        std::process::exit(1);
    };

    let project_key = project_hash(&project_path);

    match text {
        Some(content) => {
            // Write
            if let Err(e) = ai_data::save_summary(&project_key, &task_id, &content) {
                eprintln!("Error saving summary: {}", e);
                std::process::exit(1);
            }
        }
        None => {
            // Read
            match ai_data::load_summary(&project_key, &task_id) {
                Ok(s) => print!("{}", s),
                Err(e) => {
                    eprintln!("Error reading summary: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }
}

fn cmd_todo(todo_items: Option<Vec<String>>, done_items: Option<Vec<String>>) {
    let Some((task_id, project_path)) = get_task_context() else {
        eprintln!("Error: not in a Grove task (GROVE_TASK_ID / GROVE_PROJECT not set)");
        std::process::exit(1);
    };

    let project_key = project_hash(&project_path);

    if todo_items.is_some() || done_items.is_some() {
        // Write mode
        let data = ai_data::TodoData {
            todo: todo_items.unwrap_or_default(),
            done: done_items.unwrap_or_default(),
        };
        if let Err(e) = ai_data::save_todo(&project_key, &task_id, &data) {
            eprintln!("Error saving TODO: {}", e);
            std::process::exit(1);
        }
    } else {
        // Read mode
        match ai_data::load_todo(&project_key, &task_id) {
            Ok(data) => {
                for item in &data.todo {
                    println!("□ {}", item);
                }
                for item in &data.done {
                    println!("✓ {}", item);
                }
            }
            Err(e) => {
                eprintln!("Error reading TODO: {}", e);
                std::process::exit(1);
            }
        }
    }
}

fn cmd_notes() {
    let Some((task_id, project_path)) = get_task_context() else {
        eprintln!("Error: not in a Grove task (GROVE_TASK_ID / GROVE_PROJECT not set)");
        std::process::exit(1);
    };

    let project_key = project_hash(&project_path);

    match notes::load_notes(&project_key, &task_id) {
        Ok(s) => print!("{}", s),
        Err(e) => {
            eprintln!("Error reading notes: {}", e);
            std::process::exit(1);
        }
    }
}
