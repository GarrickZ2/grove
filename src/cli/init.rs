use std::fs;
use std::path::Path;
use std::process::Command;

const GROVE_MD_CONTENT: &str = r#"# Grove Task Integration

You are working in a Grove-managed task environment. Grove tracks your progress through TODO lists and summaries. **You MUST follow this workflow.**

## Commands

```bash
grove agent status                                # Check if in Grove task
grove agent notes                                 # Read user notes (context/requirements)
grove agent summary                               # Read current summary
grove agent summary "Your complete summary"       # Overwrite summary (full replace)
grove agent todo                                  # Read current TODO list
grove agent todo --todo "a" "b" --done "c"        # Replace full TODO list
```

---

## Workflow

### 1. Conversation Start (REQUIRED)

At the **beginning of each conversation**, read the current state once:

```bash
grove agent status        # Verify you're in a Grove task
grove agent notes         # User's context (read once, like CLAUDE.md)
grove agent summary       # What's been done so far
grove agent todo          # Current TODO items
```

Notes are static context — only re-read if the user explicitly asks you to.

If TODO is empty, analyze the user's request, create initial items, and **immediately send to Grove**:

```bash
grove agent todo --todo "task 1" "task 2" "task 3"
```

### 2. TODO Tracking (REQUIRED)

**Every time** you complete a task item, **immediately update Grove** — do NOT batch updates:

```bash
# After finishing "task 1":
grove agent todo --todo "task 2" "task 3" --done "task 1"

# After finishing "task 2":
grove agent todo --todo "task 3" --done "task 1" "task 2"
```

This is a **full replace** — you must include ALL items (remaining in `--todo`, completed in `--done`) every time.

If you discover new work items during implementation, add them immediately:

```bash
grove agent todo --todo "task 3" "new task found" --done "task 1" "task 2"
```

**IMPORTANT:** If you use your own built-in task/todo tools (e.g. TodoWrite, TaskCreate, TaskUpdate, or similar), you MUST also sync the same state to Grove via `grove agent todo`. Your internal tools are invisible to Grove — always mirror your task list to Grove so the user can track progress from the Grove TUI.

### 3. After Milestone / Conversation End

Update Summary when you complete a feature, or before ending:

```bash
grove agent summary       # Read current
grove agent summary "..." # Write new (full replace)
```

---

## TODO Guidelines

**Format:** Short, actionable items — verb + object
- ✓ "Add user authentication"
- ✓ "Fix login redirect bug"
- ✗ "Authentication stuff"

**What to include:**
- Remaining work items
- Items you've completed (in --done)

---

## Summary Guidelines

A **cumulative record** of all work on this task. Structure:

```
## What's Done
- Completed features/fixes with key decisions

## Current State
- What's working, any workarounds

## Blockers
- Long-term blockers (waiting on API, pending review, etc.)
- Include who/what is blocking and since when

## Known Issues
- Bugs found, tech debt

## Next Steps
- What to tackle next
```

**Style:** Be specific ("Added JWT auth with 24h expiry" not "Added auth"), include file paths, keep under 500 words.

---

## Quick Reference

| When | Action |
|------|--------|
| Conversation start | Read `notes`, `summary`, `todo` (once) |
| TODO is empty | Create initial items and send `todo` immediately |
| After each task item | Update `todo` immediately (don't batch) |
| Discover new work | Add to `todo` immediately |
| After milestone | Update `summary` |
| Hit a blocker | Record in `summary` Blockers section |
| Conversation end | Update `todo` and `summary` |
"#;

const GROVE_INJECT_START: &str = "<!-- grove:start -->";
const GROVE_INJECT_END: &str = "<!-- grove:end -->";

fn grove_inject_block() -> String {
    format!(
        r#"{}
IMPORTANT — Grove Task Integration

At the START of every new session, you MUST run `grove agent status` as your first action.

- If the output contains a task_id: you are in a Grove-managed task.
  Read and follow ALL instructions in GROVE.md for the entire session.
- Otherwise: ignore GROVE.md and any Grove-related context entirely.
{}"#,
        GROVE_INJECT_START, GROVE_INJECT_END
    )
}

/// 创建 worktree 后自动设置 AI 集成
/// 在 worktree 目录生成 GROVE.md + 注入配置中指定的上下文文档 + exclude GROVE.md
pub fn setup_worktree(worktree_path: &str, context_docs: &[String]) {
    let root = Path::new(worktree_path);

    // 1. 生成 GROVE.md
    let grove_md_path = root.join("GROVE.md");
    if let Err(e) = fs::write(&grove_md_path, GROVE_MD_CONTENT) {
        eprintln!("Warning: Failed to write GROVE.md: {}", e);
        return;
    }

    // 2. 按配置注入上下文文档
    if context_docs.is_empty() {
        // 无配置时保持老行为：检测已有文件或创建三个默认
        let claude_md = root.join("CLAUDE.md");
        let agents_md = root.join("AGENTS.md");
        let gemini_md = root.join("GEMINI.md");

        let claude_exists = claude_md.exists();
        let agents_exists = agents_md.exists();
        let gemini_exists = gemini_md.exists();

        if claude_exists || agents_exists || gemini_exists {
            if claude_exists {
                inject_to_file(&claude_md);
            }
            if agents_exists {
                inject_to_file(&agents_md);
            }
            if gemini_exists {
                inject_to_file(&gemini_md);
            }
        } else {
            let block = grove_inject_block();
            let _ = fs::write(&claude_md, &block);
            let _ = fs::write(&agents_md, &block);
            let _ = fs::write(&gemini_md, &block);
        }
    } else {
        for doc_name in context_docs {
            let doc_path = root.join(doc_name);
            if doc_path.exists() {
                inject_to_file(&doc_path);
            } else {
                // 文件不存在则创建
                let block = grove_inject_block();
                let _ = fs::write(&doc_path, &block);
            }
        }
    }

    // 3. 将 GROVE.md 加入 .git/info/exclude
    add_grove_to_exclude(worktree_path);
}

/// 将 GROVE.md 加入 .git/info/exclude（如果尚未存在）
fn add_grove_to_exclude(worktree_path: &str) {
    // 获取 git common dir（所有 worktree 共享的 .git 目录）
    let output = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(worktree_path)
        .output();

    let common_dir = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => return,
    };

    let exclude_path = Path::new(&common_dir).join("info").join("exclude");

    // 确保 info 目录存在
    if let Some(parent) = exclude_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // 读取现有内容
    let content = fs::read_to_string(&exclude_path).unwrap_or_default();

    // 检查是否已包含 GROVE.md
    if content.lines().any(|line| line.trim() == "GROVE.md") {
        return;
    }

    // 追加 GROVE.md
    let new_content = if content.is_empty() || content.ends_with('\n') {
        format!("{}GROVE.md\n", content)
    } else {
        format!("{}\nGROVE.md\n", content)
    };

    let _ = fs::write(&exclude_path, new_content);
}

fn inject_to_file(path: &Path) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let block = grove_inject_block();

    let new_content = if content.contains(GROVE_INJECT_START) {
        if let (Some(start), Some(end)) = (
            content.find(GROVE_INJECT_START),
            content.find(GROVE_INJECT_END),
        ) {
            let end = end + GROVE_INJECT_END.len();
            format!("{}{}{}", &content[..start], block, &content[end..])
        } else {
            format!("{}\n\n{}\n", content, block)
        }
    } else {
        format!("{}\n\n{}\n", content.trim_end(), block)
    };

    let _ = fs::write(path, new_content);
}
