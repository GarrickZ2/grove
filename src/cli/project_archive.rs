//! `grove export` / `grove import`: move one Project's data between installs.

use std::path::PathBuf;

use crate::error::Result;
use crate::storage::project_archive::{
    default_export_file_name, export_project, import_project, resolve_project, ExportSummary,
    ImportOptions, ImportReport,
};

pub fn run_export(project: Option<String>, output: Option<PathBuf>) -> Result<()> {
    let selector = match project {
        Some(p) => p,
        None => std::env::current_dir()?.to_string_lossy().to_string(),
    };
    let (hash, registered) = resolve_project(&selector)?;
    let output = output.unwrap_or_else(|| {
        PathBuf::from(default_export_file_name(
            &registered.name,
            chrono::Local::now().date_naive(),
        ))
    });
    let summary = export_project(&hash, &output)?;
    println!("{}", format_export_summary(&summary));
    Ok(())
}

pub fn run_import(
    archive: PathBuf,
    path: Option<PathBuf>,
    name: Option<String>,
    dry_run: bool,
    merge: bool,
) -> Result<()> {
    let report = import_project(
        &archive,
        &ImportOptions {
            path,
            name,
            dry_run,
            merge,
        },
    )?;
    println!("{}", format_import_report(&report));
    Ok(())
}

fn format_export_summary(summary: &ExportSummary) -> String {
    let mut out = format!("Exported project to {}\n", summary.output.display());
    for (table, count) in summary.rows.iter().filter(|(_, n)| **n > 0) {
        out.push_str(&format!("  {table}: {count} row(s)\n"));
    }
    out.push_str(&format!("  files: {} file(s)", summary.files));
    out
}

fn format_import_report(report: &ImportReport) -> String {
    let mut out = String::new();
    if report.dry_run {
        out.push_str("Dry run — nothing was imported.\n");
    }
    let action = match (report.dry_run, report.registered) {
        (true, true) => "Would register",
        (false, true) => "Registered",
        (true, false) => "Would merge into",
        (false, false) => "Merged into",
    };
    out.push_str(&format!(
        "{action} project {} ({}) at {}\n",
        report.project_name, report.project_hash, report.project_path
    ));
    for (table, c) in report
        .rows
        .iter()
        .filter(|(_, c)| c.inserted > 0 || c.skipped > 0)
    {
        out.push_str(&format!(
            "  {table}: {} inserted, {} skipped\n",
            c.inserted, c.skipped
        ));
    }
    out.push_str(&format!(
        "  files: {} copied, {} skipped\n",
        report.files_copied, report.files_skipped
    ));
    if report.tasks_archived > 0 {
        out.push_str(&format!(
            "  {} task(s) archived (their worktrees do not exist here)\n",
            report.tasks_archived
        ));
    }
    if report.automations_disabled > 0 {
        out.push_str(&format!(
            "  {} automation(s) disabled\n",
            report.automations_disabled
        ));
    }
    if report.links_dropped > 0 {
        out.push_str(&format!("  {} link(s) dropped\n", report.links_dropped));
    }
    if !report.tasks_conflicting.is_empty() {
        out.push_str(&format!(
            "  Skipped {} task(s) whose id is already used here by a different task: {}\n",
            report.tasks_conflicting.len(),
            report.tasks_conflicting.join(", ")
        ));
    }
    if !report.tables_skipped.is_empty() {
        out.push_str(&format!(
            "  tables skipped (unknown to this Grove): {}\n",
            report.tables_skipped.join(", ")
        ));
    }
    if !report.dry_run {
        out.push_str("Reload Grove to see the imported project.");
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use crate::storage::project_archive::import::TableCount;
    use clap::Parser;

    fn sample_report() -> ImportReport {
        let mut report = ImportReport {
            project_hash: "abc123".into(),
            project_name: "demo".into(),
            project_path: "/tmp/demo".into(),
            registered: true,
            files_copied: 3,
            files_skipped: 1,
            tasks_archived: 2,
            automations_disabled: 1,
            links_dropped: 4,
            tables_skipped: vec!["future_table".into()],
            tasks_conflicting: vec!["fix-login".into(), "docs".into()],
            ..Default::default()
        };
        report.rows.insert(
            "tasks".into(),
            TableCount {
                inserted: 5,
                skipped: 2,
            },
        );
        report
    }

    #[test]
    fn format_import_report_lists_counts_and_reload_hint() {
        let mut report = sample_report();
        report.registered = false;
        let out = format_import_report(&report);
        assert!(out.starts_with("Merged into project demo (abc123) at /tmp/demo"));
        assert!(out.contains("tasks"));
        assert!(out.contains("5 inserted"));
        assert!(out.contains("2 skipped"));
        assert!(out.contains("3 copied"));
        assert!(out.contains("2 task(s) archived"));
        assert!(out.contains("1 automation(s) disabled"));
        assert!(out.contains("4 link(s) dropped"));
        assert!(out.contains("future_table"));
        assert!(out.contains(
            "Skipped 2 task(s) whose id is already used here by a different task: fix-login, docs"
        ));
        assert!(out.ends_with("Reload Grove to see the imported project."));
    }

    #[test]
    fn format_import_report_dry_run_header() {
        let mut report = sample_report();
        report.dry_run = true;
        let out = format_import_report(&report);
        assert!(out.starts_with("Dry run — nothing was imported.\nWould register project demo"));
        assert!(!out.contains("Reload Grove"));
    }

    #[test]
    fn format_export_summary_lists_output_and_counts() {
        let mut summary = ExportSummary {
            output: PathBuf::from("/tmp/x.tar.gz"),
            rows: Default::default(),
            files: 7,
        };
        summary.rows.insert("tasks".into(), 3);
        let out = format_export_summary(&summary);
        assert!(out.contains("/tmp/x.tar.gz"));
        assert!(out.contains("tasks"));
        assert!(out.contains("7 file(s)"));
    }

    #[test]
    fn cli_parses_export_and_import() {
        let parse = |args: &[&str]| Cli::try_parse_from(args).unwrap().command.unwrap();
        let cmd = parse(&["grove", "import", "x.tar.gz", "--dry-run"]);
        assert!(cmd.needs_local_storage());
        assert!(cmd.skips_startup_side_effects());
        assert!(matches!(
            cmd,
            crate::cli::Commands::Import {
                dry_run: true,
                merge: false,
                ..
            }
        ));
        assert!(matches!(
            parse(&["grove", "import", "x.tar.gz", "--merge"]),
            crate::cli::Commands::Import { merge: true, .. }
        ));
        let cmd = parse(&["grove", "export", "--project", "p", "-o", "o.tar.gz"]);
        assert!(cmd.needs_local_storage());
        assert!(cmd.skips_startup_side_effects());
        assert!(!parse(&["grove", "web"]).skips_startup_side_effects());
    }
}
