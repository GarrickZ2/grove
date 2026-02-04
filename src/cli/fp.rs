//! fp 子命令实现 - File Picker

use std::process::Command;

use crate::check::check_fzf;

pub fn execute() {
    // 检查 fzf 依赖
    if !check_fzf() {
        eprintln!("Error: fzf is not installed.");
        eprintln!("Install: brew install fzf");
        std::process::exit(1);
    }

    // 使用 shell 脚本实现交互式文件选择器
    let script = r#"
while true; do
    selected=$(find . -not -path '*/\.*' -not -path '*/node_modules/*' 2>/dev/null | \
               fzf --multi \
                   --query="" \
                   --preview '[[ -f {} ]] && bat --color=always {} 2>/dev/null || cat {} 2>/dev/null || ls -la {}' \
                   --preview-window=right:60%:wrap \
                   --bind 'ctrl-/:toggle-preview' \
                   --header 'Tab: multi-select | Enter: copy path | Ctrl-O: open | Ctrl-C: exit' \
                   --expect=ctrl-o)

    [ -z "$selected" ] && echo "✓ Exited" && exit 0

    action=$(echo "$selected" | head -n1)
    selected=$(echo "$selected" | tail -n +2)
    [ -z "$selected" ] && continue

    selected=$(echo "$selected" | sed 's|^\./||g')

    if [ "$action" = "ctrl-o" ]; then
        while IFS= read -r file; do
            [ -f "$file" ] && open "$file" && echo "✓ Opened: $file"
            [ -d "$file" ] && open "$file" && echo "✓ Opened folder: $file"
        done <<< "$selected"
    else
        count=$(echo "$selected" | wc -l | tr -d ' ')
        if [ "$count" -eq 1 ]; then
            echo -n "$selected" | pbcopy
            echo "✓ Copied: $selected"
        else
            echo -n "$selected" | tr '\n' ' ' | sed 's/ $//' | pbcopy
            echo "✓ Copied $count files (space-separated):"
            echo "$selected" | tr '\n' ' '
            echo ""
        fi
    fi
    sleep 0.3
done
"#;

    let status = Command::new("bash").arg("-c").arg(script).status();

    if let Err(e) = status {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
