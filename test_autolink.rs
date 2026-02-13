// 临时测试脚本
use std::path::Path;

fn main() {
    // 加载配置
    let config = grove::storage::config::load_config();
    println!("AutoLink patterns: {:?}", config.auto_link.patterns);

    // 测试路径
    let worktree = Path::new("/Users/bytedance/.grove/worktrees/1bb5b3564b3ae517/new-test-222");
    let main_repo = Path::new("/Users/bytedance/RustroverProjects/grove");

    println!("\nWorktree: {}", worktree.display());
    println!("Main repo: {}", main_repo.display());

    // 测试 gitignore 检查
    println!("\nChecking gitignore status:");
    for path in &[".claude", "docs", "grove-web/node_modules"] {
        match grove::git::is_gitignored(main_repo.to_str().unwrap(), path) {
            Ok(true) => println!("  ✓ {} is gitignored", path),
            Ok(false) => println!("  ✗ {} is tracked", path),
            Err(e) => println!("  ! {} error: {}", path, e),
        }
    }

    // 测试创建软链接
    println!("\nCreating symlinks:");
    match grove::git::create_worktree_symlinks(
        worktree,
        main_repo,
        &config.auto_link.patterns,
        true,
    ) {
        Ok(links) => {
            println!("Created {} link(s):", links.len());
            for link in links {
                println!("  ✓ {}", link);
            }
        }
        Err(e) => {
            println!("Error: {}", e);
        }
    }
}
