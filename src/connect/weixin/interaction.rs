//! WeChat-only text presentation and secondary commands. Feishu keeps cards.
use crate::connect::commands::CardSpec;
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub enum Response {
    Pass,
    Text(String),
    Action {
        name: String,
        fields: HashMap<String, String>,
        source: String,
    },
    RefreshTarget {
        fields: HashMap<String, String>,
        stage: String,
    },
}

struct Menu {
    data: Value,
    scope: String,
    stage: Option<String>,
    created: Instant,
}
struct Request {
    data: Value,
    source: String,
    scope: String,
    fields: HashMap<String, String>,
    created: Instant,
}
#[derive(Default)]
pub struct Ui {
    menu: Option<Menu>,
    requests: HashMap<String, Request>,
}
const TTL: Duration = Duration::from_secs(15 * 60);

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn option(options: &[Value], choice: &str, id: &str) -> Option<String> {
    options
        .iter()
        .find(|value| string(&value[id]) == choice)
        .or_else(|| {
            choice
                .parse::<usize>()
                .ok()
                .and_then(|number| number.checked_sub(1))
                .and_then(|index| options.get(index))
        })
        .map(|value| string(&value[id]).into())
}
fn config_key(label: &str) -> String {
    let label = label.to_lowercase();
    if label.contains("thought") || label.contains("effort") {
        "effort".into()
    } else {
        label.split_whitespace().collect::<Vec<_>>().join("_")
    }
}
fn options_text(options: &[Value], label: &str) -> String {
    options
        .iter()
        .enumerate()
        .map(|(index, value)| {
            format!(
                "{}. {} ({})",
                index + 1,
                string(&value[label]),
                string(&value["id"])
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

impl Ui {
    pub fn has_menu(&self, kind: &str, scope: &str) -> bool {
        self.menu.as_ref().is_some_and(|menu| {
            menu.scope == scope
                && menu.created.elapsed() < TTL
                && string(&menu.data["type"]) == kind
        })
    }

    pub fn render(&mut self, spec: &CardSpec, source: &str, scope: &str) -> Result<String, String> {
        if let CardSpec::Notice(text) = spec {
            return Ok(text.clone());
        }
        let data = serde_json::to_value(spec).map_err(|error| error.to_string())?;
        let kind = string(&data["type"]);
        match kind {
            "new_session" => {
                let text = format!(
                    "Choose an agent:\n{}\nSend /new <agent_id> to create a session.",
                    options_text(list(&data["agents"]), "name")
                );
                self.menu = Some(Menu {
                    data,
                    scope: scope.into(),
                    stage: None,
                    created: Instant::now(),
                });
                Ok(text)
            }
            "target" => {
                let current = |key: &str, options: &str| {
                    let id = string(&data[key]);
                    list(&data[options])
                        .iter()
                        .find(|entry| string(&entry["id"]) == id)
                        .map(|entry| string(&entry["name"]).to_owned())
                        .unwrap_or_else(|| {
                            if id.is_empty() {
                                "Not selected / Create automatically".into()
                            } else {
                                id.into()
                            }
                        })
                };
                let text = format!("Current target:\nProject: {}\nTask: {}\nSession: {}\n\n/target project — Start from project selection\n/target task — Choose a task in the current project\n/target session — Choose a session in the current task\nChanges take effect only after completing the selection. Other messages or commands cancel draft selections.", current("project_id", "projects"), current("task_id", "tasks"), current("session_id", "sessions"));
                self.menu = Some(Menu {
                    data,
                    scope: scope.into(),
                    stage: None,
                    created: Instant::now(),
                });
                Ok(text)
            }
            "config" => {
                let lines = list(&data["selectors"])
                    .iter()
                    .map(|selector| {
                        format!(
                            "/config {} — {} (current: {})",
                            config_key(string(&selector["label"])),
                            string(&selector["label"]),
                            string(&selector["current"])
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                self.menu = Some(Menu {
                    data,
                    scope: scope.into(),
                    stage: None,
                    created: Instant::now(),
                });
                Ok(format!("Available settings:\n{lines}"))
            }
            "permission" => {
                let id = string(&data["request_id"]).to_owned();
                let text = format!(
                    "Permission request {id}:\n{}\n{}\nSend /respond {id} <option-number-or-id>.",
                    string(&data["description"]),
                    options_text(list(&data["options"]), "label")
                );
                self.store_request(id, data, source, scope);
                Ok(text)
            }
            "ask_form" | "elicitation" => {
                let (id, title, questions) = if kind == "ask_form" {
                    (
                        string(&data["form_id"]),
                        string(&data["definition"]["title"]),
                        list(&data["definition"]["questions"]),
                    )
                } else {
                    (
                        string(&data["request_id"]),
                        string(&data["message"]),
                        list(&data["fields"]),
                    )
                };
                let mut text = format!("{title}\nRequest ID: {id}\n");
                if let Some(description) = data["definition"]["description"].as_str() {
                    text.push_str(&format!("{description}\n"));
                }
                for field in questions {
                    let field_id = field["id"]
                        .as_str()
                        .or_else(|| field["name"].as_str())
                        .unwrap_or_default();
                    let label = field["title"]
                        .as_str()
                        .or_else(|| field["label"].as_str())
                        .unwrap_or_default();
                    text.push_str(&format!("\n{field_id}: {label}\n"));
                    if let Some(description) = field["description"].as_str() {
                        text.push_str(&format!("{description}\n"));
                    }
                    for (index, opt) in list(&field["options"]).iter().enumerate() {
                        text.push_str(&format!(
                            "{}. {}\n",
                            index + 1,
                            opt["label"]
                                .as_str()
                                .or_else(|| opt.get(1).and_then(Value::as_str))
                                .unwrap_or_default()
                        ));
                    }
                    text.push_str(&format!("/answer {id} {field_id} <answer>\n"));
                }
                text.push_str(&format!("\nSeparate multiple choices with commas. Use true/false for boolean answers.\n/submit {id} — Submit\n/decline {id} — Decline"));
                self.store_request(id.into(), data, source, scope);
                Ok(text)
            }
            "notice" => Ok(string(&data["text"]).to_owned()),
            _ => Err("Unsupported WeChat interaction".into()),
        }
    }

    fn store_request(&mut self, id: String, data: Value, source: &str, scope: &str) {
        self.requests
            .retain(|_, request| request.created.elapsed() < TTL);
        if self.requests.len() >= 32 {
            self.requests.clear();
        }
        let fields = self
            .requests
            .get(&id)
            .filter(|request| request.scope == scope)
            .map(|request| request.fields.clone())
            .unwrap_or_default();
        self.requests.insert(
            id,
            Request {
                data,
                source: source.into(),
                scope: scope.into(),
                fields,
                created: Instant::now(),
            },
        );
    }

    pub fn next_target(&mut self, stage: &str) -> String {
        let Some(menu) = &mut self.menu else {
            return "Send /target again.".into();
        };
        menu.stage = Some(stage.into());
        let (key, parent) = match stage {
            "project" => ("projects", None),
            "task" => ("tasks", Some("project_id")),
            _ => ("sessions", Some("task_id")),
        };
        if parent.is_some_and(|key| string(&menu.data[key]).is_empty()) {
            return "Select the parent target first.".into();
        }
        let mut text = format!("Choose a {stage}:");
        if stage == "session" {
            text.push_str("\n0. New session (created on the first message)");
        }
        for (index, value) in list(&menu.data[key]).iter().enumerate() {
            text.push_str(&format!("\n{}. {}", index + 1, string(&value["name"])));
        }
        text.push_str(&format!("\nSend /target {stage} <option-number>."));
        text
    }

    pub fn command(&mut self, text: &str, source: &str, scope: &str) -> Result<Response, String> {
        let parts: Vec<_> = text.split_whitespace().collect();
        let command = parts
            .first()
            .copied()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            command.as_str(),
            "/respond" | "/answer" | "/submit" | "/decline"
        ) {
            self.menu = None;
            return self.form_command(&command, &parts, text, source, scope);
        }
        if !matches!(command.as_str(), "/new" | "/clear" | "/target" | "/config")
            || parts.len() == 1
        {
            self.menu = None;
            return Ok(Response::Pass);
        }
        let kind = match command.as_str() {
            "/new" | "/clear" => "new_session",
            "/target" => "target",
            _ => "config",
        };
        if !self.has_menu(kind, scope) {
            self.menu = None;
            return Err(
                "These options have expired. Reopen the corresponding command first.".into(),
            );
        }
        let menu = self.menu.as_mut().unwrap();
        match kind {
            "new_session" => {
                if parts.len() != 2 {
                    return Err("Usage: /new <agent_id>".into());
                }
                let agent = option(list(&menu.data["agents"]), parts[1], "id")
                    .ok_or("Invalid agent. Send /new again.")?;
                self.menu = None;
                Ok(Response::Action {
                    name: "new_session_btn".into(),
                    fields: HashMap::from([("agent".into(), agent)]),
                    source: source.into(),
                })
            }
            "target" => {
                let stage = parts[1].to_ascii_lowercase();
                if !matches!(stage.as_str(), "project" | "task" | "session") || parts.len() > 3 {
                    return Err("Usage: /target project|task|session [option-number-or-id]".into());
                }
                if parts.len() == 2 {
                    return Ok(Response::Text(self.next_target(&stage)));
                }
                if menu.stage.as_deref() != Some(&stage) {
                    return Err(format!("Send /target {stage} to view the options first."));
                }
                let key = match stage.as_str() {
                    "project" => "projects",
                    "task" => "tasks",
                    _ => "sessions",
                };
                let value = if stage == "session" && parts[2] == "0" {
                    String::new()
                } else {
                    option(list(&menu.data[key]), parts[2], "id")
                        .ok_or("Invalid option. Reopen the list.")?
                };
                let mut fields = HashMap::from([
                    ("project".into(), string(&menu.data["project_id"]).into()),
                    ("task".into(), string(&menu.data["task_id"]).into()),
                    ("session".into(), string(&menu.data["session_id"]).into()),
                ]);
                fields.insert(stage.clone(), value);
                match stage.as_str() {
                    "project" => {
                        fields.insert("task".into(), String::new());
                        fields.insert("session".into(), String::new());
                        Ok(Response::RefreshTarget {
                            fields,
                            stage: "task".into(),
                        })
                    }
                    "task" => {
                        fields.insert("session".into(), String::new());
                        Ok(Response::RefreshTarget {
                            fields,
                            stage: "session".into(),
                        })
                    }
                    _ => {
                        self.menu = None;
                        Ok(Response::Action {
                            name: "save_target_btn".into(),
                            fields,
                            source: source.into(),
                        })
                    }
                }
            }
            _ => {
                if parts.len() > 3 {
                    return Err("Usage: /config <setting> [option-number-or-id]".into());
                }
                let selector = list(&menu.data["selectors"])
                    .iter()
                    .find(|selector| {
                        config_key(string(&selector["label"])) == parts[1].to_lowercase()
                            || string(&selector["name"]) == parts[1]
                    })
                    .ok_or("Unknown setting. Send /config again.")?;
                let name = string(&selector["name"]).to_owned();
                if parts.len() == 2 {
                    let text = list(&selector["options"])
                        .iter()
                        .enumerate()
                        .map(|(index, opt)| {
                            format!(
                                "{}. {} ({}){}",
                                index + 1,
                                string(&opt[1]),
                                string(&opt[0]),
                                if selector["current"] == opt[0] {
                                    " ← Current"
                                } else {
                                    ""
                                }
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    menu.stage = Some(name);
                    return Ok(Response::Text(format!(
                        "{}:\n{text}\nSend /config {} <option-number-or-id>.",
                        string(&selector["label"]),
                        parts[1]
                    )));
                }
                if menu.stage.as_deref() != Some(&name) {
                    return Err(format!(
                        "Send /config {} to view the options first.",
                        parts[1]
                    ));
                }
                let options = list(&selector["options"]);
                let selected = options
                    .iter()
                    .find(|opt| string(&opt[0]) == parts[2])
                    .or_else(|| {
                        parts[2]
                            .parse::<usize>()
                            .ok()
                            .and_then(|n| n.checked_sub(1))
                            .and_then(|n| options.get(n))
                    })
                    .ok_or("Invalid setting option.")?;
                let fields = HashMap::from([(name, string(&selected[0]).into())]);
                self.menu = None;
                Ok(Response::Action {
                    name: "save_config_btn".into(),
                    fields,
                    source: source.into(),
                })
            }
        }
    }

    fn form_command(
        &mut self,
        command: &str,
        parts: &[&str],
        text: &str,
        source: &str,
        scope: &str,
    ) -> Result<Response, String> {
        let id = parts.get(1).copied().ok_or("Provide a request ID.")?;
        let request = self
            .requests
            .get_mut(id)
            .ok_or("This request is no longer available. Wait for a new request.")?;
        if request.scope != scope || request.created.elapsed() >= TTL {
            self.requests.remove(id);
            return Err("This request has expired or the target has changed.".into());
        }
        let kind = string(&request.data["type"]);
        let fields;
        let name;
        match command {
            "/respond" if kind == "permission" => {
                if parts.len() != 3 {
                    return Err("Usage: /respond <request_id> <option>".into());
                }
                let selected = option(list(&request.data["options"]), parts[2], "id")
                    .ok_or("Invalid permission option.")?;
                fields = HashMap::from([
                    ("request_id".into(), id.into()),
                    ("option_id".into(), selected),
                ]);
                name = "permission".into();
            }
            "/answer" if kind != "permission" => {
                if parts.len() < 4 {
                    return Err("Usage: /answer <request_id> <field_id> <answer>".into());
                }
                let mut answer = text;
                for _ in 0..3 {
                    answer = answer.trim_start();
                    let end = answer.find(char::is_whitespace).unwrap_or(answer.len());
                    answer = &answer[end..];
                }
                let answer = answer.trim_start().to_owned();
                let questions = if kind == "ask_form" {
                    list(&request.data["definition"]["questions"])
                } else {
                    list(&request.data["fields"])
                };
                let field = questions
                    .iter()
                    .find(|field| {
                        field["id"].as_str().or_else(|| field["name"].as_str()) == Some(parts[2])
                    })
                    .ok_or("Unknown field.")?;
                let options = list(&field["options"]);
                let value = if options.is_empty() {
                    answer.clone()
                } else {
                    let selected: Result<Vec<_>, _> = answer
                        .split(',')
                        .map(|choice| {
                            let choice = choice.trim();
                            option(options, choice, "id")
                                .filter(|value| !value.is_empty())
                                .or_else(|| {
                                    options
                                        .iter()
                                        .find(|opt| string(&opt[0]) == choice)
                                        .or_else(|| {
                                            choice
                                                .parse::<usize>()
                                                .ok()
                                                .and_then(|n| n.checked_sub(1))
                                                .and_then(|n| options.get(n))
                                        })
                                        .map(|opt| string(&opt[0]).into())
                                })
                                .ok_or("Invalid answer option.")
                        })
                        .collect();
                    let selected = selected?;
                    if string(&field["type"]) == "multi_choice" {
                        selected.join(",")
                    } else if selected.len() == 1 {
                        selected[0].clone()
                    } else {
                        return Err("Choose only one option for this question.".into());
                    }
                };
                request.fields.insert(parts[2].into(), value);
                return Ok(Response::Text(format!(
                    "Saved a draft answer for {}. Send /submit {id} to submit.",
                    parts[2]
                )));
            }
            "/submit" | "/decline" if kind != "permission" && parts.len() == 2 => {
                let verb = if command == "/submit" {
                    "submit"
                } else {
                    "decline"
                };
                name = format!(
                    "{}_{}:{id}",
                    if kind == "ask_form" {
                        "ask_form"
                    } else {
                        "elicitation"
                    },
                    verb
                );
                fields = request.fields.clone();
            }
            _ => return Err("This command does not apply to the current request.".into()),
        }
        // Core validates the action. Failed form submissions keep their draft.
        Ok(Response::Action {
            name,
            fields,
            // An Ask Form becomes a fresh follow-up prompt. Use the submit
            // message's reply context, rather than the older form's context.
            source: if kind == "ask_form" {
                source.into()
            } else {
                request.source.clone()
            },
        })
    }

    pub fn action_completed(&mut self, name: &str, fields: &HashMap<String, String>) {
        if name == "permission" {
            if let Some(id) = fields.get("request_id") {
                self.requests.remove(id);
            }
        } else if let Some((_, id)) = name.split_once(':') {
            self.requests.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connect::commands::{
        ConfigCard, ConfigSelectorOption, PermissionCard, PermissionCardOption, ProjectOption,
        TargetCard, TaskOption,
    };

    fn target(project: &str, task: &str) -> CardSpec {
        CardSpec::Target(Box::new(TargetCard {
            project_id: project.into(),
            task_id: task.into(),
            session_id: "old-session".into(),
            projects: vec![
                ProjectOption {
                    id: "p1".into(),
                    name: "First".into(),
                },
                ProjectOption {
                    id: "p2".into(),
                    name: "Second".into(),
                },
            ],
            tasks: vec![TaskOption {
                id: "t2".into(),
                name: "Task".into(),
            }],
            sessions: vec![TaskOption {
                id: "s2".into(),
                name: "Session".into(),
            }],
        }))
    }

    #[test]
    fn target_cascade_only_commits_at_session_and_clears_downstream_choices() {
        let mut ui = Ui::default();
        let scope = "original";
        ui.render(&target("p1", "old-task"), "message", scope)
            .unwrap();
        assert!(matches!(
            ui.command("/target project", "message", scope).unwrap(),
            Response::Text(_)
        ));
        let Response::RefreshTarget { fields, stage } =
            ui.command("/target project 2", "message", scope).unwrap()
        else {
            panic!("selection must not commit")
        };
        assert_eq!(fields["project"], "p2");
        assert_eq!(fields["task"], "");
        assert_eq!(fields["session"], "");
        assert_eq!(stage, "task");
        ui.render(&target("p2", ""), "message", scope).unwrap();
        ui.next_target(&stage);
        let Response::RefreshTarget { fields, stage } =
            ui.command("/target task 1", "message", scope).unwrap()
        else {
            panic!("task must not commit")
        };
        assert_eq!(fields["task"], "t2");
        assert_eq!(fields["session"], "");
        ui.render(&target("p2", "t2"), "message", scope).unwrap();
        ui.next_target(&stage);
        let Response::Action { name, fields, .. } =
            ui.command("/target session 0", "message", scope).unwrap()
        else {
            panic!("final selection must commit")
        };
        assert_eq!(name, "save_target_btn");
        assert_eq!(fields["project"], "p2");
        assert_eq!(fields["task"], "t2");
        assert_eq!(fields["session"], "");
    }

    #[test]
    fn unrelated_message_or_scope_change_invalidates_numeric_choices() {
        let mut ui = Ui::default();
        ui.render(&target("p1", "t1"), "message", "first").unwrap();
        ui.command("/target task", "message", "first").unwrap();
        assert!(matches!(
            ui.command("do something else", "message", "first").unwrap(),
            Response::Pass
        ));
        assert!(ui.command("/target task 1", "message", "first").is_err());
        ui.render(&target("p1", "t1"), "message", "first").unwrap();
        ui.command("/target task", "message", "first").unwrap();
        assert!(ui.command("/target task 1", "message", "second").is_err());
        // Reopening the root does not make an old numeric selection valid.
        ui.render(&target("p1", "t1"), "message", "second").unwrap();
        assert!(ui.command("/target task 1", "message", "second").is_err());
    }

    #[test]
    fn config_uses_advertised_options_and_only_submits_selected_field() {
        let mut ui = Ui::default();
        ui.render(
            &CardSpec::Config(Box::new(ConfigCard {
                selectors: vec![ConfigSelectorOption {
                    name: "opt_0".into(),
                    label: "Model".into(),
                    current: Some("old".into()),
                    options: vec![("old".into(), "Old".into()), ("new".into(), "New".into())],
                }],
            })),
            "message",
            "scope",
        )
        .unwrap();
        assert!(ui.command("/config model 2", "message", "scope").is_err());
        ui.command("/config model", "message", "scope").unwrap();
        let Response::Action { name, fields, .. } =
            ui.command("/config model 2", "message", "scope").unwrap()
        else {
            panic!()
        };
        assert_eq!(name, "save_config_btn");
        assert_eq!(fields, HashMap::from([("opt_0".into(), "new".into())]));
    }

    #[test]
    fn permissions_are_explicit_bound_and_single_use() {
        let mut ui = Ui::default();
        ui.render(
            &CardSpec::Permission(PermissionCard {
                request_id: "P7".into(),
                description: "Run command?".into(),
                options: vec![PermissionCardOption {
                    id: "allow".into(),
                    label: "Allow".into(),
                    kind: "allow_once".into(),
                }],
            }),
            "original",
            "scope",
        )
        .unwrap();
        assert!(ui.command("/respond P7 9", "reply", "scope").is_err());
        let Response::Action {
            name,
            fields,
            source,
        } = ui.command("/respond P7 1", "reply", "scope").unwrap()
        else {
            panic!()
        };
        assert_eq!(source, "original");
        assert_eq!(fields["option_id"], "allow");
        ui.action_completed(&name, &fields);
        assert!(ui.command("/respond P7 1", "reply", "scope").is_err());
    }

    #[test]
    fn notice_is_rendered_without_serializing_a_tagged_string_variant() {
        assert_eq!(
            Ui::default()
                .render(&CardSpec::Notice("Saved".into()), "message", "scope")
                .unwrap(),
            "Saved"
        );
    }

    #[test]
    fn form_answers_keep_text_spacing_use_core_multiselect_format_and_fresh_reply_context() {
        let mut ui = Ui::default();
        let definition = serde_json::from_value(serde_json::json!({
            "title": "Survey", "questions": [
                {"type": "multi_choice", "id": "regions", "title": "Regions", "options": [
                    {"id": "a", "label": "A"}, {"id": "b", "label": "B"}
                ]},
                {"type": "textarea", "id": "notes", "title": "Notes"}
            ]
        }))
        .unwrap();
        let spec = CardSpec::AskForm(crate::connect::commands::AskFormCard {
            form_id: "F1".into(),
            definition,
        });
        ui.render(&spec, "original", "scope").unwrap();
        ui.command("/answer F1 regions 1,2", "first", "scope")
            .unwrap();
        ui.command(
            "/answer  F1 notes first  line\nsecond line",
            "second",
            "scope",
        )
        .unwrap();
        // A validation retry must retain previously entered answers.
        ui.render(&spec, "original", "scope").unwrap();
        let Response::Action {
            name,
            fields,
            source,
        } = ui.command("/submit F1", "latest", "scope").unwrap()
        else {
            panic!()
        };
        assert_eq!(name, "ask_form_submit:F1");
        assert_eq!(fields["regions"], "a,b");
        assert_eq!(fields["notes"], "first  line\nsecond line");
        assert_eq!(source, "latest");
        ui.action_completed(&name, &fields);
        assert!(ui.command("/submit F1", "again", "scope").is_err());
    }
}
